import { clsx } from "clsx";

/**
 * Balken für Anteile und Auslastung.
 *
 * Das Muster `<div track><div style={{width}}/></div>` stand an sechzehn
 * Stellen im Code, jedes Mal leicht anders gebaut und keines davon für
 * Screenreader lesbar. Hier einmal, mit `role="progressbar"`.
 *
 * `reference` legt einen blasseren Balken dahinter (Soll gegen Ist),
 * `marker` setzt einen senkrechten Strich — etwa den Peer-Wert, der eine
 * Linie ist und keine Fläche.
 */
export interface ProgressBarProps {
  /** Prozent 0–100; wird geklemmt. */
  value: number;
  /** Vergleichswert im Hintergrund, ebenfalls 0–100. */
  reference?: number;
  /** Senkrechte Markierung, 0–100. */
  marker?: number;
  /** CSS-Farbe des Werts; ohne Angabe die Akzentfarbe. */
  color?: string;
  /** Volle Deckkraft ist selten gewollt — der Balken steht neben Text. */
  opacity?: number;
  size?: "sm" | "md";
  trackClassName?: string;
  className?: string;
  /** Ohne Beschriftung ist der Balken für Screenreader stumm. */
  label?: string;
  markerLabel?: string;
}

const clamp = (n: number) => Math.min(100, Math.max(0, Number.isFinite(n) ? n : 0));

export default function ProgressBar({
  value,
  reference,
  marker,
  color,
  opacity = 0.85,
  size = "sm",
  trackClassName,
  className,
  label,
  markerLabel,
}: ProgressBarProps) {
  const pct = clamp(value);
  return (
    <div
      className={clsx(
        "relative rounded-full overflow-hidden",
        size === "md" ? "h-2" : "h-1.5",
        trackClassName ?? "bg-bg-surface2",
        className,
      )}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      {reference !== undefined && (
        <div
          className="absolute inset-y-0 left-0 rounded-full opacity-25"
          style={{ width: `${clamp(reference)}%`, backgroundColor: color ?? "currentColor" }}
        />
      )}
      <div
        className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
        style={{
          width: `${pct}%`,
          backgroundColor: color ?? "var(--accent)",
          opacity,
        }}
      />
      {marker !== undefined && (
        <div
          className="absolute inset-y-0 w-0.5 bg-text-primary/70"
          style={{ left: `${clamp(marker)}%` }}
          title={markerLabel}
        />
      )}
    </div>
  );
}
