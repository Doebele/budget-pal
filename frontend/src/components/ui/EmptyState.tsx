import { clsx } from "clsx";

/**
 * Leerer Zustand.
 *
 * An neun Stellen war er ad hoc formuliert, teils uebersetzt, teils
 * hartkodiert deutsch, und in der Budgetanalyse stand die Meldung "Keine
 * Daten" ueber einem trotzdem gerenderten leeren Diagramm. Hier einmal, mit
 * `role="status"`, damit Screenreader den Wechsel mitbekommen.
 */
export interface EmptyStateProps {
  title: string;
  /** Was der Nutzer tun kann — ohne das ist der leere Zustand eine Sackgasse. */
  hint?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  className?: string;
}

export default function EmptyState({ title, hint, icon: Icon, className }: EmptyStateProps) {
  return (
    <div
      role="status"
      className={clsx("flex flex-col items-center gap-2 py-10 px-4 text-center", className)}
    >
      {Icon && <Icon className="w-8 h-8 text-text-disabled" />}
      <p className="text-text-secondary text-sm">{title}</p>
      {hint && <p className="text-text-tertiary text-xs max-w-sm">{hint}</p>}
    </div>
  );
}
