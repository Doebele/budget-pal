/**
 * CategoryDrillDown
 *
 * Slide-in panel (right side) that shows the breakdown of a single
 * supercategory:
 *   • Ist vs Soll totals + delta
 *   • Subcategory table (txn categories + wizard labels side-by-side)
 *   • Last 10 matching transactions
 *
 * Triggered by clicking any SuperCategoryBar on the Budget page.
 */
import { useEffect } from "react";
import { X, TrendingDown, TrendingUp, Minus } from "lucide-react";
import { format } from "date-fns";
import { clsx } from "clsx";
import { formatCHF } from "@/lib/theme";
import type { SuperCategory } from "@/lib/categories";
import type { SubItem } from "./SuperCategoryBar";

export interface DrillDownTransaction {
  id: number;
  date: string;
  description: string;
  merchant_normalized?: string;
  amount: number;
  category?: string;
}

interface Props {
  superCategory: SuperCategory;
  actual?: number;
  planned?: number;
  months: number;
  subItems?: SubItem[];
  transactions?: DrillDownTransaction[];
  onClose: () => void;
  onEditWizard?: () => void;
  onEditTransactions?: () => void;
}

export default function CategoryDrillDown({
  superCategory,
  actual,
  planned,
  months,
  subItems,
  transactions,
  onClose,
  onEditWizard,
  onEditTransactions,
}: Props) {
  const hasActual  = actual  !== undefined && actual  > 0;
  const hasPlanned = planned !== undefined && planned > 0;
  const delta      = hasActual && hasPlanned ? actual! - planned! : undefined;
  const deltaPct   = delta !== undefined && hasPlanned ? (delta / planned!) * 100 : undefined;
  const isOver     = delta !== undefined && delta > 0;

  const trackMax  = Math.max(actual ?? 0, planned ?? 0);
  const actualPct = trackMax > 0 ? Math.min(100, ((actual ?? 0) / trackMax) * 100) : 0;

  // Close on Escape
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose]);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-lg bg-slate-900 border-l border-slate-700 flex flex-col z-50 shadow-2xl animate-slide-in-right">

        {/* ── Header ─────────────────────────────── */}
        <div className="shrink-0 px-5 py-4 border-b border-slate-700 bg-slate-800/90">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                style={{ backgroundColor: superCategory.color + "22" }}
              >
                <superCategory.icon className="w-5 h-5" style={{ color: superCategory.color }} />
              </span>
              <div className="min-w-0">
                <h2 className="text-text-primary font-semibold text-base truncate">
                  {superCategory.label}
                </h2>
                <p className="text-text-tertiary text-xs mt-0.5">
                  {months > 1 ? `${months} Monate` : "Aktueller Monat"}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* ── Scrollable body ─────────────────────── */}
        <div className="flex-1 overflow-y-auto">

          {/* ── Ist vs Soll totals ───────────────── */}
          <div className="px-5 py-4 border-b border-slate-800">
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div className="bg-slate-800 rounded-xl px-3 py-2.5">
                <p className="text-text-tertiary text-xs mb-1">IST (Historisch)</p>
                <p
                  className={clsx(
                    "text-lg font-mono font-semibold",
                    isOver ? "text-loss" : "text-text-primary",
                  )}
                >
                  {hasActual ? formatCHF(actual!) : "—"}
                </p>
              </div>
              <div className="bg-slate-800 rounded-xl px-3 py-2.5">
                <p className="text-text-tertiary text-xs mb-1">SOLL (Empirisch)</p>
                <p className="text-lg font-mono font-semibold text-text-secondary">
                  {hasPlanned ? formatCHF(planned!) : "—"}
                </p>
              </div>
            </div>

            {/* Visualisierung */}
            <div className="h-2.5 bg-slate-700 rounded-full overflow-hidden mb-2">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${actualPct}%`,
                  backgroundColor: isOver ? "#f87171" : superCategory.color,
                  opacity: 0.85,
                }}
              />
            </div>

            {delta !== undefined && deltaPct !== undefined && (
              <div className={clsx(
                "flex items-center gap-1.5 text-sm font-medium",
                isOver ? "text-loss" : "text-gain",
              )}>
                {isOver
                  ? <TrendingUp className="w-4 h-4" />
                  : delta < 0
                    ? <TrendingDown className="w-4 h-4" />
                    : <Minus className="w-4 h-4" />}
                {isOver ? "+" : ""}
                {formatCHF(delta)} ({isOver ? "+" : ""}{deltaPct.toFixed(1)}%)
                <span className="text-text-tertiary text-xs font-normal">
                  {isOver ? "über Budget" : "unter Budget"}
                </span>
              </div>
            )}

            {months > 1 && (hasActual || hasPlanned) && (
              <p className="text-text-disabled text-xs mt-1">
                Ø {hasActual ? formatCHF(actual! / months) : "—"} / Monat (Ist)
                {hasPlanned && ` · ${formatCHF(planned! / months)} / Monat (Soll)`}
              </p>
            )}
          </div>

          {/* ── Subcategories ────────────────────── */}
          {subItems && subItems.length > 0 && (
            <div className="px-5 py-4 border-b border-slate-800">
              <h3 className="text-text-secondary text-xs font-semibold uppercase tracking-wide mb-3">
                Unterkategorien
              </h3>
              <div className="space-y-2">
                {subItems.map((sub) => {
                  const subMax = Math.max(sub.actual ?? 0, sub.planned ?? 0, 1);
                  const subActPct = sub.actual ? Math.min(100, (sub.actual / subMax) * 100) : 0;
                  return (
                    <div key={sub.label}>
                      <div className="flex items-center justify-between mb-1 gap-2">
                        <span className="text-text-secondary text-xs truncate flex-1">{sub.label}</span>
                        <div className="flex items-center gap-2 shrink-0 text-xs font-mono">
                          {sub.actual !== undefined && (
                            <span className="text-text-primary">{formatCHF(sub.actual)}</span>
                          )}
                          {sub.actual !== undefined && sub.planned !== undefined && (
                            <span className="text-text-disabled">/</span>
                          )}
                          {sub.planned !== undefined && (
                            <span className="text-text-tertiary">{formatCHF(sub.planned)}</span>
                          )}
                          {/* Source badge */}
                          {sub.source && (
                            <span className={clsx(
                              "text-xs px-1.5 py-0.5 rounded-full",
                              sub.source === "wizard"
                                ? "bg-violet-500/15 text-violet-400"
                                : sub.source === "txn"
                                  ? "bg-sky-500/15 text-sky-400"
                                  : "bg-emerald-500/15 text-emerald-400",
                            )}>
                              {sub.source === "wizard" ? "Emp." : sub.source === "txn" ? "Hist." : "Komb."}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="h-1 bg-slate-700 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${subActPct}%`,
                            backgroundColor: superCategory.color,
                            opacity: 0.7,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Recent transactions ──────────────── */}
          {transactions && transactions.length > 0 && (
            <div className="px-5 py-4">
              <h3 className="text-text-secondary text-xs font-semibold uppercase tracking-wide mb-3">
                Transaktionen
              </h3>
              <div className="space-y-2">
                {transactions.slice(0, 12).map((txn) => (
                  <div
                    key={txn.id}
                    className="flex items-center justify-between py-1.5 border-b border-slate-800/50 last:border-0"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-text-primary text-xs font-medium truncate">
                        {txn.merchant_normalized || txn.description}
                      </p>
                      <p className="text-text-tertiary text-xs">
                        {format(new Date(txn.date), "dd.MM.yyyy")}
                        {txn.category && ` · ${txn.category}`}
                      </p>
                    </div>
                    <span
                      className={clsx(
                        "text-xs font-mono shrink-0 ml-3",
                        txn.amount >= 0 ? "text-gain" : "text-loss",
                      )}
                    >
                      {txn.amount >= 0 ? "+" : ""}{formatCHF(txn.amount)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(!transactions || transactions.length === 0) && (
            <p className="text-text-tertiary text-sm text-center py-10 px-5">
              Keine Transaktionen in diesem Zeitraum für {superCategory.label}.
            </p>
          )}
        </div>

        {/* ── Footer actions ──────────────────────── */}
        <div className="shrink-0 border-t border-slate-700 bg-slate-800 px-5 py-3 flex gap-2">
          {onEditTransactions && (
            <button
              type="button"
              onClick={onEditTransactions}
              className="flex-1 btn-secondary text-xs"
            >
              Reale Angaben bearbeiten
            </button>
          )}
          {onEditWizard && (
            <button
              type="button"
              onClick={onEditWizard}
              className="flex-1 btn-secondary text-xs"
            >
              Empirische Angaben bearbeiten
            </button>
          )}
        </div>
      </div>
    </>
  );
}
