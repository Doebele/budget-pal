import { useState, useCallback } from "react";
import { formatCHF } from "@/lib/theme";
import { Archive, Trash, WarningTriangle, Xmark } from "@/lib/icons";
import { clsx } from "clsx";
import { format } from "date-fns";
import { de } from "date-fns/locale";
import { useBulkDelete } from "@/hooks/useBulkDelete";

/**
 * Bulk archive / purge for the selected account on the transactions overview.
 * Soft-delete (archive) is default; hard delete requires explicit confirmation.
 */
export function TransactionOverviewHeader({
  accountId,
  accountName,
}: {
  accountId: number;
  accountName: string;
}) {
  const [open, setOpen] = useState(false);

  const {
    preview,
    previewError,
    previewErrorMessage,
    refetchPreview,
    showPreviewSpinner,
    transactionCount: count,
    confirmHard,
    setConfirmHard,
    resetConfirmHard,
    archiveMutation,
    mutating,
    canArchive,
    canHardDelete,
    accountIdValid,
  } = useBulkDelete(accountId, open, {
    onCompleted: () => setOpen(false),
  });

  const closeModal = useCallback(() => {
    setOpen(false);
    resetConfirmHard();
  }, [resetConfirmHard]);

  const dismissLocked = mutating;
  const cancelDisabled = mutating;

  const submitArchive = useCallback(() => {
    if (canArchive) archiveMutation.mutate(false);
  }, [canArchive, archiveMutation]);

  const submitHardDelete = useCallback(() => {
    if (canHardDelete) archiveMutation.mutate(true);
  }, [canHardDelete, archiveMutation]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium bg-amber-600/90 hover:bg-amber-600 text-white shadow-md transition-colors"
        title="Alle Transaktionen dieses Kontos archivieren"
      >
        <span className="relative inline-flex">
          <Archive className="w-4 h-4" />
          <WarningTriangle className="w-2.5 h-2.5 text-amber-100 absolute -right-1 -top-0.5" />
        </span>
        <span className="hidden sm:inline">Transaktionen archivieren</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget && !dismissLocked) {
              closeModal();
            }
          }}
        >
          <div
            className="relative w-full max-w-lg bg-slate-900 border border-amber-500/30 rounded-xl shadow-2xl mx-4 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-gradient-to-r from-amber-900/40 to-slate-900 p-5 border-b border-slate-700">
              <div className="flex items-start gap-3">
                <div className="w-11 h-11 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0">
                  <WarningTriangle className="w-6 h-6 text-amber-400" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-white">
                    Alle Transaktionen dieses Kontos archivieren?
                  </h3>
                  <p className="text-slate-400 text-sm mt-1">
                    Konto: <span className="text-white font-medium">{accountName}</span>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (!dismissLocked) closeModal();
                  }}
                  className="ml-auto p-1 rounded text-slate-500 hover:text-white"
                  aria-label="Schließen"
                >
                  <Xmark className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-5 space-y-4">
              {!accountIdValid && (
                <p className="text-amber-200 text-sm rounded-lg border border-amber-500/30 bg-amber-950/40 p-3">
                  Ungültige Konto-ID. Bitte Konto erneut auswählen.
                </p>
              )}

              {showPreviewSpinner && (
                <div className="flex items-center gap-3 text-slate-400 text-sm">
                  <div className="w-5 h-5 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin" />
                  Vorschau wird geladen…
                </div>
              )}

              {previewError && (
                <div className="rounded-lg border border-red-500/40 bg-red-950/40 p-4 space-y-3">
                  <p className="text-red-200 text-sm">{previewErrorMessage}</p>
                  <button
                    type="button"
                    onClick={() => refetchPreview()}
                    className="text-sm font-medium text-white bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded-md"
                  >
                    Erneut versuchen
                  </button>
                </div>
              )}

              {preview && (
                <div className="rounded-lg bg-slate-800/80 border border-slate-700 p-4 space-y-2">
                  <p className="text-white font-medium">{count} Transaktionen betroffen</p>
                  <p className="text-slate-400 text-sm">
                    Nach dem Archivieren erscheinen diese Buchungen nicht mehr in der
                    Transaktionsübersicht (Soft-Delete). Daten bleiben in der Datenbank für
                    Nachvollziehbarkeit.
                  </p>
                  {count > 0 && preview.date_range.from && preview.date_range.to && (
                    <p className="text-xs text-slate-500">
                      Zeitraum:{" "}
                      {format(new Date(preview.date_range.from), "dd.MM.yyyy", { locale: de })} –{" "}
                      {format(new Date(preview.date_range.to), "dd.MM.yyyy", { locale: de })}
                    </p>
                  )}
                  {count === 0 && (
                    <p className="text-amber-200/90 text-sm pt-1">
                      Es gibt keine aktiven Transaktionen mehr für dieses Konto (alle archiviert oder
                      leer). Archivieren oder Hard-Delete ist nicht möglich.
                    </p>
                  )}
                  <p className="text-sm text-slate-300 font-mono">
                    Summe Beträge (Saldo-Vektor): {formatCHF(preview.total_amount)}
                  </p>
                </div>
              )}

              <div className="rounded-lg border border-red-500/25 bg-red-950/30 p-4 space-y-3">
                <p className="text-red-200 text-sm font-medium flex items-center gap-2">
                  <Trash className="w-4 h-4" />
                  Löschen ohne Archivierung (Hard-Delete)
                </p>
                <p className="text-red-200/80 text-xs">
                  Entfernt die Datensätze unwiderruflich aus der Datenbank. Nur verwenden, wenn Sie
                  sicher sind.
                </p>
                <label className="flex items-center gap-2 cursor-pointer text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={confirmHard}
                    onChange={(e) => setConfirmHard(e.target.checked)}
                    className="rounded border-slate-600"
                  />
                  Ich verstehe, dass Hard-Delete nicht rückgängig gemacht werden kann.
                </label>
              </div>

              <div className="flex flex-col sm:flex-row justify-end gap-2 pt-2 border-t border-slate-700">
                <button
                  type="button"
                  disabled={cancelDisabled}
                  onClick={closeModal}
                  className="px-4 py-2.5 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-800 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Abbrechen
                </button>
                <button
                  type="button"
                  disabled={!canArchive}
                  onClick={submitArchive}
                  className={clsx(
                    "px-4 py-2.5 rounded-lg text-sm font-medium flex items-center justify-center gap-2",
                    !canArchive
                      ? "bg-slate-700 text-slate-500 cursor-not-allowed"
                      : "bg-sky-600 hover:bg-sky-500 text-white"
                  )}
                >
                  <Archive className="w-4 h-4" />
                  Archivieren
                </button>
                <button
                  type="button"
                  disabled={!canHardDelete}
                  onClick={submitHardDelete}
                  className={clsx(
                    "px-4 py-2.5 rounded-lg text-sm font-medium flex items-center justify-center gap-2",
                    !canHardDelete
                      ? "bg-slate-700 text-slate-500 cursor-not-allowed"
                      : "bg-red-600 hover:bg-red-500 text-white"
                  )}
                >
                  <Trash className="w-4 h-4" />
                  Endgültig löschen
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
