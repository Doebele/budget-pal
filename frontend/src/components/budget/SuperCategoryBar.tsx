/**
 * SuperCategoryBar
 *
 * Renders a single horizontal bar for a supercategory showing:
 *   ■ Ist  (solid bar, category colour)
 *   □ Soll (full-width background track)
 *   | Peer (senkrechte Markierung)
 *
 * Mit dem Peer-Wert zeigt die Balkenansicht dieselben drei Groessen wie die
 * Ring-Gauges — die Wahl der Darstellung kostet dann keine Information mehr.
 *
 * Clicking opens the drill-down panel.
 */
import { clsx } from "clsx";
import { NavArrowRight, WarningTriangle } from "@/lib/icons";
import { formatCHF } from "@/lib/theme";
import type { SuperCategory } from "@/lib/categories";
import { translateCategory } from "@/lib/categoryLabel";
import ProgressBar from "@/components/ui/ProgressBar";

export interface SubItem {
  label: string;
  actual?: number;
  planned?: number;
  source?: "txn" | "wizard" | "both";
}

export interface SuperCategoryBarProps {
  superCategory: SuperCategory;
  actual?: number;      // CHF – real transactions
  planned?: number;     // CHF – wizard / combined soll
  peer?: number;        // CHF – BFS-Vergleichswert der Peer-Gruppe
  subItems?: SubItem[];
  onClick?: () => void;
}

export default function SuperCategoryBar({
  superCategory,
  actual,
  planned,
  peer,
  subItems,
  onClick,
}: SuperCategoryBarProps) {
  const hasActual  = actual  !== undefined && actual  > 0;
  const hasPlanned = planned !== undefined && planned > 0;

  const hasPeer = peer !== undefined && peer > 0;

  // Decide track width (max of actual / planned / peer)
  const trackMax = Math.max(actual ?? 0, planned ?? 0, peer ?? 0);
  const actualPct  = trackMax > 0 ? Math.min(100, ((actual  ?? 0) / trackMax) * 100) : 0;
  const plannedPct = trackMax > 0 ? Math.min(100, ((planned ?? 0) / trackMax) * 100) : 0;
  const peerPct    = trackMax > 0 ? Math.min(100, ((peer    ?? 0) / trackMax) * 100) : 0;

  const isOverBudget = hasActual && hasPlanned && actual! > planned!;
  const overPct      = isOverBudget
    ? Math.round(((actual! - planned!) / planned!) * 100)
    : 0;

  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "w-full text-left group px-4 py-3 rounded-xl transition-colors",
        "hover:bg-bg-surface2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
      )}
    >
      {/* Top row: icon + label + amounts */}
      <div className="flex items-center justify-between mb-2 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="w-6 h-6 rounded-md flex items-center justify-center shrink-0"
            style={{ backgroundColor: superCategory.color + "22" }}
          >
            <superCategory.icon className="w-3.5 h-3.5" style={{ color: superCategory.color }} />
          </span>
          <span className="text-text-primary text-sm font-medium truncate">
            {superCategory.label}
          </span>
          {isOverBudget && (
            <span
              className="shrink-0 flex items-center gap-0.5 text-xs text-loss bg-loss/10 px-1.5 py-0.5 rounded-full border border-loss/25"
              title={`${overPct}% über Budget`}
            >
              <WarningTriangle className="w-3 h-3" />
              +{overPct}%
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 shrink-0 text-xs font-mono">
          {hasActual && (
            <span className={clsx(isOverBudget ? "text-loss" : "text-text-primary")}>
              {formatCHF(actual!)}
            </span>
          )}
          {hasActual && hasPlanned && (
            <span className="text-text-tertiary">/</span>
          )}
          {hasPlanned && (
            <span className="text-text-tertiary">{formatCHF(planned!)}</span>
          )}
          <NavArrowRight className="w-3.5 h-3.5 text-text-disabled group-hover:text-text-tertiary transition-colors" />
        </div>
      </div>

      {/* Bar track */}
      {hasActual || hasPlanned ? (
        <ProgressBar
          size="md"
          value={hasActual ? actualPct : 0}
          reference={hasPlanned ? plannedPct : undefined}
          marker={hasPeer ? peerPct : undefined}
          markerLabel={hasPeer ? `Peer: ${formatCHF(peer!)}` : undefined}
          color={isOverBudget ? "var(--red)" : superCategory.color}
          label={superCategory.label}
        />
      ) : (
        <div className="h-2 rounded-full bg-bg-elevated" />
      )}

      {/* Sub-items summary */}
      {subItems && subItems.length > 1 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5">
          {subItems.slice(0, 4).map((sub) => (
            <span key={sub.label} className="flex items-baseline gap-1 text-xs">
              <span className="text-text-disabled truncate max-w-[120px]">{translateCategory(sub.label)}</span>
              {sub.actual !== undefined && sub.actual > 0 && (
                <span className="text-text-disabled/60 font-mono tabular-nums shrink-0">
                  {formatCHF(sub.actual)}
                </span>
              )}
            </span>
          ))}
          {subItems.length > 4 && (
            <span className="text-text-disabled text-xs">+{subItems.length - 4} weitere</span>
          )}
        </div>
      )}
    </button>
  );
}
