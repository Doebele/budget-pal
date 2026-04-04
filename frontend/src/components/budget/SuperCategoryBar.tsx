/**
 * SuperCategoryBar
 *
 * Renders a single horizontal bar for a supercategory showing:
 *   ■ Ist  (solid bar, category colour)
 *   □ Soll (full-width background track)
 *
 * Clicking opens the drill-down panel.
 */
import { clsx } from "clsx";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { formatCHF } from "@/lib/theme";
import type { SuperCategory } from "@/lib/categories";

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
  subItems?: SubItem[];
  onClick?: () => void;
}

export default function SuperCategoryBar({
  superCategory,
  actual,
  planned,
  subItems,
  onClick,
}: SuperCategoryBarProps) {
  const hasActual  = actual  !== undefined && actual  > 0;
  const hasPlanned = planned !== undefined && planned > 0;

  // Decide track width (max of actual / planned)
  const trackMax = Math.max(actual ?? 0, planned ?? 0);
  const actualPct  = trackMax > 0 ? Math.min(100, ((actual  ?? 0) / trackMax) * 100) : 0;
  const plannedPct = trackMax > 0 ? Math.min(100, ((planned ?? 0) / trackMax) * 100) : 0;

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
      {/* Top row: emoji + label + amounts */}
      <div className="flex items-center justify-between mb-2 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base leading-none">{superCategory.emoji}</span>
          <span className="text-text-primary text-sm font-medium truncate">
            {superCategory.label}
          </span>
          {isOverBudget && (
            <span
              className="shrink-0 flex items-center gap-0.5 text-xs text-loss bg-loss/10 px-1.5 py-0.5 rounded-full border border-loss/25"
              title={`${overPct}% über Budget`}
            >
              <AlertTriangle className="w-3 h-3" />
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
          <ChevronRight className="w-3.5 h-3.5 text-text-disabled group-hover:text-text-tertiary transition-colors" />
        </div>
      </div>

      {/* Bar track */}
      <div className="relative h-2 bg-bg-surface2 rounded-full overflow-hidden">
        {/* Planned / Soll track (lighter, full-width reference) */}
        {hasPlanned && (
          <div
            className="absolute inset-y-0 left-0 rounded-full opacity-25"
            style={{
              width: `${plannedPct}%`,
              backgroundColor: superCategory.color,
            }}
          />
        )}
        {/* Actual / Ist bar */}
        {hasActual && (
          <div
            className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
            style={{
              width: `${actualPct}%`,
              backgroundColor: isOverBudget ? "#f87171" : superCategory.color,
              opacity: 0.85,
            }}
          />
        )}
        {/* No-data case */}
        {!hasActual && !hasPlanned && (
          <div className="absolute inset-y-0 left-0 w-full rounded-full bg-bg-elevated" />
        )}
      </div>

      {/* Sub-items summary (collapsed, shown as dots) */}
      {subItems && subItems.length > 1 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5">
          {subItems.slice(0, 4).map((sub) => (
            <span key={sub.label} className="text-text-disabled text-xs truncate">
              {sub.label}
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
