/**
 * ExpenseDetailPanel
 *
 * Slide-in panel triggered by clicking the "Ausgaben" KPI tile.
 * Shows a complete breakdown of ALL expenses (including sparen / Kontoübertrag)
 * grouped by supercategory and sub-category so the user can see exactly which
 * transactions contribute to the total.
 */
import { useMemo, useEffect } from "react";
import { WarningTriangle, Xmark } from "@/lib/icons";
import { clsx } from "clsx";
import { formatCHF } from "@/lib/theme";
import type { SuperCategory } from "@/lib/categories";

export interface ExpenseTxnEntry {
  amount: number;
  category?: string;
}

interface ScGroup {
  sc: SuperCategory;
  total: number;
  subs: { label: string; total: number }[];
  isSavings: boolean;
}

interface Props {
  transactions: ExpenseTxnEntry[];
  resolveSuperCategory: (cat: string, isWizard?: boolean) => SuperCategory;
  /** KPI value from stats API (may differ from txn-list total; shown for comparison) */
  statsExpenses?: number;
  periodLabel: string;
  excludeTransfers: boolean;
  onClose: () => void;
}

export default function ExpenseDetailPanel({
  transactions,
  resolveSuperCategory,
  statsExpenses,
  periodLabel,
  excludeTransfers,
  onClose,
}: Props) {
  // Close on Escape
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose]);

  const { groups, grandTotal } = useMemo(() => {
    const scMap = new Map<string, { sc: SuperCategory; total: number; subs: Map<string, number> }>();
    for (const t of transactions) {
      if (t.amount >= 0) continue;
      const sc = resolveSuperCategory(t.category || "");
      const abs = -t.amount;
      if (!scMap.has(sc.id)) scMap.set(sc.id, { sc, total: 0, subs: new Map() });
      const entry = scMap.get(sc.id)!;
      entry.total += abs;
      const key = t.category || "Unkategorisiert";
      entry.subs.set(key, (entry.subs.get(key) ?? 0) + abs);
    }

    const groups: ScGroup[] = [...scMap.values()]
      .map(({ sc, total, subs }) => ({
        sc,
        total,
        isSavings: sc.id === "sparen",
        subs: [...subs.entries()]
          .map(([label, total]) => ({ label, total }))
          .sort((a, b) => b.total - a.total),
      }))
      .sort((a, b) => b.total - a.total);

    const grandTotal = groups.reduce((s, g) => s + g.total, 0);
    return { groups, grandTotal };
  }, [transactions, resolveSuperCategory]);

  // Discrepancy between stats API and txn-list total (may differ due to UTC offsets / > 2000 txns)
  const discrepancy = statsExpenses !== undefined ? Math.abs(statsExpenses - grandTotal) : 0;
  const hasDiscrepancy = discrepancy > 0.5;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" onClick={onClose} />

      {/* Panel */}
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-lg bg-bg-surface border-l border-border flex flex-col z-50 shadow-2xl animate-slide-in-right">

        {/* ── Header ───────────────────────────── */}
        <div className="shrink-0 px-5 py-4 border-b border-border bg-bg-surface2/90">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-text-primary font-semibold text-base">Ausgaben-Aufschlüsselung</h2>
              <p className="text-text-tertiary text-xs mt-0.5">{periodLabel}</p>
            </div>
            <button
              onClick={onClose}
              className="shrink-0 p-1.5 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
            >
              <Xmark className="w-5 h-5" />
            </button>
          </div>

          {/* Total */}
          <div className="mt-3 flex items-baseline gap-3">
            <span className="text-2xl font-mono font-semibold text-text-primary">
              {formatCHF(grandTotal)}
            </span>
            {excludeTransfers && (
              <span className="text-amber-400 text-xs">Kontoüberträge ausgeblendet</span>
            )}
          </div>

          {/* Warning if stats API total differs */}
          {hasDiscrepancy && (
            <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-400/80 bg-amber-500/10 rounded-lg px-2.5 py-1.5">
              <WarningTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                KPI-Kachel zeigt {formatCHF(statsExpenses!)} (aus der Stats-API inkl. alle Transaktionen).
                Diese Ansicht basiert auf den zuletzt geladenen {transactions.length} Transaktionen.
              </span>
            </div>
          )}
        </div>

        {/* ── Body ─────────────────────────────── */}
        <div className="flex-1 overflow-y-auto divide-y divide-border-subtle">
          {groups.length === 0 && (
            <p className="text-text-tertiary text-sm text-center py-12">
              Keine Ausgaben im gewählten Zeitraum.
            </p>
          )}

          {groups.map(({ sc, total, subs, isSavings }) => {
            const pct = grandTotal > 0 ? (total / grandTotal) * 100 : 0;
            return (
              <div key={sc.id} className={clsx("px-5 py-3.5", isSavings && "bg-amber-500/5")}>
                {/* SC header row */}
                <div className="flex items-center justify-between mb-2 gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="w-6 h-6 rounded-md flex items-center justify-center shrink-0"
                      style={{ backgroundColor: sc.color + "22" }}
                    >
                      <sc.icon className="w-3.5 h-3.5" style={{ color: sc.color }} />
                    </span>
                    <span className="text-text-primary text-sm font-medium truncate">
                      {sc.label}
                    </span>
                    {isSavings && (
                      <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 shrink-0">
                        Kontoübertrag / Sparen
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0 text-xs font-mono">
                    <span className="text-text-tertiary tabular-nums">{pct.toFixed(1)}%</span>
                    <span className="text-text-primary font-semibold">{formatCHF(total)}</span>
                  </div>
                </div>

                {/* SC bar */}
                <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden mb-3">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${pct}%`, backgroundColor: sc.color, opacity: isSavings ? 0.45 : 0.75 }}
                  />
                </div>

                {/* Sub-categories */}
                <div className="space-y-1.5">
                  {subs.slice(0, 10).map((sub) => {
                    const subPct = total > 0 ? (sub.total / total) * 100 : 0;
                    return (
                      <div key={sub.label} className="flex items-center gap-3">
                        <span className="text-text-tertiary text-xs truncate flex-1 min-w-0">
                          {sub.label}
                        </span>
                        <div className="flex items-center gap-2 shrink-0">
                          {/* Mini bar */}
                          <div className="w-20 h-1 bg-bg-elevated rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full"
                              style={{ width: `${subPct}%`, backgroundColor: sc.color, opacity: 0.6 }}
                            />
                          </div>
                          <span className="text-text-secondary text-xs font-mono w-24 text-right tabular-nums">
                            {formatCHF(sub.total)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                  {subs.length > 10 && (
                    <p className="text-text-disabled text-xs pl-0 mt-1">
                      +{subs.length - 10} weitere Kategorien
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Footer total ─────────────────────── */}
        <div className="shrink-0 border-t border-border bg-bg-surface2 px-5 py-3">
          <div className="flex items-center justify-between text-sm font-semibold">
            <span className="text-text-secondary">Total Ausgaben</span>
            <span className="text-text-primary font-mono">{formatCHF(grandTotal)}</span>
          </div>
          {groups.some((g) => g.isSavings) && !excludeTransfers && (
            <p className="text-amber-400/70 text-xs mt-1">
              Inkl. {formatCHF(groups.find((g) => g.isSavings)!.total)} Kontoüberträge/Sparen — Toggle aktivieren um diese auszublenden.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
