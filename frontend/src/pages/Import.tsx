import { useState, useRef, useMemo, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  importsApi,
  accountsApi,
  categoriesApi,
  aiApi,
  isImportJobRunning,
  type AiSettings,
} from "@/lib/api";
import { useActiveImportJob, useImportJob, importJobProgressLabel } from "@/hooks/useImportJob";
import { CheckCircle, Clock, Page, Table, Trash, Upload, WarningCircle, Xmark } from "@/lib/icons";
import { Link } from "react-router-dom";
import { format } from "date-fns";
import { de } from "date-fns/locale";
import { clsx } from "clsx";
import { useUiStore } from "@/lib/store";
import { formatCHF, frequencyPillStyle, PERIODICITY_LABELS } from "@/lib/theme";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useTranslation } from "react-i18next";

const BANKS = [
  { value: "ubs", label: "UBS" },
  { value: "n26", label: "N26" },
  { value: "revolut", label: "Revolut" },
  { value: "comdirect", label: "comdirect" },
];

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
// Modellname des aktuell gewählten Anbieters — steht in dessen Profil.
function modelNameFor(s?: AiSettings): string {
  if (!s || s.provider === "none") return "";
  return s.profiles[s.provider]?.model || s.provider;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")} min` : `${s}s`;
}

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
  // Kein Parser passte — die Zeilen stammen aus der KI-Extraktion und sind
  // geraten, nicht geparst. Muss sichtbar sein.
  ai_extracted?: boolean;
  // Lief die KI-Extraktion überhaupt? Unterscheidet bei 0 Zeilen "Dokument
  // enthält keine Buchungen" von "Format nicht erkannt, keine KI konfiguriert".
  ai_attempted?: boolean;
  // Welches Modell gelesen hat und was es gekostet hat
  ai_model?: string;
  ai_tokens?: number;
  // Dokument war zu lang und wurde abgeschnitten — es fehlen Buchungen
  ai_truncated?: boolean;
  // Schlusssaldo des Auszugs; wird beim Import als Kontostand übernommen,
  // wenn der Auszug nicht älter ist als der bisher übernommene
  statement_balance?: { date: string; amount: number; currency: string | null } | null;
}

interface CategoryRow {
  id: number;
  name: string;
  slug: string;
  is_system: boolean;
}

