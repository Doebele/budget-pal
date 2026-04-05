/**
 * Budget Analysis Page — v2
 *
 * Data sources:
 *   • transactionsApi.stats()    → KPI cards + actual category totals (authoritative)
 *   • budgetsApi.list()          → wizard planned amounts
 *   • transactionsApi.list()     → per-transaction drill-down list only
 *
 * Layout:
 *   1. Header + GranularityNavigator
 *   2. Frequency-filter chips (affects drill-down display)
 *   3. 3 KPI cards (Netto, Ausgaben Ist/Soll, Ausschöpfung %)
 *   4. SuperCategory bars (Ist = stats, Soll = wizard × months)
 *   5. Peer-comparison section (collapsed by default)
 */
import { useState, useMemo, useCallback, lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { clsx } from "clsx";
import {
  TrendingDown, TrendingUp, ChevronDown, ChevronUp,
  Lightbulb, Target, Wallet, BarChart3, Gauge,
} from "lucide-react";

const CategoryGaugeChart = lazy(
  () => import("@/components/charts/CategoryGaugeChart"),
);

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
import { deduplicateWizardBatch } from "@/lib/wizardUtils";
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

// ── Aggregated row (per supercategory) ────────────────────────
interface SuperRow {
  sc: SuperCategory;
  actual: number;
  planned: number;
  subItems: SubItem[];
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
      (range.to.getMonth()   - range.from.getMonth()) + 1,
    ),
    [range],
  );

  // ── UI state ────────────────────────────────────────────────
  const [selectedFreqs, setSelectedFreqs] = useState<Set<string>>(
    () => new Set(["monthly", "quarterly", "halfyearly", "yearly", "weekly", "einmalig"]),
  );
  const [showPeer, setShowPeer] = useState(false);
  const [drillDown, setDrillDown] = useState<SuperRow | null>(null);
  const [showWizardEditor, setShowWizardEditor] = useState(false);
  const [wizardEditorScId, setWizardEditorScId] = useState<string | undefined>();
  const [showTxnEditor, setShowTxnEditor] = useState(false);
  const [txnEditorRows, setTxnEditorRows] = useState<DrillDownTransaction[]>([]);
  const [showSonstiges, setShowSonstiges] = useState(false);
  const [gaugeView, setGaugeView] = useState(false);

  function toggleFreq(key: string) {
    setSelectedFreqs((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  // ── Data queries ─────────────────────────────────────────────

  // Primary source for KPI + actual category totals
  const { data: stats } = useQuery({
    queryKey: ["transaction-stats-budget", periodStart, periodEnd],
    queryFn: () =>
      transactionsApi.stats({ start: periodStart, end: periodEnd }).then((r) => r.data),
    staleTime: 30_000,
  });

  // Wizard (planned) budgets
  const { data: wizardBudgets } = useQuery({
    queryKey: ["wizard-budgets-budget"],
    queryFn: () => budgetsApi.list().then((r) => r.data),
    staleTime: 30_000,
  });

  // Per-transaction list (drill-down only; limited to current period)
  const { data: periodTransactions = [] } = useQuery({
    queryKey: ["period-transactions-drilldown", periodStart, periodEnd],
    queryFn: () =>
      transactionsApi
        .list({ start: periodStart, end: periodEnd, limit: 500 })
        .then((r) => r.data),
    staleTime: 30_000,
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

  // Peer analysis (loaded only when panel opened)
  const { data: peerData } = useQuery<MultiAnalysisResult>({
    queryKey: ["peer-analysis-budget", periodStart, periodEnd],
    queryFn: () =>
      budgetApi
        .multiAnalysis({ mode: "peer", start: periodStart, end: periodEnd })
        .then((r) => r.data),
    enabled: (showPeer || gaugeView) && capabilities?.peer_data_available === true,
    staleTime: 60_000,
  });

  // ── KPI from stats ───────────────────────────────────────────
  const kpi = useMemo(() => ({
    income:   stats?.total_income   ?? 0,
    expenses: stats?.total_expenses ?? 0,
    net: (stats?.total_income ?? 0) - (stats?.total_expenses ?? 0),
  }), [stats]);

  // ── Actual by supercategory: from stats.top_categories ───────
  const actualBySuperCat = useMemo((): Map<string, { total: number; subs: Map<string, number> }> => {
    const m = new Map<string, { total: number; subs: Map<string, number> }>();
    for (const cat of (stats?.top_categories || [])) {
      if (cat.total <= 0) continue;
      const sc = resolveSuperCategory(cat.category, false);
      if (sc.id === "sparen") continue;

      if (!m.has(sc.id)) m.set(sc.id, { total: 0, subs: new Map() });
      const entry = m.get(sc.id)!;
      entry.total += cat.total;
      entry.subs.set(cat.category, (entry.subs.get(cat.category) ?? 0) + cat.total);
    }
    return m;
  }, [stats]);

  // ── Wizard planned amounts by label → period CHF ─────────────
  const wizardPlanned = useMemo((): Map<string, number> => {
    if (!wizardBudgets || !Array.isArray(wizardBudgets)) return new Map();
    const withNotes = (wizardBudgets as Array<{ id: number; notes: string | null; amount: number; created_at?: string }>)
      .filter((b) => b.notes && b.notes.trim() !== "");
    if (!withNotes.length) return new Map();

    // Deduplicate: latest batch by created_at, fallback to highest-id per label
    const latest = deduplicateWizardBatch(withNotes);

    const map = new Map<string, number>();
    for (const b of latest) {
      const label = b.notes!;
      // Use set (not accumulate) — after dedup each label appears at most once
      map.set(label, b.amount * months);
    }
    return map;
  }, [wizardBudgets, months]);

  // ── Planned by supercategory ──────────────────────────────────
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

  const totalPlanned = useMemo(
    () => [...plannedBySuperCat.values()].reduce((s, e) => s + e.total, 0),
    [plannedBySuperCat],
  );

  // ── Peer benchmark aggregated to supercategory level ──────────
  const peerBySuperCat = useMemo((): Map<string, number> => {
    if (!peerData) return new Map();
    const m = new Map<string, number>();
    for (const cat of (peerData.categories ?? [])) {
      if (!cat.peer_benchmark || cat.peer_benchmark <= 0) continue;
      const sc = resolveSuperCategory(cat.category, false);
      if (sc.id === "sparen") continue;
      m.set(sc.id, (m.get(sc.id) ?? 0) + cat.peer_benchmark);
    }
    return m;
  }, [peerData]);

  // ── Transactions per supercategory for drill-down ─────────────
  const txnsBySuperCat = useMemo((): Map<string, DrillDownTransaction[]> => {
    const m = new Map<string, DrillDownTransaction[]>();
    for (const t of (periodTransactions as Array<{
      id: number; date: string; amount: number; category?: string;
      description: string; merchant_normalized?: string;
    }>)) {
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
    for (const [, txns] of m) txns.sort((a, b) => b.date.localeCompare(a.date));
    return m;
  }, [periodTransactions]);

  // ── Unified SuperRow list ─────────────────────────────────────
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

      // Merge sub-items from actual and planned
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

  const mainRows     = superRows.filter((r) => r.sc.id !== "sonstiges");
  const sonstigesRow = superRows.find((r) => r.sc.id === "sonstiges");

  // ── Gauge rows: superRows + peer values ───────────────────────
  const gaugeRows = useMemo(
    () =>
      mainRows.map((r) => ({
        sc:      r.sc,
        actual:  r.actual,
        planned: r.planned,
        peer:    peerBySuperCat.get(r.sc.id),
      })),
    [mainRows, peerBySuperCat],
  );

  const hasPeerGauge =
    capabilities?.peer_data_available === true && peerBySuperCat.size > 0;

  const utilisation = totalPlanned > 0
    ? Math.min(200, Math.round((kpi.expenses / totalPlanned) * 100))
    : null;

  const openDrillDown  = useCallback((row: SuperRow) => setDrillDown(row), []);
  const closeDrillDown = useCallback(() => setDrillDown(null), []);

  const hasSomeData = mainRows.length > 0 || (sonstigesRow != null);

  // ── Render ────────────────────────────────────────────────────
  return (
    <div className="space-y-6 animate-fade-in">

      {/* ── Header ─────────────────────────────── */}
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
              onClick={() => { setWizardEditorScId(undefined); setShowWizardEditor(true); }}
              className="btn-secondary text-xs flex items-center gap-1.5"
            >
              Budgets bearbeiten
            </button>
          )}
        </div>
      </div>

      {/* ── Frequency filter chips ──────────────── */}
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
        <span className="text-text-disabled text-xs self-center ml-1">
          (Filter gilt für Drill-down Transaktionen)
        </span>
      </div>

      {/* ── KPI strip ──────────────────────────── */}
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
          {totalPlanned > 0 ? (
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
          ) : (
            <p className="text-text-tertiary text-xs">
              {capabilities?.wizard_available ? "Empirische Budgets geladen…" : "Kein Soll-Budget definiert"}
            </p>
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
                  : utilisation > 80 ? "Nahe am Limit" : "Im grünen Bereich"}
              </p>
            </>
          ) : (
            <>
              <p className="text-2xl font-mono font-semibold text-text-disabled">—</p>
              <p className="text-text-tertiary text-xs">Kein Soll-Budget definiert</p>
            </>
          )}
        </div>
      </div>

      {/* ── Ausgaben-Kategorien (bar / gauge toggle) ── */}
      <div className="card !p-0 overflow-hidden">

        {/* Card header */}
        <div className="px-4 pt-4 pb-2 border-b border-border">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-text-primary font-semibold text-sm">Ausgaben-Kategorien</h2>

            <div className="flex items-center gap-2">
              <span className="text-text-tertiary text-xs hidden sm:inline">{range.label}</span>

              {/* View toggle: Balken / Gauge */}
              <div className="flex items-center rounded-lg border border-border overflow-hidden">
                <button
                  type="button"
                  title="Balkenansicht"
                  onClick={() => setGaugeView(false)}
                  className={clsx(
                    "px-2 py-1.5 transition-colors",
                    !gaugeView
                      ? "bg-accent/20 text-accent"
                      : "text-text-tertiary hover:text-text-secondary",
                  )}
                >
                  <BarChart3 className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  title="Gauge-Ansicht"
                  onClick={() => setGaugeView(true)}
                  className={clsx(
                    "px-2 py-1.5 border-l border-border transition-colors",
                    gaugeView
                      ? "bg-accent/20 text-accent"
                      : "text-text-tertiary hover:text-text-secondary",
                  )}
                >
                  <Gauge className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>

          {/* Bar-view legend */}
          {!gaugeView && totalPlanned > 0 && (
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

        {!hasSomeData && (
          <p className="text-text-tertiary text-sm text-center py-10">
            Keine Daten für den gewählten Zeitraum.{" "}
            {!capabilities?.wizard_available && (
              <span>
                Starte den{" "}
                <a href="/wizard" className="text-accent underline">Setup-Wizard</a>{" "}
                um empirische Budgets zu erfassen.
              </span>
            )}
          </p>
        )}

        {/* ── Gauge view ── */}
        {gaugeView && hasSomeData && (
          <Suspense
            fallback={
              <div className="py-10 flex items-center justify-center text-text-tertiary text-sm">
                Lade Gauge…
              </div>
            }
          >
            <CategoryGaugeChart rows={gaugeRows} hasPeer={hasPeerGauge} />
          </Suspense>
        )}

        {/* ── Bar view ── */}
        {!gaugeView && (
          <div className="divide-y divide-border/40">
            {mainRows.map((row) => (
              <SuperCategoryBar
                key={row.sc.id}
                superCategory={row.sc}
                actual={row.actual  > 0 ? row.actual  : undefined}
                planned={row.planned > 0 ? row.planned : undefined}
                subItems={row.subItems}
                onClick={() => openDrillDown(row)}
              />
            ))}

            {sonstigesRow && (
              <>
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-4 py-2.5 text-text-tertiary hover:text-text-primary text-xs transition-colors"
                  onClick={() => setShowSonstiges((v) => !v)}
                >
                  <span className="flex items-center gap-1.5">
                    {showSonstiges ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    💸 Sonstiges
                    {sonstigesRow.actual > 0 && ` · ${formatCHF(sonstigesRow.actual)}`}
                  </span>
                </button>
                {showSonstiges && (
                  <SuperCategoryBar
                    superCategory={sonstigesRow.sc}
                    actual={sonstigesRow.actual  > 0 ? sonstigesRow.actual  : undefined}
                    planned={sonstigesRow.planned > 0 ? sonstigesRow.planned : undefined}
                    subItems={sonstigesRow.subItems}
                    onClick={() => openDrillDown(sonstigesRow)}
                  />
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Peer comparison (collapsed) ─────────── */}
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
            {showPeer
              ? <ChevronUp className="w-4 h-4 text-text-tertiary" />
              : <ChevronDown className="w-4 h-4 text-text-tertiary" />}
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
                    const actPct  = Math.min(100, ((cat.actual         ?? 0) / peerMax) * 100);
                    const peerPct = Math.min(100, ((cat.peer_benchmark ?? 0) / peerMax) * 100);
                    const isOver  = (cat.actual ?? 0) > (cat.peer_benchmark ?? 0);
                    return (
                      <div key={cat.category}>
                        <div className="flex items-center justify-between mb-1 text-xs">
                          <span className="text-text-secondary flex items-center gap-1.5">
                            <span
                              className="w-4 h-4 rounded flex items-center justify-center shrink-0"
                              style={{ backgroundColor: sc.color + "22" }}
                            >
                              <sc.icon className="w-2.5 h-2.5" style={{ color: sc.color }} />
                            </span>
                            {cat.category}
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
                          <div
                            className="absolute top-0 bottom-0 left-0 rounded-full opacity-30"
                            style={{ width: `${peerPct}%`, backgroundColor: sc.color }}
                          />
                          <div
                            className="absolute top-0 bottom-0 left-0 rounded-full opacity-80"
                            style={{ width: `${actPct}%`, backgroundColor: isOver ? "#f87171" : sc.color }}
                          />
                        </div>
                      </div>
                    );
                  })}
              </div>

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

      {/* ── Drill-down panel ────────────────────── */}
      {drillDown && (
        <CategoryDrillDown
          superCategory={drillDown.sc}
          actual={drillDown.actual  > 0 ? drillDown.actual  : undefined}
          planned={drillDown.planned > 0 ? drillDown.planned : undefined}
          months={months}
          subItems={drillDown.subItems}
          transactions={drillDown.transactions}
          onClose={closeDrillDown}
          onEditWizard={capabilities?.wizard_available ? () => {
            setWizardEditorScId(drillDown?.sc.id);
            closeDrillDown();
            setShowWizardEditor(true);
          } : undefined}
          onEditTransactions={() => {
            setTxnEditorRows(drillDown?.transactions ?? []);
            closeDrillDown();
            setShowTxnEditor(true);
          }}
        />
      )}

      {/* ── Wizard budget sidebar ────────────────── */}
      {showWizardEditor && (
        <WizardBudgetSidebar
          periodLabel={range.label}
          months={months}
          initialScId={wizardEditorScId}
          onClose={() => setShowWizardEditor(false)}
        />
      )}

      {/* ── Transaction sidebar editor ───────────── */}
      {showTxnEditor && (
        <TransactionSidebarEditor
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          transactions={txnEditorRows as any[]}
          periodLabel={range.label}
          onClose={() => setShowTxnEditor(false)}
        />
      )}
    </div>
  );
}
