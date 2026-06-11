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
import { Component, DashboardSpeed, DataTransferBoth, Eye, EyeClosed, GraphDown, GraphUp, LightBulb, NavArrowDown, NavArrowUp, Position, Reports, TableRows, Wallet } from "@/lib/icons";

const CategoryGaugeChart = lazy(
  () => import("@/components/charts/CategoryGaugeChart"),
);
const BudgetStackedBarChart = lazy(
  () => import("@/components/charts/BudgetStackedBarChart"),
);

import { api, budgetsApi, transactionsApi, budgetApi } from "@/lib/api";
import { formatAmount } from "@/lib/theme";
import { useAuth } from "@/lib/auth";
import GranularityNavigator from "@/components/GranularityNavigator";
import WizardBudgetSidebar from "@/components/WizardBudgetSidebar";
import TransactionSidebarEditor from "@/components/TransactionSidebarEditor";
import SuperCategoryBar from "@/components/budget/SuperCategoryBar";
import CategoryDrillDown from "@/components/budget/CategoryDrillDown";
import ExpenseDetailPanel from "@/components/budget/ExpenseDetailPanel";
import type { SubItem } from "@/components/budget/SuperCategoryBar";
import type { DrillDownTransaction } from "@/components/budget/CategoryDrillDown";
import { computeDateRange, TimeGranularity } from "@/lib/granularity";
import { useTaxonomy, type SuperCategory } from "@/lib/categories";
import { deduplicateWizardBatch } from "@/lib/wizardUtils";
import type { MultiAnalysisResult } from "@/types/budgetAnalysis";

// ── Transaction row type used in Budget (extended with recurrence) ──
interface TxnRow {
  id: number;
  date: string;
  amount: number;
  category?: string;
  description: string;
  merchant_normalized?: string;
  is_recurring?: boolean;
  periodicity?: string;
  is_transfer?: boolean;
}

// ── Wizard peer-config types + SC→key mapping ─────────────────
interface PeerConfig {
  housing?: number;
  groceries?: number;
  dining_out?: number;
  transport?: number;
  travel?: number;
  health_insurance?: number;
  other_insurance?: number;
  entertainment?: number;
  communication?: number;
  subscriptions?: number;
  clothing?: number;
  education?: number;
  direct_taxes?: number;
  pillar_3a_monthly?: number;
  [key: string]: number | undefined;
}

