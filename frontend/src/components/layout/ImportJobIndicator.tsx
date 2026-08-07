import { Link, useLocation } from "react-router-dom";
import { clsx } from "clsx";
import { CheckCircle, WarningCircle } from "@/lib/icons";
import { useActiveImportJob, importJobProgressLabel } from "@/hooks/useImportJob";
import { isImportJobRunning } from "@/lib/api";

/**
 * Zeigt auf jeder Seite an, dass ein PDF-Import läuft, und führt zurück zur
 * Vorschau. Der Status kommt vom Server, überlebt also Seitenwechsel und
 * Neuladen — genau dafür läuft der Import als Hintergrundjob.
 *
 * Auf der Import-Seite selbst blendet sich der Indikator aus; dort steht die
 * ausführliche Anzeige.
 */
export default function ImportJobIndicator() {
  const { data: job } = useActiveImportJob();
  const { pathname } = useLocation();

  if (!job || pathname === "/import") return null;

  const running = isImportJobRunning(job);
  const failed = job.status === "failed";
  const pct =
    job.chunks_total > 0
      ? Math.round((job.chunks_done / job.chunks_total) * 100)
      : null;

  return (
    <Link
      to="/import"
      className={clsx(
        "fixed z-50 bottom-24 right-4 md:bottom-6 md:right-6",
        "flex items-center gap-3 rounded-xl border px-4 py-3 shadow-lg",
        "bg-bg-surface border-border hover:border-accent/50 transition-colors",
        "max-w-[min(20rem,calc(100vw-2rem))]",
      )}
      title="Zur Import-Vorschau"
    >
      {running ? (
        <div className="w-5 h-5 border-2 border-accent/30 border-t-accent rounded-full animate-spin shrink-0" />
      ) : failed ? (
        <WarningCircle className="w-5 h-5 text-loss shrink-0" />
      ) : (
        <CheckCircle className="w-5 h-5 text-gain shrink-0" />
      )}

      <div className="min-w-0">
        <p className="text-text-primary text-xs font-medium truncate">
          {running
            ? "Import wird ausgewertet…"
            : failed
              ? "Import fehlgeschlagen"
              : "Import bereit zur Prüfung"}
        </p>
        <p className="text-text-tertiary text-[11px] truncate">
          {job.filename}
          {running && (
            <>
              {" · "}
              {importJobProgressLabel(job)}
              {pct !== null && ` (${pct} %)`}
            </>
          )}
        </p>
      </div>
    </Link>
  );
}
