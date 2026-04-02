import { useState, useRef, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { importsApi, accountsApi } from "@/lib/api";
import { Upload, FileText, CheckCircle2, AlertCircle, Clock, Trash2, X, Eye, Settings2, ChevronDown, ChevronUp, Check, AlertTriangle, Table2, MapPin, Database } from "lucide-react";
import { format } from "date-fns";
import { de } from "date-fns/locale";
import { clsx } from "clsx";
import { formatCHF } from "@/lib/theme";

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

  const { data: accounts } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => accountsApi.list().then((r) => r.data),
  });

  const { data: history } = useQuery({
    queryKey: ["import-history"],
    queryFn: () => importsApi.history().then((r) => r.data),
  });

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

  const pdfMutation = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("account_id", selectedAccount);
      if (selectedBank) fd.append("bank", selectedBank);
      return importsApi.uploadPdf(fd).then((r) => r.data);
    },
    onSuccess: (data) => {
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
    if (file && selectedAccount) pdfMutation.mutate(file);
  };

  const isLoading = csvMutation.isPending || pdfMutation.isPending || previewMutation.isPending;

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
          <FileText className="w-8 h-8 text-text-tertiary mx-auto mb-3" />
          <p className="text-text-primary font-medium text-sm">PDF importieren</p>
          <p className="text-text-tertiary text-xs mt-1">OCR-Extraktion (direkter Import)</p>
          <input ref={pdfRef} type="file" accept=".pdf" className="hidden" onChange={handlePdfChange} />
        </div>
      </div>

      {/* Loading */}
      {isLoading && !previewData && (
        <div className="card flex items-center gap-4">
          <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
          <div>
            <p className="text-text-primary text-sm font-medium">
              {previewMutation.isPending ? "Vorschau wird erstellt..." : "Import läuft..."}
            </p>
            <p className="text-text-tertiary text-xs">
              {previewMutation.isPending ? "CSV wird analysiert" : "KI-Kategorisierung wird durchgeführt"}
            </p>
          </div>
        </div>
      )}

      {/* Preview Section */}
      {previewData && (
        <div className="card space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-accent/20 flex items-center justify-center">
                <Eye className="w-5 h-5 text-accent" />
              </div>
              <div>
                <p className="text-white font-semibold text-sm">Import-Vorschau: {previewData.total_rows} Zeilen</p>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-slate-400">
                    Bank: <span className="text-white">{previewData.bank.toUpperCase()}</span>
                  </span>
                  <span className="text-slate-600">|</span>
                  <span className="text-gain flex items-center gap-1">
                    <Check className="w-3 h-3" />
                    {previewData.parsed_rows} erfolgreich
                  </span>
                  {previewData.error_rows > 0 && (
                    <>
                      <span className="text-slate-600">|</span>
                      <span className="text-red-400 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" />
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
                    : "bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700"
                )}
              >
                <Table2 className="w-3.5 h-3.5" />
                Feldzuweisung
                {showColumnMapping ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>
              <button
                onClick={() => {
                  setPreviewData(null);
                  setSelectedFile(null);
                  setShowColumnMapping(false);
                }}
                className="px-3 py-2 rounded-lg bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700 border border-slate-700 transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Enhanced Column Mapping Panel */}
          {showColumnMapping && availableColumns.length > 0 && (
            <div className="bg-slate-800/50 rounded-lg border border-slate-700 overflow-hidden">
              {/* Header */}
              <div className="bg-slate-800 px-4 py-3 border-b border-slate-700 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Table2 className="w-4 h-4 text-accent" />
                  <span className="text-white font-medium text-sm">CSV-Feldzuweisung</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400">
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
                <div className="overflow-auto max-h-48 border border-slate-700 rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-700 text-slate-300">
                      <tr>
                        <th className="text-left px-3 py-2 text-xs font-medium">CSV Spalte</th>
                        <th className="text-left px-3 py-2 text-xs font-medium">Ziel-Feld</th>
                        <th className="text-left px-3 py-2 text-xs font-medium">Beispielwert</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700">
                      {availableColumns.map((col) => {
                        const { type, label, icon } = getColumnType(col);
                        const isMapped = type !== "unassigned";
                        return (
                          <tr key={col} className={clsx(
                            "hover:bg-slate-700/30 transition-colors",
                            isMapped && "bg-accent/5"
                          )}>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-2">
                                <span className="text-lg">{icon}</span>
                                <span className={clsx(
                                  "font-medium",
                                  isMapped ? "text-white" : "text-slate-400"
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
                                <span className="text-slate-500 text-xs italic">Nicht zugewiesen</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-slate-400 text-xs font-mono truncate max-w-[150px]">
                              {getExampleValue(col)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Manual Field Assignment */}
                <div className="border-t border-slate-700 pt-4">
                  <p className="text-slate-300 text-xs font-medium mb-3 flex items-center gap-2">
                    <Database className="w-3.5 h-3.5 text-slate-400" />
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
                      <AlertTriangle className="w-4 h-4 text-red-400" />
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
                <div className="bg-slate-700/30 rounded p-3 text-xs text-slate-400">
                  <p className="flex items-start gap-2">
                    <span className="text-accent">💡</span>
                    <span>
                      <strong className="text-slate-300">Tipp:</strong> Wähle "Belastung" und "Gutschrift" für separate Spalten,
                      oder "Betrag" für eine kombinierte Spalte mit +/- Vorzeichen. Felder mit <span className="text-red-400">*</span> sind erforderlich.
                    </span>
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Preview Table */}
          <div className="overflow-auto max-h-80 border border-slate-700 rounded-lg">
            <table className="w-full text-xs">
              <thead className="bg-slate-800 sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2 text-slate-400 font-medium">#</th>
                  <th className="text-left px-3 py-2 text-slate-400 font-medium">Datum</th>
                  <th className="text-left px-3 py-2 text-slate-400 font-medium">Beschreibung</th>
                  <th className="text-right px-3 py-2 text-slate-400 font-medium">Betrag</th>
                  <th className="text-center px-3 py-2 text-slate-400 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {previewData.rows.map((row) => (
                  <tr key={row.row_index} className={clsx(
                    "hover:bg-slate-800/30 transition-colors",
                    !row.parsed && "bg-red-500/5",
                    row.parsed && "bg-green-500/5"
                  )}>
                    <td className="px-3 py-2 text-slate-500">{row.row_index + 1}</td>
                    <td className="px-3 py-2 text-white font-mono text-xs">{row.date || "-"}</td>
                    <td className="px-3 py-2 text-white max-w-xs truncate" title={row.description || ""}>
                      {row.description || "-"}
                    </td>
                    <td className={clsx(
                      "px-3 py-2 text-right font-mono font-medium",
                      row.amount === null ? "text-slate-500" : row.amount >= 0 ? "text-gain" : "text-loss"
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
                          <AlertTriangle className="w-3 h-3" />
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
          <div className="flex justify-end gap-3 pt-4 border-t border-slate-700">
            <button
              onClick={() => {
                setPreviewData(null);
                setSelectedFile(null);
                setShowColumnMapping(false);
              }}
              className="px-4 py-2 rounded-lg bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors text-sm"
            >
              Abbrechen
            </button>
            <button
              onClick={handleCsvImport}
              disabled={previewData.parsed_rows === 0 || mappingWarnings.some(w => w.includes("erforderlich"))}
              className={clsx(
                "px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-all",
                previewData.parsed_rows > 0 && !mappingWarnings.some(w => w.includes("erforderlich"))
                  ? "bg-accent text-slate-900 hover:bg-accent-light"
                  : "bg-slate-700 text-slate-500 cursor-not-allowed"
              )}
              title={mappingWarnings.find(w => w.includes("erforderlich")) || "Import durchführen"}
            >
              <CheckCircle2 className="w-4 h-4" />
              {previewData.parsed_rows} Transaktionen importieren
            </button>
          </div>
        </div>
      )}

      {/* Result */}
      {importResult && !isLoading && (
        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <CheckCircle2 className="w-5 h-5 text-gain" />
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
              <Trash2 className="w-3.5 h-3.5" />
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
                {log.status === "completed" ? <CheckCircle2 className="w-3.5 h-3.5 text-gain" />
                  : log.status === "failed" ? <AlertCircle className="w-3.5 h-3.5 text-loss" />
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
          <div className="relative w-full max-w-md bg-slate-800 rounded-lg border border-slate-700 p-6 shadow-xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-red-500" />
              </div>
              <h3 className="text-lg font-semibold text-white">
                Import komplett löschen?
              </h3>
            </div>
            <p className="text-slate-300 mb-2">
              Der Import <strong className="text-white">"{lastImport.filename}"</strong> wird gelöscht.
            </p>
            <p className="text-slate-300 mb-4">
              <strong className="text-red-400">ALLE {lastImport.rows_imported} Transaktionen</strong> aus diesem Import werden entfernt.
            </p>
            <p className="text-sm text-slate-500">
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
                <Trash2 className="w-4 h-4" />
                {deleteMutation.isPending ? "Wird gelöscht..." : "Alle Transaktionen löschen"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
