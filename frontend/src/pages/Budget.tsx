/**
 * Budget Analysis Page — v2
 *
 * Layout:
 *   1. Header + GranularityNavigator
 *   2. Frequency-filter chips
 *   3. 3 KPI cards (Netto, Ausgaben Ist/Soll, Ausschöpfung %)
 *   4. SuperCategory bars (click → CategoryDrillDown panel)
 *   5. Peer-comparison section (collapsed by default)
 */
import { useState, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, subMonths } from "date-fns";
import { clsx } from "clsx";
import {
  TrendingDown, TrendingUp, Minus, ChevronDown, ChevronUp,
  Lightbulb, Target, Wallet,
} from "lucide-react";

import { budgetsApi, transactionsApi, budgetApi } from "@/lib/api";
import { formatCHF } from "@/lib/theme";
import GranularityNavigator from "@/components/GranularityNavigator";
import WizardBudgetSidebar from "@/components/WizardBudgetSidebar";
import TransactionSidebarEditor from "@/components/TransactionSidebarEditor";
import SuperCategoryBar from "@/components/budget/SuperCategoryBar";
import CategoryDrillDown from "@/components/budget/CategoryDrillDown";
import type { SubItem } from "@/components/budget/SuperCategoryBar";
import type { DrillDownTransaction } from "@/components/budget/CategoryDrillDown";
import { computeDateRange, TimeGranularity } from "@/lib/granularity";
import {
  SUPER_CATEGORIES,
  resolveSuperCategory,
  type SuperCategory,
} from "@/lib/categories";
import type { MultiAnalysisResult } from "@/types/budgetAnalysis";

// ── Frequency filter ──────────────────────────────────────────
const FREQ_OPTIONS = [
  { key: "monthly",    label: "Monatlich"    },
  { key: "quarterly",  label: "Quartalsweise" },
  { key: "halfyearly", label: "Halbjährlich"  },
  { key: "yearly",     label: "Jährlich"      },
  { key: "weekly",     label: "Wöchentlich"   },
  { key: "einmalig",   label: "Einmalig"      },
] as const;

function matchesFreq(
  t: { is_recurring?: boolean; periodicity?: string },
  freqs: Set<string>,
): boolean {
  const p = t.periodicity ?? "";
  const rec = !!t.is_recurring;
  if (!rec || !p) return freqs.has("einmalig");
  if (p === "weekly")     return freqs.has("weekly");
  if (p === "monthly")    return freqs.has("monthly");
  if (p === "quarterly")  return freqs.has("quarterly");
  if (p === "halfyearly") return freqs.has("halfyearly");
  if (p === "yearly")     return freqs.has("yearly");
  return freqs.has("einmalig");
}

// ── Aggregated row (per supercategory) ────────────────────────
interface SuperRow {
  sc: SuperCategory;
  actual: number;        // freq-filtered real transactions
  planned: number;       // wizard planned × months (0 if no wizard)
  subItems: SubItem[];   // subcategory detail for drill-down
  transactions: DrillDownTransaction[];
}

// ── Page ──────────────────────────────────────────────────────