export default function Import() {
  const { t } = useTranslation();
  const { theme } = useThemeColors();
  const queryClient = useQueryClient();
  const csvRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLInputElement>(null);
  // Ziel-Konto überlebt Seitenwechsel und Neuladen — der Import läuft im
  // Hintergrund, und der Bestätigen-Schritt braucht das Konto danach wieder.
  const { importAccountId: selectedAccount, setImportAccountId: setSelectedAccount } =
    useUiStore();
  const [selectedBank, setSelectedBank] = useState("");
  const [importResult, setImportResult] = useState<{
    rows_imported: number;
    rows_skipped: number;
    bank: string;
    preview: Array<{ date: string; description: string; amount: number; category?: string; is_duplicate: boolean }>;
  } | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [importToDelete, setImportToDelete] = useState<number | null>(null);
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

  // Der Upload stösst nur an; die Auswertung läuft als Hintergrundjob, damit
  // man währenddessen navigieren kann und ein Neuladen nichts verliert.
  const [jobId, setJobId] = useState<number | null>(null);
  const { data: activeJob } = useActiveImportJob();
  const { data: job } = useImportJob(jobId);

  // Beim Betreten der Seite an einen bereits laufenden Job andocken — samt
  // dessen Ziel-Konto, falls die Auswahl lokal fehlt
  useEffect(() => {
    if (jobId === null && activeJob) {
      setJobId(activeJob.import_id);
      if (!selectedAccount && activeJob.account_id) {
        setSelectedAccount(String(activeJob.account_id));
      }
    }
  }, [activeJob, jobId, selectedAccount, setSelectedAccount]);

  const startPdfJob = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("account_id", selectedAccount);
      if (selectedBank) fd.append("bank", selectedBank);
      return (await importsApi.previewPdfAsync(fd)).data;
    },
    onSuccess: (started) => {
      setJobId(started.import_id);
      queryClient.invalidateQueries({ queryKey: ["import-job", "active"] });
    },
    onError: (error) => {
      const detail = (error as { response?: { data?: { detail?: unknown } } }).response?.data?.detail;
      alert(`Fehler beim Hochladen des PDFs: ${typeof detail === "string" ? detail : error.message}`);
    },
  });

  // Vorschau übernehmen — identisch, egal ob sie synchron kam oder aus dem Job
  const applyPdfPreview = useCallback((data: PdfPreviewData) => {
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
  }, []);

  // Job fertig → Ergebnis in die Vorschau übernehmen
  useEffect(() => {
    if (job?.status === "completed" && job.result) {
      applyPdfPreview(job.result as unknown as PdfPreviewData);
      setJobId(null);
      queryClient.invalidateQueries({ queryKey: ["import-job", "active"] });
    }
  }, [job, applyPdfPreview, queryClient]);

  const pdfPreviewMutation = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("account_id", selectedAccount);
      if (selectedBank) fd.append("bank", selectedBank);
      return importsApi.previewPdf(fd).then((r) => r.data as PdfPreviewData);
    },
    onSuccess: applyPdfPreview,
  });

  const pdfConfirmMutation = useMutation({
    mutationFn: () =>
      importsApi.confirmPdf({
        account_id: Number(selectedAccount),
        bank: selectedBank || (pdfPreview?.bank ?? "ubs"),
        filename: pdfFileName || "upload.pdf",
        rows: pdfPreview?.rows ?? [],
        statement_balance: pdfPreview?.statement_balance ?? null,
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

  // Get the last completed import
  const lastImport = history?.[0];
  // Der Eintrag, auf den sich der Löschdialog bezieht — nicht zwingend der letzte
  const selectedImport = (history ?? []).find(
    (l: { id: number }) => l.id === importToDelete,
  ) as { id: number; filename: string; rows_imported: number } | undefined;

  // CSV und PDF laufen durch denselben Hintergrundjob und dieselbe Vorschau
  // (Kategorie, Periodizität, Dubletten). Die alte CSV-Vorschau zeigte nur
  // Rohspalten, und /csv kategorisierte in der Anfrage — nach 30 s brach der
  // Browser ab.
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!selectedAccount) {
      alert("Bitte zuerst ein Ziel-Konto auswählen.");
      return;
    }
    // Hintergrundjob statt synchronem Request — sonst blockiert die Auswertung
    // die Seite minutenlang und ein Navigieren verwirft den Lauf.
    startPdfJob.mutate(file);
  };

  const pdfJobRunning = startPdfJob.isPending || isImportJobRunning(job);
  const isLoading =
    pdfPreviewMutation.isPending ||
    pdfJobRunning ||
    pdfConfirmMutation.isPending;

  // Konfiguriertes Modell — damit der Ladezustand benennen kann, wer da gerade
  // arbeitet, statt nur "bitte warten" zu zeigen.
  const { data: aiSettings } = useQuery({
    queryKey: ["ai-settings"],
    queryFn: async () => (await aiApi.get()).data,
    staleTime: 5 * 60_000,
  });
  const activeModel = modelNameFor(aiSettings);

  // Mitlaufende Uhr waehrend eines Imports. Das Backend meldet keinen echten
  // Fortschritt (es streamt nicht), aber eine laufende Sekundenanzeige zeigt,
  // dass noch gearbeitet wird — bei KI-Auswertung dauert es Minuten.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isLoading) {
      setElapsed(0);
      return;
    }
    const startedAt = Date.now();
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [isLoading]);

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-xl font-light text-text-primary">{t("pages:import.i19")}</h1>
        <p className="text-text-tertiary text-base mt-1">{t("pages:import.i12")}</p>
      </div>

      {/* Config */}
      <div className="card">
        <h2 className="text-text-primary font-semibold text-base mb-4">{t("pages:import.i22")}</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">{t("pages:import.i44")}</label>
            <select className="input" value={selectedAccount} onChange={(e) => setSelectedAccount(e.target.value)}>
              <option value="">{t("pages:import.i27")}</option>
              {(accounts || []).map((a: { id: number; name: string; bank: string }) => (
                <option key={a.id} value={String(a.id)}>{a.name} ({a.bank})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">{t("pages:import.i02")}</label>
            <select className="input" value={selectedBank} onChange={(e) => setSelectedBank(e.target.value)}>
              <option value="">{t("pages:import.i01")}</option>
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
          <p className="text-text-primary font-medium text-base">{t("pages:import.i11")}</p>
          <p className="text-text-tertiary text-sm mt-1">{t("pages:import.i45")}</p>
          <input ref={csvRef} type="file" accept=".csv" className="hidden" onChange={handleFileChange} />
        </div>

        <div
          className={clsx(
            "card border-2 border-dashed cursor-pointer hover:border-accent/50 transition-colors text-center py-10",
            !selectedAccount && "opacity-50 cursor-not-allowed"
          )}
          onClick={() => selectedAccount && pdfRef.current?.click()}
        >
          <Page className="w-8 h-8 text-text-tertiary mx-auto mb-3" />
          <p className="text-text-primary font-medium text-base">{t("pages:import.i36")}</p>
          <p className="text-text-tertiary text-sm mt-1">{t("pages:import.i34")}</p>
          <input ref={pdfRef} type="file" accept=".pdf" className="hidden" onChange={handleFileChange} />
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="card flex items-center gap-4">
          <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin shrink-0" />
          <div className="min-w-0">
            <p className="text-text-primary text-base font-medium flex items-center gap-2">
              {pdfPreviewMutation.isPending || pdfJobRunning
                ? "Vorschau wird erstellt…"
                : "Import läuft…"}
              {elapsed > 0 && (
                <span className="text-text-tertiary text-sm font-normal tabular-nums">
                  {formatElapsed(elapsed)}
                </span>
              )}
            </p>
            <p className="text-text-tertiary text-sm">
              {startPdfJob.isPending
                ? "Datei wird hochgeladen"
                : pdfJobRunning
                  ? `Datei wird ausgewertet — ${importJobProgressLabel(job)}`
                  : pdfPreviewMutation.isPending
                    ? "PDF wird gelesen und ausgewertet"
                    : "KI-Kategorisierung wird durchgeführt"}
            </p>

            {/* Echter Fortschritt: der Job meldet, welchen Textabschnitt er gerade
                auswertet. Beim synchronen Weg gibt es das nicht. */}
            {pdfJobRunning && (job?.chunks_total ?? 0) > 0 && (
              <div className="mt-2 h-1 w-56 max-w-full rounded-full bg-bg-surface2 overflow-hidden">
                <div
                  className="h-full bg-accent transition-all duration-500"
                  style={{
                    width: `${Math.round(((job?.chunks_done ?? 0) / (job?.chunks_total || 1)) * 100)}%`,
                  }}
                />
              </div>
            )}

            {pdfJobRunning && elapsed >= 10 && (
              <p className="text-text-disabled text-xs mt-1 leading-relaxed">
                Das Format ist offenbar unbekannt — {activeModel ? (
                  <>
                    <span className="font-mono text-text-tertiary">{activeModel}</span>{" "}
                    wertet den Text aus
                  </>
                ) : (
                  "das KI-Modell wertet den Text aus"
                )}
                . Das läuft im Hintergrund weiter: du kannst die Seite wechseln oder
                neu laden, der Import geht nicht verloren.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Ausserhalb des Lade-Blocks: der verschwindet, sobald der Job nicht
          mehr laeuft — und nahm die Fehlermeldung bisher mit. */}
      {!isLoading && job?.status === "failed" && (
        <div className="card flex items-start gap-3">
          <WarningCircle className="w-5 h-5 text-loss shrink-0 mt-px" />
          <div className="min-w-0">
            <p className="text-text-primary text-base font-medium">PDF-Auswertung fehlgeschlagen</p>
            <p className="text-text-secondary text-sm mt-1 break-words">{job.error_message}</p>
          </div>
        </div>
      )}

      {/* PDF Preview Modal */}
      {pdfPreview && (() => {
        const isRecurring = (r: PdfPreviewRow) => r.is_recurring;
        const recurringCount = pdfPreview.rows.filter((r) => r.is_recurring).length;
        const hasDuplicates = pdfPreview.rows.some((r) => r.duplicate_kind !== "none");
        const dbDuplicates = pdfPreview.rows.filter((r) => r.duplicate_kind === "database").length;
        const pdfDuplicates = pdfPreview.rows.filter((r) => r.duplicate_kind === "pdf").length;
        // Was nicht importiert wird — gleiche Regel wie im Backend (confirm_pdf_import)
        const isSkipped = (r: PdfPreviewRow) =>
          r.merge_action === "skip" || r.merge_action === "keep_existing" || r.merge_action === "delete_both";
        const importCount = pdfPreview.rows.filter((r) => !isSkipped(r)).length;
        const setAllDatabaseDuplicates = (action: PdfMergeAction) =>
          setPdfPreview((prev) => prev && {
            ...prev,
            rows: prev.rows.map((r) => (r.duplicate_kind === "database" ? { ...r, merge_action: action } : r)),
          });

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 sm:p-4">
            <div className="w-full max-w-[96vw] overlay-panel overflow-hidden rounded-xl border border-border bg-bg-surface shadow-2xl">

              {/* ── Header ── */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
                <div>
                  <h3 className="text-text-primary font-semibold">{t("pages:import.i35")}</h3>
                  <p className="text-text-tertiary text-sm">
                    {pdfPreview.filename} · {pdfPreview.total_rows} Zeilen · {pdfPreview.parsed_rows} erkannt
                    {pdfPreview.rows[0]?.currency && ` · ${pdfPreview.rows[0].currency}`}
                  </p>
                </div>
                <button onClick={() => setPdfPreview(null)} className="text-text-tertiary hover:text-text-primary" type="button">
                  <Xmark className="w-5 h-5" />
                </button>
              </div>

              {/* ── Stats row ── */}
              <div className="px-5 pt-4 pb-3 flex-shrink-0">
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-sm">
                  <div className="rounded-lg bg-bg-surface2 px-3 py-2 text-text-secondary">
                    Bank: <span className="text-text-primary font-semibold">{pdfPreview.bank.toUpperCase()}</span>
                  </div>
                  <div className="rounded-lg border px-3 py-2 msg-success">
                    Erkannt: <span className="font-semibold">{pdfPreview.parsed_rows}</span>
                  </div>
                  <div className="rounded-lg bg-bg-surface2 px-3 py-2 text-text-secondary">
                    Wiederkehrend: <span className="txt-info font-semibold">{recurringCount > 0 ? `${recurringCount} Zahlungen` : "–"}</span>
                  </div>
                  <div className="rounded-lg bg-bg-surface2 px-3 py-2 text-text-secondary">
                    {t("pages:import.alreadyExists")}: <span className={dbDuplicates > 0 ? "txt-warning font-semibold" : "text-text-tertiary"}>{dbDuplicates}</span>
                    {pdfDuplicates > 0 && <span className="text-text-tertiary"> · {t("pages:import.duplicateInPdf")}: {pdfDuplicates}</span>}
                  </div>
                  <div className="rounded-lg bg-bg-surface2 px-3 py-2 text-text-secondary">
                    {t("pages:ui.fehler_2")} <span className={pdfPreview.error_rows > 0 ? "txt-error font-semibold" : "text-text-tertiary"}>{pdfPreview.error_rows}</span>
                  </div>
                </div>
                {pdfPreview.total_rows === 0 && (
                  <div className="mt-3 rounded-lg bg-bg-surface2 border border-border px-4 py-3">
                    <p className="text-text-primary text-sm font-semibold flex items-center gap-1">
                      <WarningCircle className="w-3.5 h-3.5 shrink-0" />
                      Keine Buchungen gefunden
                    </p>
                    <p className="text-text-secondary text-xs mt-1 leading-relaxed">
                      {pdfPreview.ai_attempted ? (
                        <>
                          Das Format wurde nicht erkannt, deshalb hat das KI-Modell den
                          Text ausgewertet — es enthält aber keine Buchungen. Bei
                          Auszügen ohne Kontobewegung ist das normal: solche PDFs
                          bestehen nur aus der Saldo-Übersicht. Prüfe, ob der Auszug
                          das richtige Konto und den richtigen Zeitraum abdeckt.
                        </>
                      ) : (
                        <>
                          Das PDF-Format wurde nicht erkannt. Aktiviere unter{" "}
                          <Link to="/settings" className="text-accent hover:underline">
                            Einstellungen → KI-Modell
                          </Link>{" "}
                          einen Anbieter, damit unbekannte PDFs ausgewertet werden können.
                        </>
                      )}
                    </p>
                  </div>
                )}
                {pdfPreview.statement_balance && (
                  <p className="text-text-secondary text-sm mt-2">
                    {t("pages:import.statementBalance", {
                      amount: pdfPreview.statement_balance.amount.toLocaleString("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
                      currency: pdfPreview.statement_balance.currency ?? "",
                      date: format(new Date(pdfPreview.statement_balance.date), "dd.MM.yyyy"),
                    })}
                  </p>
                )}
                {pdfPreview.ai_truncated && (
                  <p className="text-loss text-xs mt-2 flex items-start gap-1">
                    <WarningCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
                    <span>
                      <strong>{t("pages:import.i40")}</strong> Nicht das ganze Dokument konnte
                      ausgewertet werden — es ist zu lang, oder eine Antwort der KI
                      brach am Token-Limit ab. Es fehlen Buchungen. Teile das PDF auf
                      oder nutze, falls vorhanden, den CSV-Export der Bank.
                    </span>
                  </p>
                )}
                {pdfPreview.ai_extracted && (
                  <p className="txt-warning text-xs mt-2 flex items-start gap-1">
                    <WarningCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
                    <span>
                      Unbekanntes PDF-Format — diese Zeilen wurden per KI aus dem Text
                      gelesen. Bitte Beträge und Daten vor dem Import prüfen.
                      {pdfPreview.ai_model && (
                        <span className="text-text-disabled">
                          {" "}
                          Modell: <span className="font-mono">{pdfPreview.ai_model}</span>
                          {pdfPreview.ai_tokens
                            ? ` · ${pdfPreview.ai_tokens.toLocaleString("de-CH")} Tokens`
                            : ""}
                        </span>
                      )}
                    </span>
                  </p>
                )}
                {hasDuplicates && (
                  <div className="mt-3 rounded-lg border px-4 py-3 msg-warning flex flex-wrap items-center justify-between gap-3">
                    <div className="text-sm space-y-1">
                      {dbDuplicates > 0 && (
                        <p className="flex items-start gap-1">
                          <WarningCircle className="w-4 h-4 shrink-0 mt-px" />
                          {t("pages:import.dupNoticeDb", { count: dbDuplicates })}
                        </p>
                      )}
                      {pdfDuplicates > 0 && <p className="pl-5">{t("pages:import.dupNoticePdf", { count: pdfDuplicates })}</p>}
                    </div>
                    {dbDuplicates > 0 && (
                      <div className="flex gap-2 shrink-0">
                        <button type="button" className="btn-secondary text-sm" onClick={() => setAllDatabaseDuplicates("keep_existing")}>
                          {t("pages:import.dupSkipAll")}
                        </button>
                        <button type="button" className="btn-ghost text-sm" onClick={() => setAllDatabaseDuplicates("import")}>
                          {t("pages:import.dupImportAll")}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* ── Table ── */}
              <div className="overlay-body px-5 pb-2">
                <table className="w-full text-sm border-collapse">
                  <thead className="sticky top-0 z-10 bg-bg-surface2">
                    <tr>
                      {/* Status badges column */}
                      <th className="text-left px-2 py-2 text-text-tertiary font-medium w-[90px] whitespace-nowrap">{t("pages:import.i38")}</th>
                      {/* Date */}
                      <th className="text-left px-2 py-2 text-text-tertiary font-medium w-[108px]">{t("pages:import.i14")}</th>
                      {/* Description — gets max remaining space */}
                      <th className="text-left px-2 py-2 text-text-tertiary font-medium min-w-[220px]">{t("pages:import.i06")}</th>
                      {/* Amount */}
                      <th className="text-right px-2 py-2 text-text-tertiary font-medium w-[110px]">{t("pages:import.i08")}</th>
                      {/* AI Category + Frequency */}
                      <th className="text-left px-2 py-2 text-text-tertiary font-medium w-[310px]">{t("pages:import.i26")}</th>
                      {/* Duplicate action — only shown if there are duplicates */}
                      {hasDuplicates && (
                        <th className="text-left px-2 py-2 text-text-tertiary font-medium w-[160px]">{t("pages:import.i15")}</th>
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
                            // Wird nicht importiert: sichtbar zuruecknehmen
                            (!row.parsed || isSkipped(row)) && "opacity-50"
                          )}
                        >
                          {/* ── Status badges ── */}
                          <td className="px-2 py-2 align-middle">
                            <div className="flex flex-col gap-1">
                              {row.duplicate_kind === "database" && (
                                <span className="inline-flex rounded px-1 py-1 msg-warning text-2xs font-medium leading-tight" title={t("pages:import.alreadyExistsTitle")}>
                                  {t("pages:import.alreadyExists")}
                                </span>
                              )}
                              {row.duplicate_kind === "pdf" && (
                                <span className="inline-flex rounded px-1 py-1 bg-bg-elevated text-text-secondary text-2xs font-medium leading-tight">
                                  {t("pages:import.duplicateInPdf")}
                                </span>
                              )}
                              {recurring && (
                                <span className="pill text-2xs" style={frequencyPillStyle(row.periodicity ?? "monthly", theme)} title={row.periodicity ? PERIODICITY_LABELS[row.periodicity] : "Wiederkehrend"}>
                                  ↻ {row.periodicity ? PERIODICITY_LABELS[row.periodicity] : "Abo"}
                                </span>
                              )}
                              {row.duplicate_kind === "none" && !recurring && (
                                <span className="text-text-disabled text-2xs">—</span>
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
                              className="input w-[100px] text-sm"
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
                              className="input min-w-[200px] text-sm"
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
                                "input input-amount font-mono font-semibold text-sm",
                                isExpense ? "txt-error" : "txt-success"
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
                                className="input flex-1 min-w-0 text-xs"
                              >
                                <option value="">{t("pages:misc.r29")}</option>
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
                                className="input w-[130px] flex-shrink-0 text-xs"
                                // nur die Textfarbe: das Feld behält die Ledger-Linie
                                style={row.periodicity ? { color: frequencyPillStyle(row.periodicity, theme).color } : undefined}
                              >
                                <option value="">{t("pages:import.i16")}</option>
                                <option value="weekly">{t("pages:import.i42")}</option>
                                <option value="monthly">{t("pages:import.i30")}</option>
                                <option value="quarterly">{t("pages:import.i41")}</option>
                                <option value="halfyearly">{t("pages:import.i18")}</option>
                                <option value="yearly">{t("pages:import.i25")}</option>
                              </select>
                            </div>
                          </td>

                          {/* ── Duplicate action (only rendered when duplicates exist) ── */}
                          {hasDuplicates && (
                            <td className="px-2 py-2 align-middle">
                              {row.duplicate_kind === "database" ? (
                                <select
                                  className="input text-xs w-full"
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
                                  <option value="keep_existing">{t("pages:import.i03")}</option>
                                  <option value="overwrite">{t("pages:import.i47")}</option>
                                  <option value="delete_both" title={t("pages:import.deleteBothTitle")}>{t("pages:import.i29")}</option>
                                  <option value="import">{t("pages:import.i31")}</option>
                                </select>
                              ) : row.duplicate_kind === "pdf" ? (
                                <select
                                  className="input text-xs w-full"
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
                                  <option value="skip">{t("pages:import.i48")}</option>
                                  <option value="import">{t("pages:import.i24")}</option>
                                </select>
                              ) : (
                                <span className="text-text-disabled text-2xs">{t("pages:import.i19")}</span>
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
                <p className="text-text-disabled text-sm">
                  {t("pages:import.footerImport", { count: importCount })}
                  {pdfPreview.rows.length > importCount && (
                    <span className="txt-warning"> · {t("pages:import.footerSkipped", { count: pdfPreview.rows.length - importCount })}</span>
                  )}
                </p>
                <div className="flex gap-3">
                  <button onClick={() => setPdfPreview(null)} className="btn-secondary text-base">{t("pages:import.i00")}</button>
                  <button
                    onClick={() => pdfConfirmMutation.mutate()}
                    disabled={pdfConfirmMutation.isPending || pdfPreview.rows.length === 0}
                    className="btn-primary text-base"
                  >
                    {pdfConfirmMutation.isPending ? "Importiere…" : "Transaktionen importieren"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Result */}
      {importResult && !isLoading && (
        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <CheckCircle className="w-5 h-5 text-gain" />
            <div>
              <p className="text-text-primary font-semibold text-base">{t("pages:import.i20")}</p>
              <p className="text-text-tertiary text-sm">
                {importResult.rows_imported} importiert · {importResult.rows_skipped} Duplikate übersprungen · Bank: {importResult.bank.toUpperCase()}
              </p>
            </div>
          </div>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {importResult.preview?.map((p, i) => (
              <div key={i} className={clsx("flex items-center justify-between py-1 px-2 rounded", p.is_duplicate ? "opacity-40" : "")}>
                <div>
                  <p className="text-text-primary text-sm">{p.description.slice(0, 50)}</p>
                  <p className="text-text-tertiary text-sm">{p.date} · {p.category || "?"}</p>
                </div>
                <span className={clsx("text-sm font-mono", p.amount >= 0 ? "text-gain" : "text-loss")}>
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
          <h2 className="text-text-primary font-semibold text-base">{t("pages:import.i23")}</h2>
          {/* Delete Last Import Button */}
          {lastImport && lastImport.status === "completed" && (
            <button
              onClick={() => {
                setImportToDelete(lastImport.id);
                setShowDeleteConfirm(true);
              }}
              className="text-text-tertiary hover:text-loss text-sm flex items-center gap-1 transition-colors"
              title={t("pages:import.i28")}
            >
              <Trash className="w-3.5 h-3.5" />
              {t("pages:ui.letzten_import_rueckgaengig_machen")}
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
                <p className="text-text-primary text-sm font-medium truncate">{log.filename}</p>
                <p className="text-text-tertiary text-sm">
                  {log.bank?.toUpperCase()} · {t("pages:ui.entriesCount", { count: log.rows_imported })} · {format(new Date(log.created_at), "dd.MM.yyyy HH:mm")}
                </p>
              </div>
              {/* Jeder Eintrag einzeln entfernbar — nicht nur der letzte. Bei
                  gescheiterten Importen gibt es nichts zurückzunehmen, dort
                  verschwindet nur der Eintrag. */}
              <button
                onClick={() => {
                  setImportToDelete(log.id);
                  setShowDeleteConfirm(true);
                }}
                className="text-text-tertiary hover:text-loss transition-colors shrink-0 p-1"
                title={
                  log.rows_imported > 0
                    ? `Import rückgängig machen (${log.rows_imported} Transaktionen entfernen)`
                    : "Eintrag aus der Historie entfernen"
                }
                aria-label={t("pages:import.i21")}
              >
                <Trash className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          {(!history || history.length === 0) && (
            <p className="text-text-tertiary text-base text-center py-6">{t("pages:import.i33")}</p>
          )}
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && importToDelete && selectedImport && (
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
                {selectedImport.rows_imported > 0
                  ? "Import rückgängig machen?"
                  : "Eintrag entfernen?"}
              </h3>
            </div>
            <p className="text-text-secondary mb-2">
              Der Import <strong className="text-text-primary">"{selectedImport.filename}"</strong> {t("pages:ui.wird_entfernt")}
            </p>
            {selectedImport.rows_imported > 0 ? (
              <>
                <p className="text-text-secondary mb-4">
                  <strong className="txt-error">
                    ALLE {selectedImport.rows_imported} Transaktionen
                  </strong>{" "}
                  aus diesem Import werden gelöscht.
                </p>
                <p className="text-base text-text-disabled">
                  {t("pages:ui.diese_aktion_kann_nicht_rueckgaengig_gemacht")}
                </p>
              </>
            ) : (
              /* Gescheiterte oder leere Importe haben nichts angelegt */
              <p className="text-text-secondary mb-4">
                {t("pages:hints.importCreatedNothing")}
              </p>
            )}
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setImportToDelete(null);
                }}
                className="btn-secondary"
              >
                {t("pages:ui.abbrechen")}
              </button>
              <button
                onClick={() => importToDelete && deleteMutation.mutate(importToDelete)}
                className="btn-danger flex items-center gap-2"
                disabled={deleteMutation.isPending}
              >
                <Trash className="w-4 h-4" />
                {deleteMutation.isPending
                  ? "Wird gelöscht…"
                  : selectedImport.rows_imported > 0
                    ? "Alle Transaktionen löschen"
                    : "Eintrag entfernen"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