// Maps supercategory IDs → wizard peer-config keys that belong to it
const PEER_KEYS_BY_SC: Record<string, (keyof PeerConfig)[]> = {
  wohnen:        ["housing"],
  essen:         ["groceries", "dining_out"],
  mobilitaet:    ["transport", "travel"],
  versicherungen:["health_insurance", "other_insurance"],
  freizeit:      ["entertainment"],
  abos:          ["communication", "subscriptions"],
  shopping:      ["clothing"],
  bildung:       ["education"],
  steuern:       ["direct_taxes"],
  sparen:        ["pillar_3a_monthly"],
};

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
  const { user } = useAuth();
  const refCcy = user?.currency ?? "CHF";
  const fmtRef = (n: number) => formatAmount(n, refCcy);
  const { superCategories, resolveSuperCategory } = useTaxonomy();

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
  const [view, setView] = useState<"bar" | "gauge" | "stacked" | "compare">(() => {
    try {
      const saved = localStorage.getItem("budgetpal_budget_default_view");
      if (saved === "bar" || saved === "gauge" || saved === "stacked" || saved === "compare") return saved;
      return "gauge";
    } catch { return "gauge"; }
  });
  const gaugeView = view === "gauge";
  const [sortOrder, setSortOrder] = useState<"default" | "amount">(() => {
    try {
      return (localStorage.getItem("budgetpal_budget_sort_order") as "default" | "amount") || "default";
    } catch { return "default"; }
  });
  const [hiddenScIds, setHiddenScIds] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("budgetpal_budget_hidden_cats");
      return saved ? new Set<string>(JSON.parse(saved)) : new Set<string>();
    } catch { return new Set<string>(); }
  });
  const [showExpenseDetail, setShowExpenseDetail] = useState(false);
  const [excludeTransfers, setExcludeTransfers] = useState<boolean>(() => {
    try { return localStorage.getItem("budgetpal_budget_excl_transfers") === "true"; } catch { return false; }
  });

  function toggleExcludeTransfers() {
    setExcludeTransfers((v) => {
      const next = !v;
      try { localStorage.setItem("budgetpal_budget_excl_transfers", String(next)); } catch {}
      return next;
    });
  }

  function toggleHideCategory(scId: string) {
    setHiddenScIds((prev) => {
      const next = new Set(prev);
      next.has(scId) ? next.delete(scId) : next.add(scId);
      try { localStorage.setItem("budgetpal_budget_hidden_cats", JSON.stringify([...next])); } catch {}
      return next;
    });
  }

  function handleSetView(v: "bar" | "gauge" | "stacked" | "compare") {
    setView(v);
    try { localStorage.setItem("budgetpal_budget_default_view", v); } catch {}
  }

  function handleSetSortOrder(v: "default" | "amount") {
    setSortOrder(v);
    try { localStorage.setItem("budgetpal_budget_sort_order", v); } catch {}
  }

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

  // Per-transaction list — used for both drill-down AND frequency-filtered KPIs
  const { data: periodTransactions = [] } = useQuery({
    queryKey: ["period-transactions-drilldown", periodStart, periodEnd],
    queryFn: () =>
      transactionsApi
        .list({ start: periodStart, end: periodEnd, limit: 2000 })
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
    enabled: (showPeer || gaugeView || view === "compare") && capabilities?.peer_data_available === true,
    staleTime: 60_000,
  });

  // Wizard peer-config (stored BFS defaults — fallback for categories without txn peer data)
  const { data: wizardPeerConfig } = useQuery<PeerConfig | null>({
    queryKey: ["wizard-peer-config"],
    queryFn: () => api.get("/wizard/peer-config").then((r) => r.data),
    staleTime: 300_000,
    enabled: showPeer || gaugeView || view === "compare",
  });

  // ── Frequency filter helpers ─────────────────────────────────
  // True when every chip is active → use fast stats-API path
  const ALL_FREQS_SELECTED = useMemo(
    () => FREQ_OPTIONS.every(({ key }) => selectedFreqs.has(key)),
    [selectedFreqs],
  );

  // Categories that represent inter-account transfers (resolve to "sparen")
  // and should be excluded from expense totals when the toggle is on.
  const TRANSFER_CATEGORIES = new Set(["Kontoübertrag", "kontoübertrag"]);

  // Subset of periodTransactions matching the selected frequencies.
  // Mapping: "monthly"|"quarterly"|"halfyearly"|"yearly"|"weekly" → is_recurring + periodicity
  //          "einmalig" → not recurring (one-time payments)
  // When excludeTransfers is on, "Kontoübertrag" category entries are removed.
  const freqFilteredTxns = useMemo((): TxnRow[] => {
    let txns = periodTransactions as TxnRow[];
    if (excludeTransfers) txns = txns.filter((t) => !TRANSFER_CATEGORIES.has(t.category ?? ""));
    if (ALL_FREQS_SELECTED) return txns;
    return txns.filter((t) => {
      if (!t.is_recurring) return selectedFreqs.has("einmalig");
      return selectedFreqs.has(t.periodicity ?? "monthly");
    });
  }, [periodTransactions, selectedFreqs, ALL_FREQS_SELECTED, excludeTransfers]);

  // Periodicity param string for the stacked chart API (null = all)
  const stackedPeriodicities = useMemo(
    () => ALL_FREQS_SELECTED ? undefined : [...selectedFreqs].join(","),
    [ALL_FREQS_SELECTED, selectedFreqs],
  );

  // Monthly breakdown for stacked bar chart — from API, respects period + freq filter
  const { data: stackedChartData = [] } = useQuery({
    queryKey: ["monthly-category-breakdown", periodStart, periodEnd, stackedPeriodicities],
    queryFn: () =>
      transactionsApi
        .monthlyCategoryBreakdown({ start: periodStart, end: periodEnd, periodicities: stackedPeriodicities })
        .then((r) => r.data),
    staleTime: 30_000,
  });

  // All calendar months in the selected period for the x-axis
  const periodMonths = useMemo(() => {
    const ms: string[] = [];
    const cur = new Date(range.from.getFullYear(), range.from.getMonth(), 1);
    const endD = new Date(range.to.getFullYear(), range.to.getMonth(), 1);
    while (cur <= endD) {
      ms.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}`);
      cur.setMonth(cur.getMonth() + 1);
    }
    return ms;
  }, [range]);

  // Use fast stats-API path only when all freq chips are active AND the toggle is off.
  // stats.total_expenses = all non-transfer negatives, INCLUDING sparen-category txns that
  // aren't flagged as is_transfer (e.g. Kontoübertrag with wrong flag). When the toggle is on
  // we must use the slow path so freqFilteredTxns can filter by category = "Kontoübertrag".
  const USE_FAST_PATH = ALL_FREQS_SELECTED && !excludeTransfers;

  // ── KPI: stats-API when all freqs active, computed when filtered ──
  const kpi = useMemo(() => {
    if (USE_FAST_PATH) {
      return {
        income:   stats?.total_income   ?? 0,
        expenses: stats?.total_expenses ?? 0,
        net: (stats?.total_income ?? 0) - (stats?.total_expenses ?? 0),
      };
    }
    let income = 0, expenses = 0;
    for (const t of freqFilteredTxns) {
      if (t.amount > 0) income += t.amount;
      else expenses += -t.amount;
    }
    return { income, expenses, net: income - expenses };
  }, [USE_FAST_PATH, stats, freqFilteredTxns]);

  // ── Actual by supercategory ───────────────────────────────────
  // Fast path: stats.top_categories (authoritative, no limit) when all freqs active.
  // Filtered path: compute from freqFilteredTxns so frequency chips affect gauges too.
  const actualBySuperCat = useMemo((): Map<string, { total: number; subs: Map<string, number> }> => {
    const m = new Map<string, { total: number; subs: Map<string, number> }>();

    if (USE_FAST_PATH) {
      for (const cat of (stats?.top_categories || [])) {
        if (cat.total <= 0) continue;
        const sc = resolveSuperCategory(cat.category, false);
        if (sc.id === "sparen") continue;
        if (!m.has(sc.id)) m.set(sc.id, { total: 0, subs: new Map() });
        const entry = m.get(sc.id)!;
        entry.total += cat.total;
        entry.subs.set(cat.category, (entry.subs.get(cat.category) ?? 0) + cat.total);
      }
    } else {
      for (const t of freqFilteredTxns) {
        if (t.amount >= 0) continue; // skip income
        const sc = resolveSuperCategory(t.category || "");
        if (sc.id === "sparen") continue;
        const abs = -t.amount;
        if (!m.has(sc.id)) m.set(sc.id, { total: 0, subs: new Map() });
        const entry = m.get(sc.id)!;
        entry.total += abs;
        entry.subs.set(
          t.category || "Sonstiges",
          (entry.subs.get(t.category || "Sonstiges") ?? 0) + abs,
        );
      }
    }
    return m;
  }, [USE_FAST_PATH, stats, freqFilteredTxns, superCategories, resolveSuperCategory]);

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
  }, [wizardPlanned, superCategories, resolveSuperCategory]);

  const totalPlanned = useMemo(
    () => [...plannedBySuperCat.values()].reduce((s, e) => s + e.total, 0),
    [plannedBySuperCat],
  );

  // ── Peer benchmark aggregated to supercategory level ──────────
  // NOTE: peer_benchmark from the API is always a MONTHLY value (same as
  // wizard monthly_amount). Must be multiplied by months to match actual
  // spending which covers the full selected period.
  // For categories with no txn peer data (e.g. Freizeit, Shopping, Bildung,
  // Steuern) we supplement from the stored wizard peer-config.
  const peerBySuperCat = useMemo((): Map<string, number> => {
    const m = new Map<string, number>();

    // 1. Populate from API peer data (categories that have real transactions)
    if (peerData) {
      for (const cat of (peerData.categories ?? [])) {
        if (!cat.peer_benchmark || cat.peer_benchmark <= 0) continue;
        const sc = resolveSuperCategory(cat.category, false);
        if (sc.id === "sparen") continue;
        m.set(sc.id, (m.get(sc.id) ?? 0) + cat.peer_benchmark * months);
      }
    }

    // 2. Supplement from wizard peer-config for supercategories still missing
    if (wizardPeerConfig) {
      for (const [scId, keys] of Object.entries(PEER_KEYS_BY_SC)) {
        if (m.has(scId)) continue; // already have API data — don't override
        let sum = 0;
        for (const key of keys) {
          const monthly = wizardPeerConfig[key];
          if (monthly && monthly > 0) sum += monthly;
        }
        if (sum > 0) m.set(scId, sum * months);
      }
    }

    return m;
  }, [peerData, wizardPeerConfig, months, superCategories, resolveSuperCategory]);

  // ── Actual sub-items by SC — always from full transaction list ───
  // stats.top_categories is capped at 10 — this gives ALL categories.
  const subsBySuperCat = useMemo((): Map<string, Map<string, number>> => {
    const m = new Map<string, Map<string, number>>();
    for (const t of freqFilteredTxns) {
      if (t.amount >= 0) continue;
      const sc = resolveSuperCategory(t.category || "");
      if (sc.id === "sparen") continue;
      const abs = -t.amount;
      if (!m.has(sc.id)) m.set(sc.id, new Map());
      const key = t.category || "Sonstiges";
      m.get(sc.id)!.set(key, (m.get(sc.id)!.get(key) ?? 0) + abs);
    }
    return m;
  }, [freqFilteredTxns, resolveSuperCategory]);

  // ── Transactions per supercategory for drill-down ─────────────
  // Uses freqFilteredTxns so the frequency chips affect drill-down too.
  const txnsBySuperCat = useMemo((): Map<string, DrillDownTransaction[]> => {
    const m = new Map<string, DrillDownTransaction[]>();
    for (const t of freqFilteredTxns) {
      if (t.amount >= 0) continue;
      // freqFilteredTxns already removes Kontoübertrag when toggle is on
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
  }, [freqFilteredTxns, superCategories, resolveSuperCategory]);

  // ── Unified SuperRow list (all SUPER_CATEGORIES) ──────────────
  const superRows = useMemo((): SuperRow[] => {
    const rows: SuperRow[] = [];

    for (const sc of superCategories) {
      if (sc.id === "sparen") continue; // income side — never shown as expense

      const planEntry = plannedBySuperCat.get(sc.id);
      const planned   = planEntry?.total ?? 0;

      // Derive actual by summing subsBySuperCat — always from the full txn list, so even
      // categories that don't appear in stats.top_categories (top-10 limit) are included.
      // Fall back to actualBySuperCat.total only while freqFilteredTxns is still loading.
      const histSubs  = subsBySuperCat.get(sc.id);
      const histTotal = histSubs
        ? [...histSubs.values()].reduce((s, v) => s + v, 0)
        : 0;
      const actual = histTotal > 0 ? histTotal : (actualBySuperCat.get(sc.id)?.total ?? 0);

      // Merge sub-items: actual from full txn list (all categories), planned from wizard
      const subMap = new Map<string, SubItem>();
      for (const [label, amt] of subsBySuperCat.get(sc.id) ?? []) {
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
        transactions: txnsBySuperCat.get(sc.id) ?? [],
      });
    }

    // Apply sort order
    if (sortOrder === "amount") {
      rows.sort((a, b) => (b.actual || b.planned) - (a.actual || a.planned));
    }
    // "default" keeps SUPER_CATEGORIES insertion order

    return rows;
  }, [actualBySuperCat, plannedBySuperCat, subsBySuperCat, txnsBySuperCat, sortOrder, superCategories]);

  const mainRows     = superRows.filter((r) => r.sc.id !== "sonstiges");
  const sonstigesRow = superRows.find((r) => r.sc.id === "sonstiges");

  // Visible (non-hidden) rows for each view
  const visibleMainRows = mainRows.filter((r) => !hiddenScIds.has(r.sc.id));

  // ── DashboardSpeed rows: all mainRows + peer values ────────────────────
  const gaugeRows = useMemo(
    () =>
      mainRows.map((r) => ({
        sc:      r.sc,
        actual:  r.actual,
        planned: r.planned,
        peer:    peerBySuperCat.get(r.sc.id),
        hidden:  hiddenScIds.has(r.sc.id),
      })),
    [mainRows, peerBySuperCat, hiddenScIds],
  );

  const hasPeerGauge =
    peerBySuperCat.size > 0 &&
    (capabilities?.peer_data_available === true || wizardPeerConfig != null);

  const utilisation = totalPlanned > 0
    ? Math.min(200, Math.round((kpi.expenses / totalPlanned) * 100))
    : null;

  const openDrillDown  = useCallback((row: SuperRow) => setDrillDown(row), []);
  const closeDrillDown = useCallback(() => setDrillDown(null), []);

  const hasSomeData = superRows.some((r) => r.actual > 0 || r.planned > 0) || (sonstigesRow != null && (sonstigesRow.actual > 0 || sonstigesRow.planned > 0));

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
      <div className="flex flex-wrap gap-2 items-center">
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

        {/* Separator */}
        <span className="text-border mx-0.5">|</span>

        {/* Exclude-transfers toggle */}
        <button
          type="button"
          title="Kontoüberträge ein-/ausschließen"
          onClick={toggleExcludeTransfers}
          className={clsx(
            "px-3 py-1.5 rounded-lg text-xs border transition-colors",
            excludeTransfers
              ? "bg-amber-500/15 border-amber-500/40 text-amber-400"
              : "bg-bg-surface2 border-border text-text-tertiary hover:text-text-primary",
          )}
        >
          {excludeTransfers ? "Überträge ausgeblendet" : "Überträge einschließen"}
        </button>

        {!ALL_FREQS_SELECTED ? (
          <span className="text-amber-400 text-xs self-center ml-1 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
            Alle Werte gefiltert nach Wiederkehrend
          </span>
        ) : (
          <span className="text-text-disabled text-xs self-center ml-1">
            Gilt für alle Werte auf dieser Seite
          </span>
        )}
      </div>

      {/* ── KPI strip ──────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">

        {/* Netto */}
        <div className="card flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-text-tertiary text-xs uppercase tracking-wide">Netto-Überschuss</span>
            <div className="w-8 h-8 rounded-lg bg-bg-surface2 flex items-center justify-center">
              {kpi.net >= 0
                ? <GraphUp className="w-4 h-4 text-gain" />
                : <GraphDown className="w-4 h-4 text-loss" />}
            </div>
          </div>
          <p className={clsx(
            "text-2xl font-mono font-semibold",
            kpi.net >= 0 ? "text-gain" : "text-loss",
          )}>
            {kpi.net >= 0 ? "+" : ""}{fmtRef(kpi.net)}
          </p>
          <p className="text-text-tertiary text-xs">
            {fmtRef(kpi.income)} Einnahmen · {fmtRef(kpi.expenses)} Ausgaben
          </p>
        </div>

        {/* Ausgaben Ist vs Soll — clickable for detail breakdown */}
        <button
          type="button"
          onClick={() => setShowExpenseDetail(true)}
          className="card flex flex-col gap-2 text-left hover:ring-1 hover:ring-accent/30 transition-all cursor-pointer"
        >
          <div className="flex items-center justify-between">
            <span className="text-text-tertiary text-xs uppercase tracking-wide">Ausgaben</span>
            <div className="w-8 h-8 rounded-lg bg-bg-surface2 flex items-center justify-center">
              <Wallet className="w-4 h-4 text-text-tertiary" />
            </div>
          </div>
          <p className="text-2xl font-mono font-semibold text-text-primary">
            {fmtRef(kpi.expenses)}
          </p>
          {totalPlanned > 0 ? (
            <div>
              <p className="text-text-tertiary text-xs mb-1">
                von {fmtRef(totalPlanned)} geplant · <span className="text-accent/70">Details anzeigen</span>
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
              {capabilities?.wizard_available ? "Empirische Budgets geladen…" : "Details anzeigen →"}
            </p>
          )}
        </button>

        {/* Budget-Ausschöpfung */}
        <div className="card flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-text-tertiary text-xs uppercase tracking-wide">Ausschöpfung</span>
            <div className="w-8 h-8 rounded-lg bg-bg-surface2 flex items-center justify-center">
              <Position className="w-4 h-4 text-text-tertiary" />
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

              {/* Sort order toggle */}
              <button
                type="button"
                title={sortOrder === "default" ? "Sortierung: Standard → nach Betrag" : "Sortierung: nach Betrag → Standard"}
                onClick={() => handleSetSortOrder(sortOrder === "default" ? "amount" : "default")}
                className={clsx(
                  "flex items-center gap-1 px-2 py-1.5 rounded-lg border text-xs transition-colors",
                  sortOrder === "amount"
                    ? "bg-accent/15 border-accent/40 text-accent"
                    : "border-border text-text-tertiary hover:text-text-secondary",
                )}
              >
                <DataTransferBoth className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{sortOrder === "amount" ? "Betrag" : "Standard"}</span>
              </button>

              {/* View toggle: Balken / DashboardSpeed / Stacked */}
              <div className="flex items-center rounded-lg border border-border overflow-hidden">
                <button
                  type="button"
                  title="Balkenansicht"
                  onClick={() => handleSetView("bar")}
                  className={clsx(
                    "px-2 py-1.5 transition-colors",
                    view === "bar"
                      ? "bg-accent/20 text-accent"
                      : "text-text-tertiary hover:text-text-secondary",
                  )}
                >
                  <Reports className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  title="DashboardSpeed-Ansicht"
                  onClick={() => handleSetView("gauge")}
                  className={clsx(
                    "px-2 py-1.5 border-l border-border transition-colors",
                    view === "gauge"
                      ? "bg-accent/20 text-accent"
                      : "text-text-tertiary hover:text-text-secondary",
                  )}
                >
                  <DashboardSpeed className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  title="Monatlicher Verlauf (Stacked Bar)"
                  onClick={() => handleSetView("stacked")}
                  className={clsx(
                    "px-2 py-1.5 border-l border-border transition-colors",
                    view === "stacked"
                      ? "bg-accent/20 text-accent"
                      : "text-text-tertiary hover:text-text-secondary",
                  )}
                >
                  <Component className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  title="3-Weg-Vergleich (Ist / Soll / Peer)"
                  onClick={() => handleSetView("compare")}
                  className={clsx(
                    "px-2 py-1.5 border-l border-border transition-colors",
                    view === "compare"
                      ? "bg-accent/20 text-accent"
                      : "text-text-tertiary hover:text-text-secondary",
                  )}
                >
                  <TableRows className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>

          {/* Bar-view legend */}
          {view === "bar" && totalPlanned > 0 && (
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

        {/* Category visibility filter chips */}
        <div className="flex flex-wrap gap-1.5 px-4 py-2 border-b border-border/40 bg-bg-surface/30">
          {superCategories.filter((sc) => sc.id !== "sparen").map((sc) => {
            const isHidden = hiddenScIds.has(sc.id);
            return (
              <button
                key={sc.id}
                type="button"
                title={isHidden ? `${sc.label} einblenden` : `${sc.label} ausblenden`}
                onClick={() => toggleHideCategory(sc.id)}
                className={clsx(
                  "flex items-center gap-1 px-2 py-1 rounded-lg border text-xs transition-all",
                  isHidden
                    ? "border-border bg-bg-surface2 text-text-disabled opacity-50"
                    : "border-border/60 bg-bg-elevated text-text-secondary",
                )}
                style={!isHidden ? { borderColor: sc.color + "50", backgroundColor: sc.color + "12" } : undefined}
              >
                {isHidden
                  ? <EyeClosed className="w-3 h-3 shrink-0" />
                  : <sc.icon className="w-3 h-3 shrink-0" style={{ color: sc.color }} />}
                <span className="hidden sm:inline truncate max-w-[80px]">{sc.label}</span>
              </button>
            );
          })}
          {hiddenScIds.size > 0 && (
            <button
              type="button"
              onClick={() => {
                setHiddenScIds(new Set());
                try { localStorage.removeItem("budgetpal_budget_hidden_cats"); } catch {}
              }}
              className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border/40 text-xs text-text-tertiary hover:text-text-secondary transition-colors"
            >
              <Eye className="w-3 h-3" />
              <span className="hidden sm:inline">Alle einblenden</span>
            </button>
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

        {/* ── DashboardSpeed view ── */}
        {view === "gauge" && hasSomeData && (
          <Suspense
            fallback={
              <div className="py-10 flex items-center justify-center text-text-tertiary text-sm">
                Lade DashboardSpeed…
              </div>
            }
          >
            <CategoryGaugeChart rows={gaugeRows} hasPeer={hasPeerGauge} onToggleHide={toggleHideCategory} />
          </Suspense>
        )}

        {/* ── Stacked bar view ── */}
        {view === "stacked" && (
          <Suspense
            fallback={
              <div className="py-10 flex items-center justify-center text-text-tertiary text-sm">
                Lade Diagramm…
              </div>
            }
          >
            <BudgetStackedBarChart
              historicalData={stackedChartData}
              forecastData={[]}
              historicalAxisMonths={periodMonths}
              embedded
              hiddenScIds={hiddenScIds}
              sortOrder={sortOrder}
              height={680}
            />
          </Suspense>
        )}

        {/* ── Bar view ── */}
        {view === "bar" && (
          <div className="divide-y divide-border/40">
            {visibleMainRows.map((row) => (
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
                    {showSonstiges ? <NavArrowUp className="w-3.5 h-3.5" /> : <NavArrowDown className="w-3.5 h-3.5" />}
                    💸 Sonstiges
                    {sonstigesRow.actual > 0 && ` · ${fmtRef(sonstigesRow.actual)}`}
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

        {/* ── Compare view (3-Weg: Ist / Soll / Peer-Ø) ── */}
        {view === "compare" && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[520px]">
              <thead>
                <tr className="border-b border-border/60 text-[11px] text-text-tertiary uppercase tracking-wide">
                  <th className="px-4 py-2.5 text-left font-medium w-40">Kategorie</th>
                  <th className="px-3 py-2.5 text-right font-medium">Ist</th>
                  <th className="px-3 py-2.5 text-right font-medium">Soll</th>
                  <th className="px-3 py-2.5 text-right font-medium">vs. Soll</th>
                  <th className="px-3 py-2.5 text-right font-medium">Peer-Ø</th>
                  <th className="px-3 py-2.5 text-right font-medium">vs. Peer</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {superRows
                  .filter((r) => r.actual > 0 || r.planned > 0 || peerBySuperCat.has(r.sc.id))
                  .map((row) => {
                    const peer = peerBySuperCat.get(row.sc.id) ?? 0;
                    const vsSoll   = row.planned > 0 ? row.actual - row.planned : null;
                    const vsPeer   = peer > 0 ? row.actual - peer : null;
                    const vsSollPct = row.planned > 0 ? (row.actual / row.planned - 1) * 100 : null;
                    const vsPeerPct = peer > 0 ? (row.actual / peer - 1) * 100 : null;
                    const isHidden = hiddenScIds.has(row.sc.id);
                    if (isHidden) return null;
                    return (
                      <tr
                        key={row.sc.id}
                        className="hover:bg-bg-surface2/40 cursor-pointer transition-colors"
                        onClick={() => openDrillDown(row)}
                      >
                        {/* Category */}
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <span
                              className="w-5 h-5 rounded flex items-center justify-center shrink-0"
                              style={{ backgroundColor: row.sc.color + "22" }}
                            >
                              <row.sc.icon className="w-3 h-3" style={{ color: row.sc.color }} />
                            </span>
                            <span className="text-text-secondary text-xs truncate max-w-[100px]">{row.sc.label}</span>
                          </div>
                        </td>

                        {/* Ist */}
                        <td className="px-3 py-2.5 text-right font-mono text-xs text-text-primary">
                          {row.actual > 0 ? fmtRef(row.actual) : <span className="text-text-disabled">—</span>}
                        </td>

                        {/* Soll */}
                        <td className="px-3 py-2.5 text-right font-mono text-xs text-text-tertiary">
                          {row.planned > 0 ? fmtRef(row.planned) : <span className="text-text-disabled">—</span>}
                        </td>

                        {/* Δ vs Soll */}
                        <td className="px-3 py-2.5 text-right">
                          {vsSoll !== null ? (
                            <div className="flex flex-col items-end">
                              <span className={clsx(
                                "text-xs font-mono",
                                vsSoll > 0 ? "text-loss" : "text-gain",
                              )}>
                                {vsSoll > 0 ? "+" : ""}{fmtRef(vsSoll)}
                              </span>
                              {vsSollPct !== null && (
                                <span className={clsx(
                                  "text-[10px]",
                                  vsSollPct > 0 ? "text-loss/70" : "text-gain/70",
                                )}>
                                  {vsSollPct > 0 ? "+" : ""}{vsSollPct.toFixed(0)}%
                                </span>
                              )}
                            </div>
                          ) : <span className="text-text-disabled text-xs">—</span>}
                        </td>

                        {/* Peer-Ø */}
                        <td className="px-3 py-2.5 text-right font-mono text-xs text-text-tertiary">
                          {peer > 0 ? fmtRef(peer) : <span className="text-text-disabled">—</span>}
                        </td>

                        {/* Δ vs Peer */}
                        <td className="px-3 py-2.5 text-right">
                          {vsPeer !== null ? (
                            <div className="flex flex-col items-end">
                              <span className={clsx(
                                "text-xs font-mono",
                                vsPeer > 0 ? "text-loss" : "text-gain",
                              )}>
                                {vsPeer > 0 ? "+" : ""}{fmtRef(vsPeer)}
                              </span>
                              {vsPeerPct !== null && (
                                <span className={clsx(
                                  "text-[10px]",
                                  vsPeerPct > 0 ? "text-loss/70" : "text-gain/70",
                                )}>
                                  {vsPeerPct > 0 ? "+" : ""}{vsPeerPct.toFixed(0)}%
                                </span>
                              )}
                            </div>
                          ) : <span className="text-text-disabled text-xs">—</span>}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>

              {/* Totals footer */}
              <tfoot>
                <tr className="border-t border-border text-xs font-semibold">
                  <td className="px-4 py-2.5 text-text-secondary">Total</td>
                  <td className="px-3 py-2.5 text-right font-mono text-text-primary">{fmtRef(kpi.expenses)}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-text-tertiary">
                    {totalPlanned > 0 ? fmtRef(totalPlanned) : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {totalPlanned > 0 && (
                      <span className={clsx("font-mono", kpi.expenses > totalPlanned ? "text-loss" : "text-gain")}>
                        {kpi.expenses > totalPlanned ? "+" : ""}{fmtRef(kpi.expenses - totalPlanned)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-text-tertiary">
                    {peerBySuperCat.size > 0
                      ? fmtRef([...peerBySuperCat.values()].reduce((s, v) => s + v, 0))
                      : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {peerBySuperCat.size > 0 && (() => {
                      const peerTotal = [...peerBySuperCat.values()].reduce((s, v) => s + v, 0);
                      const delta = kpi.expenses - peerTotal;
                      return (
                        <span className={clsx("font-mono", delta > 0 ? "text-loss" : "text-gain")}>
                          {delta > 0 ? "+" : ""}{fmtRef(delta)}
                        </span>
                      );
                    })()}
                  </td>
                </tr>
              </tfoot>
            </table>

            {/* Legend */}
            <div className="flex flex-wrap gap-4 px-4 py-3 border-t border-border/40 text-[10px] text-text-tertiary">
              <span>
                <span className="text-gain">Grün</span> = unter Budget / unter Peer
              </span>
              <span>
                <span className="text-loss">Rot</span> = über Budget / über Peer
              </span>
              {peerBySuperCat.size === 0 && (
                <span className="text-text-disabled">
                  Keine Peer-Daten: Starte den{" "}
                  <a href="/wizard" className="text-accent underline">Setup-Wizard</a>{" "}
                  um Peer-Vergleiche zu aktivieren.
                </span>
              )}
            </div>
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
              <LightBulb className="w-4 h-4 text-warning" />
              Peer-Vergleich (Schweizer Durchschnitt)
            </span>
            {showPeer
              ? <NavArrowUp className="w-4 h-4 text-text-tertiary" />
              : <NavArrowDown className="w-4 h-4 text-text-tertiary" />}
          </button>

          {showPeer && peerData && (
            <div className="border-t border-border px-4 py-4 space-y-4">
              {peerData.peer_info && (
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-text-tertiary border-b border-border pb-3">
                  <span>Altersgruppe: <strong className="text-text-secondary">{peerData.peer_info.age_range}</strong></span>
                  <span>Haushalt: <strong className="text-text-secondary">{peerData.peer_info.household_type}</strong></span>
                  <span>Medianeinkommen: <strong className="text-text-secondary">{fmtRef(peerData.peer_info.median_income)}/Monat</strong></span>
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
                    const peerPeriod = (cat.peer_benchmark ?? 0) * months; // monthly → period
                    const peerMax = Math.max(cat.actual ?? 0, peerPeriod, 1);
                    const actPct  = Math.min(100, ((cat.actual ?? 0) / peerMax) * 100);
                    const peerPct = Math.min(100, (peerPeriod         / peerMax) * 100);
                    const isOver  = (cat.actual ?? 0) > peerPeriod;
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
                              {fmtRef(cat.actual ?? 0)}
                            </span>
                            <span className="text-text-disabled">/</span>
                            <span className="text-text-tertiary">Ø {fmtRef(peerPeriod)}</span>
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
                        <LightBulb className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
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

      {/* ── Expense detail panel ─────────────────── */}
      {showExpenseDetail && (
        <ExpenseDetailPanel
          transactions={freqFilteredTxns}
          resolveSuperCategory={resolveSuperCategory}
          statsExpenses={USE_FAST_PATH ? stats?.total_expenses : undefined}
          periodLabel={range.label}
          excludeTransfers={excludeTransfers}
          onClose={() => setShowExpenseDetail(false)}
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