export default function Budget() {
  // ── Time navigation ─────────────────────────────────────────
  const [granularity, setGranularity] = useState<TimeGranularity>("ytd");
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const range = useMemo(() => computeDateRange(granularity, anchor), [granularity, anchor]);
  const periodStart = format(range.from, "yyyy-MM-dd");
  const periodEnd   = format(range.to,   "yyyy-MM-dd");

  const months = useMemo(
    () => Math.max(1,
      (range.to.getFullYear() - range.from.getFullYear()) * 12 +
      (range.to.getMonth() - range.from.getMonth()) + 1,
    ),
    [range],
  );

  // ── Filter state ────────────────────────────────────────────
  const [selectedFreqs, setSelectedFreqs] = useState<Set<string>>(
    () => new Set(["monthly", "quarterly", "halfyearly", "yearly", "weekly", "einmalig"]),
  );
  const [showPeer, setShowPeer] = useState(false);
  const [drillDown, setDrillDown] = useState<SuperRow | null>(null);
  const [showWizardEditor, setShowWizardEditor] = useState(false);
  const [showTxnEditor, setShowTxnEditor] = useState(false);
  const [showSonstiges, setShowSonstiges] = useState(false);

  function toggleFreq(key: string) {
    setSelectedFreqs((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  // ── Data queries ────────────────────────────────────────────
  // Wizard (planned) budgets — latest batch
  const { data: wizardBudgets } = useQuery({
    queryKey: ["wizard-budgets-budget"],
    queryFn: () => budgetsApi.list().then((r) => r.data),
    staleTime: 30_000,
  });

  // Period transactions (for freq-filtered actuals + drill-down)
  const { data: periodTransactions = [] } = useQuery({
    queryKey: ["period-transactions-budget", periodStart, periodEnd],
    queryFn: async () => {
      const sixMonthsAgo = format(subMonths(anchor, 6), "yyyy-MM-dd");
      return transactionsApi
        .list({ start: sixMonthsAgo, end: periodEnd, limit: 2000 })
        .then((r) => r.data);
    },
  });

  // Capabilities (wizard_available / peer_data_available)
  const { data: capabilities } = useQuery<MultiAnalysisResult>({
    queryKey: ["budget-capabilities", periodStart, periodEnd],
    queryFn: () =>
      budgetApi
        .multiAnalysis({ mode: "past", start: periodStart, end: periodEnd })
        .then((r) => r.data),
    staleTime: 60_000,
  });

  // Peer analysis (only when toggled on)
  const { data: peerData } = useQuery<MultiAnalysisResult>({
    queryKey: ["peer-analysis-budget", periodStart, periodEnd],
    queryFn: () =>
      budgetApi
        .multiAnalysis({ mode: "peer", start: periodStart, end: periodEnd })
        .then((r) => r.data),
    enabled: showPeer && capabilities?.peer_data_available === true,
    staleTime: 60_000,
  });

  // ── Computed values ─────────────────────────────────────────

  // Filter period transactions to the range + frequency selection
  const filteredTxns = useMemo(
    () =>
      (periodTransactions as Array<{
        id: number; date: string; amount: number; category?: string;
        description: string; merchant_normalized?: string;
        is_recurring?: boolean; periodicity?: string;
      }>).filter((t) => {
        const d = new Date(t.date);
        return d >= range.from && d <= range.to && matchesFreq(t, selectedFreqs);
      }),
    [periodTransactions, range, selectedFreqs],
  );

  // KPI stats from freq-filtered transactions
  const kpi = useMemo(() => {
    const income   = filteredTxns.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
    const expenses = filteredTxns.filter((t) => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
    return { income, expenses, net: income - expenses };
  }, [filteredTxns]);

  // Wizard planned amounts: notes → monthly CHF (latest batch)
  const wizardPlanned = useMemo((): Map<string, number> => {
    if (!wizardBudgets || !Array.isArray(wizardBudgets)) return new Map();
    const withNotes = (wizardBudgets as Array<{ notes: string | null; amount: number; created_at?: string }>)
      .filter((b) => b.notes);
    if (!withNotes.length) return new Map();
    const maxTs = withNotes.reduce(
      (max, b) => ((b.created_at || "") > max ? b.created_at || "" : max),
      "",
    );
    const latest = withNotes.filter((b) => b.created_at === maxTs);
    const map = new Map<string, number>();
    for (const b of latest) {
      const label = b.notes!;
      map.set(label, (map.get(label) ?? 0) + b.amount * months);
    }
    return map;
  }, [wizardBudgets, months]);

  // Actual expenses grouped by supercategory
  const actualBySuperCat = useMemo((): Map<string, { total: number; subs: Map<string, number> }> => {
    const m = new Map<string, { total: number; subs: Map<string, number> }>();
    for (const t of filteredTxns) {
      if (t.amount >= 0) continue;
      const sc = resolveSuperCategory(t.category || "");
      if (!m.has(sc.id)) m.set(sc.id, { total: 0, subs: new Map() });
      const entry = m.get(sc.id)!;
      entry.total += Math.abs(t.amount);
      const cat = t.category || "Sonstiges";
      entry.subs.set(cat, (entry.subs.get(cat) ?? 0) + Math.abs(t.amount));
    }
    return m;
  }, [filteredTxns]);

  // Planned expenses grouped by supercategory
  const plannedBySuperCat = useMemo((): Map<string, { total: number; subs: Map<string, number> }> => {
    const m = new Map<string, { total: number; subs: Map<string, number> }>();
    for (const [label, periodAmt] of wizardPlanned) {
      const sc = resolveSuperCategory(label, true);
      if (sc.id === "sparen") continue;
      if (!m.has(sc.id)) m.set(sc.id, { total: 0, subs: new Map() });
      const entry = m.get(sc.id)!;
      entry.total += periodAmt;
      entry.subs.set(label, (entry.subs.get(label) ?? 0) + periodAmt);
    }
    return m;
  }, [wizardPlanned]);

  // Total planned expenses (for budget-utilisation KPI)
  const totalPlanned = useMemo(
    () => [...plannedBySuperCat.values()].reduce((s, e) => s + e.total, 0),
    [plannedBySuperCat],
  );

  // Transactions grouped by supercategory id for drill-down
  const txnsBySuperCat = useMemo((): Map<string, DrillDownTransaction[]> => {
    const m = new Map<string, DrillDownTransaction[]>();
    for (const t of filteredTxns) {
      if (t.amount >= 0) continue;
      const sc = resolveSuperCategory(t.category || "");
      if (!m.has(sc.id)) m.set(sc.id, []);
      m.get(sc.id)!.push({
        id: t.id,
        date: t.date,
        description: t.description,
        merchant_normalized: t.merchant_normalized,
        amount: t.amount,
        category: t.category,
      });
    }
    // Sort each group by date desc
    for (const [, txns] of m) txns.sort((a, b) => b.date.localeCompare(a.date));
    return m;
  }, [filteredTxns]);

  // Build unified SuperRow list
  const superRows = useMemo((): SuperRow[] => {
    const allScIds = new Set([
      ...actualBySuperCat.keys(),
      ...plannedBySuperCat.keys(),
    ]);

    const rows: SuperRow[] = [];
    for (const scId of allScIds) {
      const sc = SUPER_CATEGORIES.find((s) => s.id === scId);
      if (!sc || sc.id === "sparen") continue;

      const actEntry  = actualBySuperCat.get(scId);
      const planEntry = plannedBySuperCat.get(scId);
      const actual    = actEntry?.total  ?? 0;
      const planned   = planEntry?.total ?? 0;

      // Build sub-items (merge actual subs + planned subs)
      const subMap = new Map<string, SubItem>();
      for (const [label, amt] of actEntry?.subs ?? []) {
        subMap.set(label, { label, actual: amt, source: "txn" });
      }
      for (const [label, amt] of planEntry?.subs ?? []) {
        const existing = subMap.get(label);
        if (existing) {
          existing.planned = amt;
          existing.source  = "both";
        } else {
          subMap.set(label, { label, planned: amt, source: "wizard" });
        }
      }
      const subItems = [...subMap.values()].sort(
        (a, b) => (b.actual ?? b.planned ?? 0) - (a.actual ?? a.planned ?? 0),
      );

      rows.push({
        sc,
        actual,
        planned,
        subItems,
        transactions: txnsBySuperCat.get(scId) ?? [],
      });
    }

    return rows.sort((a, b) => (b.actual || b.planned) - (a.actual || a.planned));
  }, [actualBySuperCat, plannedBySuperCat, txnsBySuperCat]);

  // Separate "Sonstiges" and non-Sonstiges rows
  const mainRows     = superRows.filter((r) => r.sc.id !== "sonstiges");
  const sonstigesRow = superRows.find((r) => r.sc.id === "sonstiges");

  // Budget utilisation (actual / planned, capped for display)
  const utilisation = totalPlanned > 0
    ? Math.min(200, Math.round((kpi.expenses / totalPlanned) * 100))
    : null;

  // Open drill-down for a row
  const openDrillDown = useCallback((row: SuperRow) => setDrillDown(row), []);
  const closeDrillDown = useCallback(() => setDrillDown(null), []);

  // ── Render ───────────────────────────────────────────────────
  return (
    <div className="space-y-6 animate-fade-in">

      {/* ── Header ─────────────────────────────────────────── */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-display text-text-primary">Budgetanalyse</h1>
          <p className="text-text-tertiary text-sm mt-0.5">{range.label}</p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <GranularityNavigator
            granularity={granularity}
            anchor={anchor}
            onChange={(g, a) => { setGranularity(g); setAnchor(a); }}
          />
          {capabilities?.wizard_available && (
            <button
              type="button"
              onClick={() => setShowWizardEditor(true)}
              className="btn-secondary text-xs flex items-center gap-1.5"
            >
              Budgets bearbeiten
            </button>
          )}
        </div>
      </div>

      {/* ── Frequency filter chips ─────────────────────────── */}
      <div className="flex flex-wrap gap-2">
        {FREQ_OPTIONS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => toggleFreq(key)}
            className={clsx(
              "px-3 py-1.5 rounded-lg text-xs border transition-colors",
              selectedFreqs.has(key)
                ? "bg-accent/15 border-accent/40 text-accent"
                : "bg-bg-surface2 border-border text-text-tertiary hover:text-text-primary",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── KPI strip ──────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">

        {/* Netto */}
        <div className="card flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-text-tertiary text-xs uppercase tracking-wide">Netto-Überschuss</span>
            <div className="w-8 h-8 rounded-lg bg-bg-surface2 flex items-center justify-center">
              {kpi.net >= 0
                ? <TrendingUp className="w-4 h-4 text-gain" />
                : <TrendingDown className="w-4 h-4 text-loss" />}
            </div>
          </div>
          <p className={clsx(
            "text-2xl font-mono font-semibold",
            kpi.net >= 0 ? "text-gain" : "text-loss",
          )}>
            {kpi.net >= 0 ? "+" : ""}{formatCHF(kpi.net)}
          </p>
          <p className="text-text-tertiary text-xs">
            {formatCHF(kpi.income)} Einnahmen · {formatCHF(kpi.expenses)} Ausgaben
          </p>
        </div>

        {/* Ausgaben Ist vs Soll */}
        <div className="card flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-text-tertiary text-xs uppercase tracking-wide">Ausgaben</span>
            <div className="w-8 h-8 rounded-lg bg-bg-surface2 flex items-center justify-center">
              <Wallet className="w-4 h-4 text-text-tertiary" />
            </div>
          </div>
          <p className="text-2xl font-mono font-semibold text-text-primary">
            {formatCHF(kpi.expenses)}
          </p>
          {totalPlanned > 0 && (
            <div>
              <p className="text-text-tertiary text-xs mb-1">
                von {formatCHF(totalPlanned)} geplant
              </p>
              <div className="h-1.5 bg-bg-surface2 rounded-full overflow-hidden">
                <div
                  className={clsx(
                    "h-full rounded-full transition-all duration-500",
                    kpi.expenses > totalPlanned ? "bg-loss" : "bg-accent",
                  )}
                  style={{ width: `${Math.min(100, (kpi.expenses / totalPlanned) * 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Budget-Ausschöpfung */}
        <div className="card flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-text-tertiary text-xs uppercase tracking-wide">Ausschöpfung</span>
            <div className="w-8 h-8 rounded-lg bg-bg-surface2 flex items-center justify-center">
              <Target className="w-4 h-4 text-text-tertiary" />
            </div>
          </div>
          {utilisation !== null ? (
            <>
              <p className={clsx(
                "text-2xl font-mono font-semibold",
                utilisation > 100 ? "text-loss" : utilisation > 80 ? "text-warning" : "text-gain",
              )}>
                {utilisation}%
              </p>
              <p className="text-text-tertiary text-xs">
                {utilisation > 100
                  ? `${utilisation - 100}% über Budget`
                  : utilisation > 80
                    ? "Nahe am Limit"
                    : "Im grünen Bereich"}
              </p>
            </>
          ) : (
            <>
              <p className="text-2xl font-mono font-semibold text-text-disabled">—</p>
              <p className="text-text-tertiary text-xs">
                Kein Soll-Budget definiert
              </p>
            </>
          )}
        </div>
      </div>

      {/* ── Supercategory bars ─────────────────────────────── */}
      <div className="card !p-0 overflow-hidden">
        <div className="px-4 pt-4 pb-2 border-b border-border">
          <div className="flex items-baseline justify-between">
            <h2 className="text-text-primary font-semibold text-sm">Ausgaben-Kategorien</h2>
            <span className="text-text-tertiary text-xs">{range.label}</span>
          </div>
          {totalPlanned > 0 && (
            <div className="flex items-center gap-4 mt-2 text-xs text-text-tertiary">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-1.5 rounded-full bg-accent/60 inline-block" />
                Ist (Historisch)
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-1.5 rounded-full bg-white/20 inline-block" />
                Soll (Empirisch)
              </span>
            </div>
          )}
        </div>

        {mainRows.length === 0 && (
          <p className="text-text-tertiary text-sm text-center py-10">
            Keine Daten für den gewählten Zeitraum.
          </p>
        )}

        <div className="divide-y divide-border/40">
          {mainRows.map((row) => (
            <SuperCategoryBar
              key={row.sc.id}
              superCategory={row.sc}
              actual={row.actual > 0 ? row.actual : undefined}
              planned={row.planned > 0 ? row.planned : undefined}
              subItems={row.subItems}
              onClick={() => openDrillDown(row)}
            />
          ))}

          {/* Sonstiges (collapsed by default) */}
          {sonstigesRow && (
            <>
              <button
                type="button"
                className="w-full flex items-center justify-between px-4 py-2.5 text-text-tertiary hover:text-text-primary text-xs transition-colors"
                onClick={() => setShowSonstiges((v) => !v)}
              >
                <span className="flex items-center gap-1.5">
                  {showSonstiges ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  Sonstiges
                  {sonstigesRow.actual > 0 && ` · ${formatCHF(sonstigesRow.actual)}`}
                </span>
              </button>
              {showSonstiges && (
                <SuperCategoryBar
                  superCategory={sonstigesRow.sc}
                  actual={sonstigesRow.actual > 0 ? sonstigesRow.actual : undefined}
                  planned={sonstigesRow.planned > 0 ? sonstigesRow.planned : undefined}
                  subItems={sonstigesRow.subItems}
                  onClick={() => openDrillDown(sonstigesRow)}
                />
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Peer comparison (collapsed) ────────────────────── */}
      {capabilities?.peer_data_available && (
        <div className="card !p-0 overflow-hidden">
          <button
            type="button"
            className="w-full flex items-center justify-between px-4 py-3 text-sm hover:bg-bg-surface2 transition-colors"
            onClick={() => setShowPeer((v) => !v)}
          >
            <span className="flex items-center gap-2 text-text-secondary font-medium">
              <Lightbulb className="w-4 h-4 text-warning" />
              Peer-Vergleich (Schweizer Durchschnitt)
            </span>
            {showPeer ? <ChevronUp className="w-4 h-4 text-text-tertiary" /> : <ChevronDown className="w-4 h-4 text-text-tertiary" />}
          </button>

          {showPeer && peerData && (
            <div className="border-t border-border px-4 py-4 space-y-4">
              {peerData.peer_info && (
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-text-tertiary border-b border-border pb-3">
                  <span>Altersgruppe: <strong className="text-text-secondary">{peerData.peer_info.age_range}</strong></span>
                  <span>Haushalt: <strong className="text-text-secondary">{peerData.peer_info.household_type}</strong></span>
                  <span>Medianeinkommen: <strong className="text-text-secondary">{formatCHF(peerData.peer_info.median_income)}/Monat</strong></span>
                  <span>Sparquote Peers: <strong className="text-text-secondary">{peerData.peer_info.savings_rate_pct}%</strong></span>
                </div>
              )}
              <div className="space-y-3">
                {peerData.categories
                  .filter((c) => c.peer_benchmark != null && (c.actual ?? 0) > 0)
                  .sort((a, b) => (b.actual ?? 0) - (a.actual ?? 0))
                  .slice(0, 8)
                  .map((cat) => {
                    const sc = resolveSuperCategory(cat.category);
                    const peerMax = Math.max(cat.actual ?? 0, cat.peer_benchmark ?? 0, 1);
                    const actPct  = Math.min(100, ((cat.actual  ?? 0) / peerMax) * 100);
                    const peerPct = Math.min(100, ((cat.peer_benchmark ?? 0) / peerMax) * 100);
                    const isOver  = (cat.actual ?? 0) > (cat.peer_benchmark ?? 0);
                    return (
                      <div key={cat.category}>
                        <div className="flex items-center justify-between mb-1 text-xs">
                          <span className="text-text-secondary flex items-center gap-1">
                            <span>{sc.emoji}</span>{cat.category}
                          </span>
                          <div className="flex items-center gap-2 font-mono">
                            <span className={isOver ? "text-loss" : "text-text-primary"}>
                              {formatCHF(cat.actual ?? 0)}
                            </span>
                            <span className="text-text-disabled">/</span>
                            <span className="text-text-tertiary">Ø {formatCHF(cat.peer_benchmark ?? 0)}</span>
                          </div>
                        </div>
                        <div className="relative h-1.5 bg-bg-surface2 rounded-full overflow-hidden">
                          {/* Peer benchmark reference line */}
                          <div
                            className="absolute top-0 bottom-0 left-0 rounded-full opacity-30"
                            style={{ width: `${peerPct}%`, backgroundColor: sc.color }}
                          />
                          {/* Actual */}
                          <div
                            className="absolute top-0 bottom-0 left-0 rounded-full opacity-80"
                            style={{
                              width: `${actPct}%`,
                              backgroundColor: isOver ? "#f87171" : sc.color,
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
              </div>

              {/* Savings opportunities */}
              {peerData.opportunities && peerData.opportunities.length > 0 && (
                <div className="border-t border-border pt-3">
                  <p className="text-text-tertiary text-xs font-semibold uppercase tracking-wide mb-2">
                    Einspar-Potenzial
                  </p>
                  <div className="space-y-2">
                    {peerData.opportunities.slice(0, 3).map((opp) => (
                      <div
                        key={opp.category}
                        className="flex items-start gap-2 bg-warning/5 border border-warning/20 rounded-lg px-3 py-2"
                      >
                        <Lightbulb className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
                        <p className="text-text-secondary text-xs">{opp.action}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Drill-down panel ───────────────────────────────── */}
      {drillDown && (
        <CategoryDrillDown
          superCategory={drillDown.sc}
          actual={drillDown.actual > 0 ? drillDown.actual : undefined}
          planned={drillDown.planned > 0 ? drillDown.planned : undefined}
          months={months}
          subItems={drillDown.subItems}
          transactions={drillDown.transactions}
          onClose={closeDrillDown}
          onEditWizard={capabilities?.wizard_available ? () => {
            closeDrillDown();
            setShowWizardEditor(true);
          } : undefined}
          onEditTransactions={() => {
            closeDrillDown();
            setShowTxnEditor(true);
          }}
        />
      )}

      {/* ── Wizard budget sidebar ──────────────────────────── */}
      {showWizardEditor && (
        <WizardBudgetSidebar
          periodLabel={range.label}
          months={months}
          onClose={() => setShowWizardEditor(false)}
        />
      )}

      {/* ── Transaction sidebar editor ─────────────────────── */}
      {showTxnEditor && (
        <TransactionSidebarEditor
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          transactions={filteredTxns as any[]}
          periodLabel={range.label}
          onClose={() => setShowTxnEditor(false)}
        />
      )}
    </div>
  );
}
