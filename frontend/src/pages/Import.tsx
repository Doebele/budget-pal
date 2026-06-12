import { useState, useRef, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { importsApi, accountsApi, categoriesApi } from "@/lib/api";
import { Check, CheckCircle, Clock, Database, Eye, MapPin, NavArrowDown, NavArrowUp, Page, Settings, Table, Trash, Upload, WarningCircle, WarningTriangle, Xmark } from "@/lib/icons";
import { format } from "date-fns";
import { de } from "date-fns/locale";
import { clsx } from "clsx";
import { formatCHF, getFrequencyStyle, getFrequencyBadgeStyle, PERIODICITY_LABELS } from "@/lib/theme";

const BANKS = [
  { value: "ubs", label: "UBS" },
  { value: "n26", label: "N26" },
  { value: "revolut", label: "Revolut" },
  { value: "comdirect", label: "comdirect" },
];

interface ColumnMapping {
  date_col: string;
  description_col: string;
  amount_col?: string;
  debit_col?: string;
  credit_col?: string;
  balance_col?: string;
}

interface PreviewRow {
  row_index: number;
  date: string | null;
  description: string | null;
  amount: number | null;
  raw_data: Record<string, string>;
  parsed: boolean;
  errors: string[];
  currency: string;
}

interface PreviewData {
  bank: string;
  detected_columns: Record<string, string>;
  column_mapping: ColumnMapping | null;
  rows: PreviewRow[];
  total_rows: number;
  parsed_rows: number;
  error_rows: number;
  sample_raw: Record<string, string>[];
}

type PdfDuplicateKind = "none" | "database" | "pdf";
type PdfMergeAction = "import" | "skip" | "overwrite" | "keep_existing" | "delete_both";

interface PdfPreviewRow {
  id: string;
  original_date: string;
  sign: string;
  amount: number;
  description: string;
  currency: string;
  category?: string;
  account_id?: number;
  is_duplicate: boolean;
  parsed: boolean;
  errors: string[];
  duplicate_kind: PdfDuplicateKind;
  existing_transaction_id?: number | null;
  duplicate_of_row_id?: string | null;
  merge_action: PdfMergeAction;
  is_recurring: boolean;
  periodicity?: string | null;
}

/** Normalise description for smart category grouping (strip digits, keep first 5 words ≥3 chars). */
function descGroupKey(desc: string): string {
  return desc
    .toLowerCase()
    .replace(/[\d'.,]+/g, "")
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .slice(0, 5)
    .join(" ");
}

/** Extra import-specific categories always shown in the dropdown. */
const EXTRA_IMPORT_CATEGORIES = ["Einzahlungen", "Gebühren", "Kontoübertrag"];

interface PdfPreviewData {
  bank: string;
  filename: string;
  rows: PdfPreviewRow[];
  total_rows: number;
  parsed_rows: number;
  error_rows: number;
}

interface CategoryRow {
  id: number;
  name: string;
  slug: string;
  is_system: boolean;
}

export default function Import() {
  const queryClient = useQueryClient();
  const csvRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLInputElement>(null);
  const [selectedAccount, setSelectedAccount] = useState("");
  const [selectedBank, setSelectedBank] = useState("");
  const [importResult, setImportResult] = useState<{
    rows_imported: number;
    rows_skipped: number;
    bank: string;
    preview: Array<{ date: string; description: string; amount: number; category?: string; is_duplicate: boolean }>;
  } | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [importToDelete, setImportToDelete] = useState<number | null>(null);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [showColumnMapping, setShowColumnMapping] = useState(false);
  const [manualMapping, setManualMapping] = useState<Partial<ColumnMapping>>({});
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [pdfPreview, setPdfPreview] = useState<PdfPreviewData | null>(null);
  const [pdfFileName, setPdfFileName] = useState<string>("");
  /** Row IDs where the user has manually picked a category — excluded from smart auto-apply. */
  const manuallyChangedCategories = useRef<Set<string>>(new Set());

  const { data: accounts } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => accountsApi.list().then((r) => r.data),
  });

  const { data: history } = useQuery({
    queryKey: ["import-history"],
    queryFn: () => importsApi.history().then((r) => r.data),
  });

  const { data: categoriesList } = useQuery({
    queryKey: ["categories"],
    queryFn: () => categoriesApi.list().then((r) => r.data as CategoryRow[]),
  });

  const pdfCategoryOptions = useMemo(() => {
    const names = new Set<string>(EXTRA_IMPORT_CATEGORIES);
    (categoriesList ?? []).forEach((c) => names.add(c.name));
    pdfPreview?.rows.forEach((r) => {
      if (r.category) names.add(r.category);
    });
    return Array.from(names).sort((a, b) => a.localeCompare(b, "de"));
  }, [categoriesList, pdfPreview?.rows]);

  /**
   * Smart category change handler.
   * - Marks the changed row as manually overridden.
   * - Auto-applies the same category to all other rows that share the same
   *   normalised description group key AND haven't been manually overridden.
   */
  const handleCategoryChange = useCallback(
    (rowId: string, rowIdx: number, newCat: string) => {
      manuallyChangedCategories.current.add(rowId);
      setPdfPreview((prev) => {
        if (!prev) return prev;
        const currentKey = descGroupKey(prev.rows[rowIdx].description);
        const next = prev.rows.map((r, i) => {
          if (i === rowIdx) return { ...r, category: newCat || undefined };
          if (!manuallyChangedCategories.current.has(r.id) && descGroupKey(r.description) === currentKey) {
            return { ...r, category: newCat || undefined };
          }
          return r;
        });
        return { ...prev, rows: next };
      });
    },
    [],
  );

  const csvMutation = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("account_id", selectedAccount);
      if (selectedBank) fd.append("bank", selectedBank);
      return importsApi.uploadCsv(fd).then((r) => r.data);
    },
    onSuccess: (data) => {
      setImportResult(data);
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      queryClient.invalidateQueries({ queryKey: ["import-history"] });
    },
  });

  const pdfPreviewMutation = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("account_id", selectedAccount);
      if (selectedBank) fd.append("bank", selectedBank);
      return importsApi.previewPdf(fd).then((r) => r.data as PdfPreviewData);
    },
    onSuccess: (data) => {
      manuallyChangedCategories.current = new Set();
      const rows: PdfPreviewRow[] = (data.rows ?? []).map((r) => ({
        ...r,
        duplicate_kind: (r as PdfPreviewRow).duplicate_kind ?? "none",
        merge_action: ((r as PdfPreviewRow).merge_action ?? "import") as PdfMergeAction,
        existing_transaction_id: (r as PdfPreviewRow).existing_transaction_id ?? undefined,
        duplicate_of_row_id: (r as PdfPreviewRow).duplicate_of_row_id ?? undefined,
        is_recurring: (r as PdfPreviewRow).is_recurring ?? false,
        periodicity: (r as PdfPreviewRow).periodicity ?? null,
      }));
      setPdfPreview({ ...data, rows });
      setPdfFileName(data.filename);
    },
  });

  const pdfConfirmMutation = useMutation({
    mutationFn: () =>
      importsApi.confirmPdf({
        account_id: Number(selectedAccount),
        bank: selectedBank || (pdfPreview?.bank ?? "ubs"),
        filename: pdfFileName || "upload.pdf",
        rows: pdfPreview?.rows ?? [],
      }).then((r) => r.data),
    onSuccess: (data) => {
      setPdfPreview(null);
      setImportResult(data);
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      queryClient.invalidateQueries({ queryKey: ["import-history"] });
    },
  });

  // Delete import mutation
  const deleteMutation = useMutation({
    mutationFn: (importId: number) => {
      return importsApi.delete(importId, true).then((r) => r.data);
    },
    onSuccess: (data) => {
      setShowDeleteConfirm(false);
      setImportToDelete(null);
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      queryClient.invalidateQueries({ queryKey: ["import-history"] });
      alert(`Import gelöscht: ${data.deleted_transactions} Transaktionen wurden entfernt.`);
    },
    onError: (error) => {
      console.error("Delete error:", error);
      alert(`Fehler beim Löschen des Imports: ${error instanceof Error ? error.message : "Unbekannter Fehler"}`);
    },
  });

  // Preview mutation
  const previewMutation = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      if (selectedBank) fd.append("bank", selectedBank);
      if (selectedAccount) fd.append("account_id", selectedAccount);
      return importsApi.previewUpload(fd).then((r) => r.data);
    },
    onSuccess: (data: PreviewData) => {
      setPreviewData(data);
      // Initialize manual mapping with detected columns
      if (data.detected_columns) {
        setManualMapping({
          date_col: data.detected_columns.date || "",
          description_col: data.detected_columns.description || "",
          amount_col: data.detected_columns.amount || "",
          debit_col: data.detected_columns.debit || "",
          credit_col: data.detected_columns.credit || "",
          balance_col: data.detected_columns.balance || "",
        });
      }
    },
    onError: (error) => {
      alert(`Fehler bei der Vorschau: ${error instanceof Error ? error.message : "Unbekannter Fehler"}`);
    },
  });

  // Get the last completed import
  const lastImport = history?.[0];

  const handleCsvPreview = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!selectedAccount) {
      alert("Bitte zuerst ein Ziel-Konto auswählen.");
      return;
    }

    setSelectedFile(file);
    previewMutation.mutate(file);
  };

  const handleCsvImport = () => {
    if (!selectedFile || !selectedAccount) return;
    csvMutation.mutate(selectedFile);
    setPreviewData(null);
    setSelectedFile(null);
  };

  const handlePdfChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!selectedAccount) {
      alert("Bitte zuerst ein Ziel-Konto auswählen.");
      return;
    }
    pdfPreviewMutation.mutate(file);
  };

  const isLoading =
    csvMutation.isPending ||
    previewMutation.isPending ||
    pdfPreviewMutation.isPending ||
    pdfConfirmMutation.isPending;

  // Get all available columns from sample data
  const availableColumns = previewData?.sample_raw?.[0]
    ? Object.keys(previewData.sample_raw[0])
    : [];

  // Apply manual mapping and re-parse preview
  const applyMapping = () => {
    if (!previewData || !selectedFile) return;

    // For now, just re-trigger preview with updated logic
    // In a full implementation, we'd re-parse client-side or send mapping to backend
    previewMutation.mutate(selectedFile);
  };

  // Get example value for a column from sample data
  const getExampleValue = (columnName: string): string => {
    if (!previewData?.sample_raw?.[0]) return "-";
    const value = previewData.sample_raw[0][columnName];
    return value && value.length > 30 ? value.substring(0, 30) + "..." : (value || "-");
  };

  // Determine column type based on detected mapping
  const getColumnType = (columnName: string): { type: string; label: string; icon: string } => {
    if (manualMapping.date_col === columnName) return { type: "date", label: "Datum", icon: "📅" };
    if (manualMapping.description_col === columnName) return { type: "description", label: "Beschreibung", icon: "📝" };
    if (manualMapping.amount_col === columnName) return { type: "amount", label: "Betrag", icon: "💰" };
    if (manualMapping.debit_col === columnName) return { type: "debit", label: "Belastung", icon: "➖" };
    if (manualMapping.credit_col === columnName) return { type: "credit", label: "Gutschrift", icon: "➕" };
    if (manualMapping.balance_col === columnName) return { type: "balance", label: "Saldo", icon: "📊" };
    return { type: "unassigned", label: "Nicht zugewiesen", icon: "❓" };
  };

  // Check for mapping issues
  const mappingWarnings = useMemo(() => {
    const warnings: string[] = [];
    if (!manualMapping.date_col) warnings.push("Keine Datumsspalte zugewiesen - erforderlich für Import");
    if (!manualMapping.description_col) warnings.push("Keine Beschreibungsspalte zugewiesen");
    if (!manualMapping.amount_col && !manualMapping.debit_col && !manualMapping.credit_col) {
      warnings.push("Keine Betragsspalte zugewiesen - erforderlich für Import");
    }
    if (manualMapping.amount_col && (manualMapping.debit_col || manualMapping.credit_col)) {
      warnings.push("Betrag UND Belastung/Gutschrift gewählt - es wird nur eine Option verwendet");
    }
    return warnings;
  }, [manualMapping]);

  // Get mapped columns count
  const mappedColumnsCount = useMemo(() => {
    return Object.values(manualMapping).filter(Boolean).length;
  }, [manualMapping]);

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-display text-text-primary">Import</h1>
        <p className="text-text-tertiary text-sm mt-0.5">CSV und PDF Kontoauszüge importieren</p>
      </div>

      {/* Config */}
      <div className="card">
        <h2 className="text-text-primary font-semibold text-sm mb-4">Import-Einstellungen</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Ziel-Konto</label>
            <select className="input" value={selectedAccount} onChange={(e) => setSelectedAccount(e.target.value)}>
              <option value="">Konto wählen...</option>
              {(accounts || []).map((a: { id: number; name: string; bank: string }) => (
                <option key={a.id} value={String(a.id)}>{a.name} ({a.bank})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Bank (optional, auto-erkannt)</label>
            <select className="input" value={selectedBank} onChange={(e) => setSelectedBank(e.target.value)}>
              <option value="">Auto-Erkennung</option>
              {BANKS.map((b) => (
                <option key={b.value} value={b.value}>{b.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Upload areas */}
      <div className="grid grid-cols-2 gap-4">
        <div
          className={clsx(
            "card border-2 border-dashed cursor-pointer hover:border-accent/50 transition-colors text-center py-10",
            !selectedAccount && "opacity-50 cursor-not-allowed"
          )}
          onClick={() => selectedAccount && csvRef.current?.click()}
        >
          <Upload className="w-8 h-8 text-text-tertiary mx-auto mb-3" />
          <p className="text-text-primary font-medium text-sm">CSV importieren</p>
          <p className="text-text-tertiary text-xs mt-1">Zuerst Vorschau, dann Import</p>
          <input ref={csvRef} type="file" accept=".csv" className="hidden" onChange={handleCsvPreview} />
        </div>

        <div
          className={clsx(
            "card border-2 border-dashed cursor-pointer hover:border-accent/50 transition-colors text-center py-10",
            !selectedAccount && "opacity-50 cursor-not-allowed"
          )}
          onClick={() => selectedAccount && pdfRef.current?.click()}
        >
          <Page className="w-8 h-8 text-text-tertiary mx-auto mb-3" />
          <p className="text-text-primary font-medium text-sm">PDF importieren</p>
          <p className="text-text-tertiary text-xs mt-1">OCR-Extraktion mit interaktiver Vorschau</p>
          <input ref={pdfRef} type="file" accept=".pdf" className="hidden" onChange={handlePdfChange} />
        </div>
      </div>

      {/* Loading */}
      {isLoading && !previewData && (
        <div className="card flex items-center gap-4">
          <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
          <div>
            <p className="text-text-primary text-sm font-medium">
              {previewMutation.isPending || pdfPreviewMutation.isPending
                ? "Vorschau wird erstellt..."
                : "Import läuft..."}
            </p>
            <p className="text-text-tertiary text-xs">
              {previewMutation.isPending
                ? "CSV wird analysiert"
                : pdfPreviewMutation.isPending
                  ? "PDF wird per OCR extrahiert"
                  : "KI-Kategorisierung wird durchgeführt"}
            </p>
          </div>
        </div>
      )}

      {/* PDF Preview Modal */}
      {pdfPreview && (() => {
        const isRecurring = (r: PdfPreviewRow) => r.is_recurring;
        const recurringCount = pdfPreview.rows.filter((r) => r.is_recurring).length;
        const hasDuplicates = pdfPreview.rows.some((r) => r.duplicate_kind !== "none");

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 sm:p-4">
            <div className="w-full max-w-[96vw] max-h-[95vh] overflow-hidden rounded-xl border border-border bg-bg-surface shadow-2xl flex flex-col">

              {/* ── Header ── */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
                <div>
                  <h3 className="text-text-primary font-semibold">PDF Vorschau</h3>
                  <p className="text-text-tertiary text-xs">
                    {pdfPreview.filename} · {pdfPreview.total_rows} Zeilen · {pdfPreview.parsed_rows} erkannt
                  </p>
                </div>
                <button onClick={() => setPdfPreview(null)} className="text-text-tertiary hover:text-text-primary" type="button">
                  <Xmark className="w-5 h-5" />
                </button>
              </div>

              {/* ── Stats row ── */}
              <div className="px-5 pt-4 pb-3 flex-shrink-0">
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
                  <div className="rounded-lg bg-bg-surface2 px-3 py-2 text-text-secondary">
                    Bank: <span className="text-text-primary font-semibold">{pdfPreview.bank.toUpperCase()}</span>
                  </div>
                  <div className="rounded-lg bg-green-900/30 border border-green-800/40 px-3 py-2 text-text-secondary">
                    Erkannt: <span className="text-green-300 font-semibold">{pdfPreview.parsed_rows}</span>
                  </div>
                  <div className="rounded-lg bg-bg-surface2 px-3 py-2 text-text-secondary">
                    Wiederkehrend: <span className="text-violet-300 font-semibold">{recurringCount > 0 ? `${recurringCount} Zahlungen` : "–"}</span>
                  </div>
                  <div className="rounded-lg bg-bg-surface2 px-3 py-2 text-text-secondary">
                    Duplikate: <span className="text-amber-300 font-semibold">{pdfPreview.rows.filter((r) => r.duplicate_kind !== "none").length}</span>
                  </div>
                  <div className="rounded-lg bg-bg-surface2 px-3 py-2 text-text-secondary">
                    Fehler: <span className={pdfPreview.error_rows > 0 ? "text-red-300 font-semibold" : "text-text-tertiary"}>{pdfPreview.error_rows}</span>
                  </div>
                </div>
                {hasDuplicates && (
                  <p className="text-text-disabled text-[11px] mt-2">
                    Konto-Duplikate: überschreiben, behalten oder löschen. PDF-Duplikate: importieren oder überspringen.
                  </p>
                )}
              </div>

              {/* ── Table ── */}
              <div className="flex-1 overflow-auto px-5 pb-2">
                <table className="w-full text-xs border-collapse">
                  <thead className="sticky top-0 z-10 bg-bg-surface2">
                    <tr>
                      {/* Status badges column */}
                      <th className="text-left px-2 py-2.5 text-text-tertiary font-medium w-[90px] whitespace-nowrap">Status</th>
                      {/* Date */}
                      <th className="text-left px-2 py-2.5 text-text-tertiary font-medium w-[108px]">Datum</th>
                      {/* Description — gets max remaining space */}
                      <th className="text-left px-2 py-2.5 text-text-tertiary font-medium min-w-[220px]">Beschreibung</th>
                      {/* Amount */}
                      <th className="text-right px-2 py-2.5 text-text-tertiary font-medium w-[110px]">Betrag (CHF)</th>
                      {/* AI Category + Frequency */}
                      <th className="text-left px-2 py-2.5 text-text-tertiary font-medium w-[310px]">Kategorie / Frequenz</th>
                      {/* Duplicate action — only shown if there are duplicates */}
                      {hasDuplicates && (
                        <th className="text-left px-2 py-2.5 text-text-tertiary font-medium w-[160px]">Duplikat-Aktion</th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {pdfPreview.rows.map((row, idx) => {
                      const recurring = isRecurring(row);
                      const isExpense = row.amount < 0;
                      return (
                        <tr
                          key={row.id}
                          className={clsx(
                            "transition-colors hover:bg-bg-surface2/40",
                            row.is_duplicate && "bg-amber-950/20",
                            recurring && "bg-violet-950/10",
                            !row.parsed && "opacity-50"
                          )}
                        >
                          {/* ── Status badges ── */}
                          <td className="px-2 py-2 align-middle">
                            <div className="flex flex-col gap-0.5">
                              {row.duplicate_kind === "database" && (
                                <span className="inline-flex rounded px-1.5 py-0.5 bg-amber-900/60 text-amber-200 text-[10px] font-medium leading-tight">
                                  Konto
                                </span>
                              )}
                              {row.duplicate_kind === "pdf" && (
                                <span className="inline-flex rounded px-1.5 py-0.5 bg-bg-elevated text-text-secondary text-[10px] font-medium leading-tight">
                                  PDF-Dup
                                </span>
                              )}
                              {recurring && (
                                <span className={clsx("inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight", getFrequencyBadgeStyle(row.periodicity))} title={row.periodicity ? PERIODICITY_LABELS[row.periodicity] : "Wiederkehrend"}>
                                  ↻ {row.periodicity ? PERIODICITY_LABELS[row.periodicity] : "Abo"}
                                </span>
                              )}
                              {row.duplicate_kind === "none" && !recurring && (
                                <span className="text-text-disabled text-[10px]">—</span>
                              )}
                            </div>
                          </td>

                          {/* ── Date ── */}
                          <td className="px-2 py-2 align-middle">
                            <input
                              value={row.original_date}
                              onChange={(e) => setPdfPreview((prev) => {
                                if (!prev) return prev;
                                const next = [...prev.rows];
                                next[idx] = { ...next[idx], original_date: e.target.value };
                                return { ...prev, rows: next };
                              })}
                              className="bg-bg-surface2 border border-border rounded px-2 py-1 text-text-primary w-[100px] text-xs"
                            />
                          </td>

                          {/* ── Description (wide) ── */}
                          <td className="px-2 py-2 align-middle">
                            <input
                              value={row.description}
                              onChange={(e) => setPdfPreview((prev) => {
                                if (!prev) return prev;
                                const next = [...prev.rows];
                                next[idx] = { ...next[idx], description: e.target.value };
                                return { ...prev, rows: next };
                              })}
                              className="bg-bg-surface2 border border-border rounded px-2 py-1 text-text-primary w-full min-w-[200px] text-xs"
                              title={row.description}
                            />
                          </td>

                          {/* ── Amount (colored) ── */}
                          <td className="px-2 py-2 align-middle">
                            <input
                              type="number"
                              step="0.01"
                              value={row.amount}
                              onChange={(e) => setPdfPreview((prev) => {
                                if (!prev) return prev;
                                const next = [...prev.rows];
                                next[idx] = { ...next[idx], amount: Number(e.target.value) };
                                return { ...prev, rows: next };
                              })}
                              className={clsx(
                                "bg-bg-surface2 border rounded px-2 py-1 text-right w-full font-mono font-semibold text-xs",
                                isExpense
                                  ? "border-red-800/50 text-red-300"
                                  : "border-green-800/50 text-green-300"
                              )}
                            />
                          </td>

                          {/* ── Kategorie + Frequenz (side-by-side) ── */}
                          <td className="px-2 py-2 align-middle">
                            <div className="flex flex-row gap-2 items-center">
                              {/* Category override — smart: auto-applies to same-description rows */}
                              <select
                                value={row.category ?? ""}
                                onChange={(e) => handleCategoryChange(row.id, idx, e.target.value)}
                                className="flex-1 min-w-0 bg-bg-surface2 border border-border rounded px-1.5 py-1 text-text-secondary text-[11px]"
                              >
                                <option value="">↩ Zurücksetzen</option>
                                {pdfCategoryOptions.map((name) => (
                                  <option key={name} value={name}>{name}</option>
                                ))}
                              </select>
                              {/* Frequency select — shown for all rows, color-coded by value */}
                              <select
                                value={row.periodicity ?? ""}
                                onChange={(e) =>
                                  setPdfPreview((prev) => {
                                    if (!prev) return prev;
                                    const next = [...prev.rows];
                                    next[idx] = { ...next[idx], periodicity: e.target.value || null, is_recurring: !!e.target.value };
                                    return { ...prev, rows: next };
                                  })
                                }
                                className={clsx(
                                  "w-[130px] flex-shrink-0 rounded border px-1.5 py-1 text-[11px] focus:outline-none",
                                  getFrequencyStyle(row.periodicity)
                                )}
                              >
                                <option value="">Einmalig</option>
                                <option value="monthly">Monatlich</option>
                                <option value="quarterly">Vierteljährlich</option>
                                <option value="halfyearly">Halbjährlich</option>
                                <option value="yearly">Jährlich</option>
                              </select>
                            </div>
                          </td>

                          {/* ── Duplicate action (only rendered when duplicates exist) ── */}
                          {hasDuplicates && (
                            <td className="px-2 py-2 align-middle">
                              {row.duplicate_kind === "database" ? (
                                <select
                                  className="bg-bg-surface2 border border-border rounded px-1.5 py-1 text-text-primary text-[11px] w-full"
                                  value={row.merge_action}
                                  onChange={(e) =>
                                    setPdfPreview((prev) => {
                                      if (!prev) return prev;
                                      const next = [...prev.rows];
                                      next[idx] = { ...next[idx], merge_action: e.target.value as PdfMergeAction };
                                      return { ...prev, rows: next };
                                    })
                                  }
                                >
                                  <option value="keep_existing">Behalten</option>
                                  <option value="overwrite">Überschreiben</option>
                                  <option value="delete_both">Löschen</option>
                                  <option value="import">Neu importieren</option>
                                </select>
                              ) : row.duplicate_kind === "pdf" ? (
                                <select
                                  className="bg-bg-surface2 border border-border rounded px-1.5 py-1 text-text-primary text-[11px] w-full"
                                  value={row.merge_action === "import" ? "import" : "skip"}
                                  onChange={(e) =>
                                    setPdfPreview((prev) => {
                                      if (!prev) return prev;
                                      const next = [...prev.rows];
                                      next[idx] = { ...next[idx], merge_action: e.target.value as PdfMergeAction };
                                      return { ...prev, rows: next };
                                    })
                                  }
                                >
                                  <option value="skip">Überspringen</option>
                                  <option value="import">Importieren</option>
                                </select>
                              ) : (
                                <span className="text-text-disabled text-[10px]">Import</span>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* ── Footer ── */}
              <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-border flex-shrink-0">
                <p className="text-text-disabled text-xs">
                  {pdfPreview.rows.filter((r) => r.merge_action !== "skip" && r.merge_action !== "keep_existing" && r.merge_action !== "delete_both").length} Transaktionen werden importiert
                </p>
                <div className="flex gap-3">
                  <button onClick={() => setPdfPreview(null)} className="btn-secondary text-sm">Abbrechen</button>
                  <button
                    onClick={() => pdfConfirmMutation.mutate()}
                    disabled={pdfConfirmMutation.isPending || pdfPreview.rows.length === 0}
                    className="btn-primary text-sm"
                  >
                    {pdfConfirmMutation.isPending ? "Importiere…" : "Transaktionen importieren"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Preview Section */}
      {previewData && (
        <div className="card space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-accent/20 flex items-center justify-center">
                <Eye className="w-5 h-5 text-accent" />
              </div>
              <div>
                <p className="text-text-primary font-semibold text-sm">Import-Vorschau: {previewData.total_rows} Zeilen</p>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-text-tertiary">
                    Bank: <span className="text-text-primary">{previewData.bank.toUpperCase()}</span>
                  </span>
                  <span className="text-text-disabled">|</span>
                  <span className="text-gain flex items-center gap-1">
                    <Check className="w-3 h-3" />
                    {previewData.parsed_rows} erfolgreich
                  </span>
                  {previewData.error_rows > 0 && (
                    <>
                      <span className="text-text-disabled">|</span>
                      <span className="text-red-400 flex items-center gap-1">
                        <WarningTriangle className="w-3 h-3" />
                        {previewData.error_rows} Fehler
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setShowColumnMapping(!showColumnMapping)}
                className={clsx(
                  "px-3 py-2 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors",
                  showColumnMapping
                    ? "bg-accent/20 text-accent border border-accent/30"
                    : "bg-bg-surface2 text-text-secondary hover:bg-bg-elevated border border-border"
                )}
              >
                <Table className="w-3.5 h-3.5" />
                Feldzuweisung
                {showColumnMapping ? <NavArrowUp className="w-3.5 h-3.5" /> : <NavArrowDown className="w-3.5 h-3.5" />}
              </button>
              <button
                onClick={() => {
                  setPreviewData(null);
                  setSelectedFile(null);
                  setShowColumnMapping(false);
                }}
                className="px-3 py-2 rounded-lg bg-bg-surface2 text-text-tertiary hover:text-text-primary hover:bg-bg-elevated border border-border transition-colors"
              >
                <Xmark className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Enhanced Column Mapping Panel */}
          {showColumnMapping && availableColumns.length > 0 && (
            <div className="bg-bg-surface2/50 rounded-lg border border-border overflow-hidden">
              {/* Header */}
              <div className="bg-bg-surface2 px-4 py-3 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Table className="w-4 h-4 text-accent" />
                  <span className="text-text-primary font-medium text-sm">CSV-Feldzuweisung</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-tertiary">
                    {mappedColumnsCount} von {availableColumns.length} Spalten zugewiesen
                  </span>
                  {mappingWarnings.length === 0 && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gain/20 text-gain text-xs">
                      <Check className="w-3 h-3" />
                      OK
                    </span>
                  )}
                </div>
              </div>

              <div className="p-4 space-y-4">
                {/* CSV Columns Overview Table */}
                <div className="overflow-auto max-h-48 border border-border rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="bg-bg-elevated text-text-secondary">
                      <tr>
                        <th className="text-left px-3 py-2 text-xs font-medium">CSV Spalte</th>
                        <th className="text-left px-3 py-2 text-xs font-medium">Ziel-Feld</th>
                        <th className="text-left px-3 py-2 text-xs font-medium">Beispielwert</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {availableColumns.map((col) => {
                        const { type, label, icon } = getColumnType(col);
                        const isMapped = type !== "unassigned";
                        return (
                          <tr key={col} className={clsx(
                            "hover:bg-bg-elevated/30 transition-colors",
                            isMapped && "bg-accent/5"
                          )}>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-2">
                                <span className="text-lg">{icon}</span>
                                <span className={clsx(
                                  "font-medium",
                                  isMapped ? "text-text-primary" : "text-text-tertiary"
                                )}>
                                  {col}
                                </span>
                              </div>
                            </td>
                            <td className="px-3 py-2">
                              {isMapped ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded bg-accent/20 text-accent text-xs">
                                  <MapPin className="w-3 h-3 mr-1" />
                                  {label}
                                </span>
                              ) : (
                                <span className="text-text-disabled text-xs italic">Nicht zugewiesen</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-text-tertiary text-xs font-mono truncate max-w-[150px]">
                              {getExampleValue(col)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Manual Field Assignment */}
                <div className="border-t border-border pt-4">
                  <p className="text-text-secondary text-xs font-medium mb-3 flex items-center gap-2">
                    <Database className="w-3.5 h-3.5 text-text-tertiary" />
                    Manuelle Feld-Zuweisung
                  </p>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    <div>
                      <label className="label text-xs flex items-center gap-1">
                        <span className="text-red-400">*</span> Datum
                      </label>
                      <select
                        className="input text-xs"
                        value={manualMapping.date_col || ""}
                        onChange={(e) => setManualMapping({ ...manualMapping, date_col: e.target.value })}
                      >
                        <option value="">-- Wählen --</option>
                        {availableColumns.map((col) => (
                          <option key={col} value={col}>{col}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="label text-xs flex items-center gap-1">
                        <span className="text-red-400">*</span> Beschreibung
                      </label>
                      <select
                        className="input text-xs"
                        value={manualMapping.description_col || ""}
                        onChange={(e) => setManualMapping({ ...manualMapping, description_col: e.target.value })}
                      >
                        <option value="">-- Wählen --</option>
                        {availableColumns.map((col) => (
                          <option key={col} value={col}>{col}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="label text-xs">Betrag (kombiniert)</label>
                      <select
                        className="input text-xs"
                        value={manualMapping.amount_col || ""}
                        onChange={(e) => setManualMapping({ ...manualMapping, amount_col: e.target.value })}
                      >
                        <option value="">-- Wählen --</option>
                        {availableColumns.map((col) => (
                          <option key={col} value={col}>{col}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="label text-xs">Belastung (Soll)</label>
                      <select
                        className="input text-xs"
                        value={manualMapping.debit_col || ""}
                        onChange={(e) => setManualMapping({ ...manualMapping, debit_col: e.target.value })}
                      >
                        <option value="">-- Wählen --</option>
                        {availableColumns.map((col) => (
                          <option key={col} value={col}>{col}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="label text-xs">Gutschrift (Haben)</label>
                      <select
                        className="input text-xs"
                        value={manualMapping.credit_col || ""}
                        onChange={(e) => setManualMapping({ ...manualMapping, credit_col: e.target.value })}
                      >
                        <option value="">-- Wählen --</option>
                        {availableColumns.map((col) => (
                          <option key={col} value={col}>{col}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="label text-xs">Saldo (Balance)</label>
                      <select
                        className="input text-xs"
                        value={manualMapping.balance_col || ""}
                        onChange={(e) => setManualMapping({ ...manualMapping, balance_col: e.target.value })}
                      >
                        <option value="">-- Wählen --</option>
                        {availableColumns.map((col) => (
                          <option key={col} value={col}>{col}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                {/* Warnings */}
                {mappingWarnings.length > 0 && (
                  <div className="bg-red-900/30 border border-red-500/30 rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <WarningTriangle className="w-4 h-4 text-red-400" />
                      <span className="text-red-300 font-medium text-sm">Zuweisungs-Probleme</span>
                    </div>
                    <ul className="space-y-1">
                      {mappingWarnings.map((warn, idx) => (
                        <li key={idx} className="text-red-300/80 text-xs flex items-start gap-2">
                          <span className="text-red-400">•</span>
                          {warn}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Tips */}
                <div className="bg-bg-elevated/30 rounded p-3 text-xs text-text-tertiary">
                  <p className="flex items-start gap-2">
                    <span className="text-accent">💡</span>
                    <span>
                      <strong className="text-text-secondary">Tipp:</strong> Wähle "Belastung" und "Gutschrift" für separate Spalten,
                      oder "Betrag" für eine kombinierte Spalte mit +/- Vorzeichen. Felder mit <span className="text-red-400">*</span> sind erforderlich.
                    </span>
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Preview Table */}
          <div className="overflow-auto max-h-80 border border-border rounded-lg">
            <table className="w-full text-xs">
              <thead className="bg-bg-surface2 sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2 text-text-tertiary font-medium">#</th>
                  <th className="text-left px-3 py-2 text-text-tertiary font-medium">Datum</th>
                  <th className="text-left px-3 py-2 text-text-tertiary font-medium">Beschreibung</th>
                  <th className="text-right px-3 py-2 text-text-tertiary font-medium">Betrag</th>
                  <th className="text-center px-3 py-2 text-text-tertiary font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {previewData.rows.map((row) => (
                  <tr key={row.row_index} className={clsx(
                    "hover:bg-bg-surface2/30 transition-colors",
                    !row.parsed && "bg-red-500/5",
                    row.parsed && "bg-green-500/5"
                  )}>
                    <td className="px-3 py-2 text-text-disabled">{row.row_index + 1}</td>
                    <td className="px-3 py-2 text-text-primary font-mono text-xs">{row.date || "-"}</td>
                    <td className="px-3 py-2 text-text-primary max-w-xs truncate" title={row.description || ""}>
                      {row.description || "-"}
                    </td>
                    <td className={clsx(
                      "px-3 py-2 text-right font-mono font-medium",
                      row.amount === null ? "text-text-disabled" : row.amount >= 0 ? "text-gain" : "text-loss"
                    )}>
                      {row.amount !== null ? formatCHF(row.amount) : "-"}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {row.parsed ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gain/20 text-gain text-xs">
                          <Check className="w-3 h-3" />
                          OK
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 text-xs" title={row.errors.join(", ")}>
                          <WarningTriangle className="w-3 h-3" />
                          Fehler
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Raw Data Sample */}
          {previewData.sample_raw?.length > 0 && (
            <details className="text-xs">
              <summary className="text-text-tertiary cursor-pointer hover:text-text-secondary">
                Rohdaten (erste {previewData.sample_raw.length} Zeilen)
              </summary>
              <div className="mt-2 bg-bg-surface2/50 rounded p-2 overflow-auto max-h-40">
                <pre className="text-text-tertiary text-xs">
                  {JSON.stringify(previewData.sample_raw, null, 2)}
                </pre>
              </div>
            </details>
          )}

          {/* Import Button */}
          <div className="flex justify-end gap-3 pt-4 border-t border-border">
            <button
              onClick={() => {
                setPreviewData(null);
                setSelectedFile(null);
                setShowColumnMapping(false);
              }}
              className="px-4 py-2 rounded-lg bg-bg-elevated text-text-secondary hover:bg-bg-elevated transition-colors text-sm"
            >
              Abbrechen
            </button>
            <button
              onClick={handleCsvImport}
              disabled={previewData.parsed_rows === 0 || mappingWarnings.some(w => w.includes("erforderlich"))}
              className={clsx(
                "px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-all",
                previewData.parsed_rows > 0 && !mappingWarnings.some(w => w.includes("erforderlich"))
                  ? "bg-accent text-white hover:bg-accent-light"
                  : "bg-bg-elevated text-text-disabled cursor-not-allowed"
              )}
              title={mappingWarnings.find(w => w.includes("erforderlich")) || "Import durchführen"}
            >
              <CheckCircle className="w-4 h-4" />
              {previewData.parsed_rows} Transaktionen importieren
            </button>
          </div>
        </div>
      )}

      {/* Result */}
      {importResult && !isLoading && (
        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <CheckCircle className="w-5 h-5 text-gain" />
            <div>
              <p className="text-text-primary font-semibold text-sm">Import abgeschlossen</p>
              <p className="text-text-tertiary text-xs">
                {importResult.rows_imported} importiert · {importResult.rows_skipped} Duplikate übersprungen · Bank: {importResult.bank.toUpperCase()}
              </p>
            </div>
          </div>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {importResult.preview?.map((p, i) => (
              <div key={i} className={clsx("flex items-center justify-between py-1.5 px-2 rounded", p.is_duplicate ? "opacity-40" : "")}>
                <div>
                  <p className="text-text-primary text-xs">{p.description.slice(0, 50)}</p>
                  <p className="text-text-tertiary text-xs">{p.date} · {p.category || "?"}</p>
                </div>
                <span className={clsx("text-xs font-mono", p.amount >= 0 ? "text-gain" : "text-loss")}>
                  {formatCHF(p.amount)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* History */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-text-primary font-semibold text-sm">Import-Historie</h2>
          {/* Delete Last Import Button */}
          {lastImport && lastImport.status === "completed" && (
            <button
              onClick={() => {
                setImportToDelete(lastImport.id);
                setShowDeleteConfirm(true);
              }}
              className="text-text-tertiary hover:text-loss text-xs flex items-center gap-1 transition-colors"
              title="Letzten Import löschen"
            >
              <Trash className="w-3.5 h-3.5" />
              Letzten Import rückgängig machen
            </button>
          )}
        </div>
        <div className="space-y-2">
          {(history || []).slice(0, 10).map((log: {
            id: number; filename: string; bank?: string; rows_imported: number;
            rows_skipped: number; status: string; created_at: string; file_type: string;
          }) => (
            <div key={log.id} className="flex items-center gap-4 py-2">
              <div className={clsx("w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0",
                log.status === "completed" ? "bg-gain/15" : log.status === "failed" ? "bg-loss/15" : "bg-warning/15"
              )}>
                {log.status === "completed" ? <CheckCircle className="w-3.5 h-3.5 text-gain" />
                  : log.status === "failed" ? <WarningCircle className="w-3.5 h-3.5 text-loss" />
                  : <Clock className="w-3.5 h-3.5 text-warning" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-text-primary text-xs font-medium truncate">{log.filename}</p>
                <p className="text-text-tertiary text-xs">
                  {log.bank?.toUpperCase()} · {log.rows_imported} Einträge · {format(new Date(log.created_at), "dd.MM.yyyy HH:mm")}
                </p>
              </div>
            </div>
          ))}
          {(!history || history.length === 0) && (
            <p className="text-text-tertiary text-sm text-center py-6">Noch keine Importe</p>
          )}
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && importToDelete && lastImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setShowDeleteConfirm(false)}
          />
          <div className="relative w-full max-w-md bg-bg-surface2 rounded-lg border border-border p-6 shadow-xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center">
                <Trash className="w-5 h-5 text-red-500" />
              </div>
              <h3 className="text-lg font-semibold text-text-primary">
                Import komplett löschen?
              </h3>
            </div>
            <p className="text-text-secondary mb-2">
              Der Import <strong className="text-text-primary">"{lastImport.filename}"</strong> wird gelöscht.
            </p>
            <p className="text-text-secondary mb-4">
              <strong className="text-red-400">ALLE {lastImport.rows_imported} Transaktionen</strong> aus diesem Import werden entfernt.
            </p>
            <p className="text-sm text-text-disabled">
              Diese Aktion kann nicht rückgängig gemacht werden!
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setImportToDelete(null);
                }}
                className="btn-secondary"
              >
                Abbrechen
              </button>
              <button
                onClick={() => importToDelete && deleteMutation.mutate(importToDelete)}
                className="btn-danger flex items-center gap-2"
                disabled={deleteMutation.isPending}
              >
                <Trash className="w-4 h-4" />
                {deleteMutation.isPending ? "Wird gelöscht..." : "Alle Transaktionen löschen"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
