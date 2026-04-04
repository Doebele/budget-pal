import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { budgetsApi, transactionsApi, budgetApi } from "@/lib/api";
import { formatCHF } from "@/lib/theme";
import { format, subMonths } from "date-fns";
import { clsx } from "clsx";
import { RefreshCw, Sparkles, TrendingDown, TrendingUp, Minus, AlertTriangle, Lightbulb, Pencil } from "lucide-react";
import GranularityNavigator from "@/components/GranularityNavigator";
import BudgetAnalysisModes from "@/components/BudgetAnalysisModes";
import TransactionSidebarEditor from "@/components/TransactionSidebarEditor";
import { computeDateRange, TimeGranularity } from "@/lib/granularity";
import type { AnalysisMode, CategoryBreakdown, MultiAnalysisResult, SavingsOpportunity } from "@/types/budgetAnalysis";

interface RecurringExpense {
  category: string;
  amount: number;
  frequency: "monthly" | "quarterly" | "yearly";
  confidence: number;
  basedOn: number;
}

export default function Budget() {
  const [granularity, setGranularity] = useState<TimeGranularity>("monthly");
  const [anchor, setAnchor] = useState<Date>(new Date());
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>("past");
  const [showEditor, setShowEditor] = useState(false);

  const range = useMemo(() => computeDateRange(granularity, anchor), [granularity, anchor]);
  const periodStart = format(range.from, "yyyy-MM-dd");
  const periodEnd   = format(range.to,   "yyyy-MM-dd");

  const year = anchor.getFullYear();
  const now = new Date();
  const isFuturePeriod = range.from > now;

  const { data: budgets } = useQuery({
    queryKey: ["budgets", year],
    queryFn: () => budgetsApi.list({ year }).then((r) => r.data),
  });

  // Get stats for selected period
  const { data: stats } = useQuery({
    queryKey: ["transaction-stats-budget", periodStart, periodEnd],
    queryFn: () => transactionsApi.stats({ start: periodStart, end: periodEnd }).then((r) => r.data),
  });

  // Get transactions from last 6 months to identify recurring expenses
  const { data: historicalTransactions } = useQuery({
    queryKey: ["historical-transactions-budget", granularity, anchor.toISOString()],
    queryFn: async () => {
      const sixMonthsAgo = format(subMonths(anchor, 6), "yyyy-MM-dd");
      const result = await transactionsApi.list({
        start: sixMonthsAgo,
        end: periodEnd,
        limit: 1000,
      });
      return result.data;
    },
    enabled: true,
  });

  // Always-running capabilities query (mode=past) → gives wizard_available + peer_data_available
  // Used to enable/disable mode buttons regardless of selected mode
  const { data: capabilities } = useQuery<MultiAnalysisResult>({
    queryKey: ["budget-capabilities", periodStart, periodEnd],
    queryFn: () =>
      budgetApi
        .multiAnalysis({ mode: "past", start: periodStart, end: periodEnd })
        .then((r) => r.data),
    staleTime: 60_000,
  });

  // Always-running peer analysis → provides inline peer bars per category
  const { data: peerData } = useQuery<MultiAnalysisResult>({
    queryKey: ["peer-analysis", periodStart, periodEnd],
    queryFn: () =>
      budgetApi
        .multiAnalysis({ mode: "peer", start: periodStart, end: periodEnd })
        .then((r) => r.data),
    enabled: capabilities?.peer_data_available === true,
    staleTime: 60_000,
  });

  // Multi-modal analysis query (non-past modes — for the detail section below)
  const { data: multiAnalysis, isLoading: isMultiLoading } = useQuery<MultiAnalysisResult>({
    queryKey: ["multi-analysis", analysisMode, periodStart, periodEnd],
    queryFn: () =>
      budgetApi
        .multiAnalysis({ mode: analysisMode, start: periodStart, end: periodEnd })
        .then((r) => r.data),
    enabled: analysisMode !== "past",
    staleTime: 30_000,
  });

  // Identify recurring expenses from historical data
  const recurringExpenses = useMemo((): RecurringExpense[] => {
    if (!historicalTransactions || historicalTransactions.length === 0) return [];

    // Group transactions by category
    const byCategory: Record<string, { amounts: number[]; dates: Date[] }> = {};

    historicalTransactions.forEach((txn: { category?: string; amount: number; date: string }) => {
      if (!txn.category || txn.amount >= 0) return; // Only expenses

      const cat = txn.category;
      if (!byCategory[cat]) {
        byCategory[cat] = { amounts: [], dates: [] };
      }
      byCategory[cat].amounts.push(Math.abs(txn.amount));
      byCategory[cat].dates.push(new Date(txn.date));
    });

    // Find recurring patterns (transactions in same category appearing in multiple months)
    const recurring: RecurringExpense[] = [];

    Object.entries(byCategory).forEach(([category, data]) => {
      const { amounts, dates } = data;
      if (dates.length < 2) return; // Need at least 2 occurrences

      // Count unique months with this expense
      const uniqueMonths = new Set(dates.map(d => `${d.getFullYear()}-${d.getMonth()}`)).size;
      const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;

      // Calculate frequency based on occurrence pattern
      let frequency: "monthly" | "quarterly" | "yearly" = "monthly";
      if (uniqueMonths >= 5) {
        frequency = "monthly";
      } else if (uniqueMonths >= 2) {
        frequency = "quarterly";
      } else {
        frequency = "yearly";
      }

      // Confidence based on consistency of amounts and frequency
      const amountVariance = Math.max(...amounts) - Math.min(...amounts);
      const amountConsistency = amountVariance / avgAmount;
      const confidence = Math.min(100, Math.round(
        (uniqueMonths / 6) * 100 * (1 - Math.min(amountConsistency, 0.5))
      ));

      recurring.push({
        category,
        amount: avgAmount,
        frequency,
        confidence,
        basedOn: uniqueMonths,
      });
    });

    return recurring.sort((a, b) => b.amount - a.amount);
  }, [historicalTransactions]);

  // Calculate projected expenses for future months
  const projectedTotal = useMemo(() => {
    if (!isFuturePeriod) return 0;
    return recurringExpenses.reduce((sum, exp) => {
      if (exp.frequency === "monthly") return sum + exp.amount;
      if (exp.frequency === "quarterly" && anchor.getMonth() % 3 === 0) return sum + exp.amount;
      return sum;
    }, 0);
  }, [recurringExpenses, isFuturePeriod, anchor]);

  // Transactions for the current period (passed to the sidebar editor)
  const periodTransactions = useMemo(() => {
    if (!historicalTransactions) return [];
    return historicalTransactions.filter((t: { date: string }) => {
      const d = new Date(t.date);
      return d >= range.from && d <= range.to;
    });
  }, [historicalTransactions, range]);

  // Peer benchmark lookup: category name → peer benchmark CHF
  // Built from the always-running peerData query (keyed by peer_key)
  const peerBenchmarkByCat = useMemo((): Map<string, number> => {
    if (!peerData?.categories) return new Map();
    return new Map(
      peerData.categories
        .filter((c) => c.peer_benchmark != null)
        .map((c) => [c.category, c.peer_benchmark!])
    );
  }, [peerData]);

  // Build lookup map: category name → multi-analysis breakdown (for non-past mode detail section)
  const comparisonByCategory = useMemo((): Map<string, CategoryBreakdown> => {
    if (!multiAnalysis?.categories) return new Map();
    return new Map(multiAnalysis.categories.map((c) => [c.category, c]));
  }, [multiAnalysis]);

  // Combine actual and projected categories
  const allCategories = useMemo(() => {
    const actual = (stats?.top_categories || []) as { category: string; total: number }[];

    if (!isFuturePeriod) {
      return actual.map(cat => ({ ...cat, isProjected: false }));
    }

    // For future months, merge actual (should be empty) with projected
    const projected = recurringExpenses.map(exp => ({
      category: exp.category,
      total: exp.frequency === "monthly" ? exp.amount : 0,
      isProjected: true,
      frequency: exp.frequency,
      confidence: exp.confidence,
    }));

    return projected;
  }, [stats, recurringExpenses, isFuturePeriod]);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-display text-text-primary">Budget</h1>
          <p className="text-text-tertiary text-sm mt-0.5">
            {range.label}
            {isFuturePeriod && (
              <span className="ml-2 inline-flex items-center gap-1 text-accent">
                <Sparkles className="w-3 h-3" />
                Prognose
              </span>
            )}
          </p>
        </div>

        <GranularityNavigator
          granularity={granularity}
          anchor={anchor}
          onChange={(g, a) => { setGranularity(g); setAnchor(a); }}
        />
      </div>

      {/* Analysis mode selector */}
      <div className="card p-4">
        <p className="text-text-tertiary text-xs uppercase tracking-wide mb-3">Analysemodus</p>
        <BudgetAnalysisModes
          mode={analysisMode}
          onChange={setAnalysisMode}
          wizardAvailable={capabilities?.wizard_available ?? false}
          peerAvailable={capabilities?.peer_data_available ?? false}
        />
      </div>

      {/* Overview */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card">
          <p className="text-text-tertiary text-xs uppercase tracking-wide mb-2">Einnahmen</p>
          <p className="text-gain font-mono text-xl font-semibold">{formatCHF(stats?.total_income || 0)}</p>
        </div>
        <div className="card">
          <p className="text-text-tertiary text-xs uppercase tracking-wide mb-2">
            {isFuturePeriod ? "Erwartete Ausgaben" : "Ausgaben"}
          </p>
          <p className={clsx("font-mono text-xl font-semibold", isFuturePeriod ? "text-warning" : "text-loss")}>
            {formatCHF(isFuturePeriod ? projectedTotal : (stats?.total_expenses || 0))}
          </p>
        </div>
        <div className="card">
          <p className="text-text-tertiary text-xs uppercase tracking-wide mb-2">Netto</p>
          <p className={clsx(
            "font-mono text-xl font-semibold",
            (stats?.net || 0) >= 0 ? "text-gain" : "text-loss"
          )}>
            {formatCHF(stats?.net || 0)}
          </p>
        </div>
        <div className="card">
          <p className="text-text-tertiary text-xs uppercase tracking-wide mb-2">Transaktionen</p>
          <p className="text-text-primary font-mono text-xl font-semibold">
            {stats?.transaction_count || 0}
          </p>
        </div>
      </div>

      {/* Recurring Expenses Summary (only for future months) */}
      {isFuturePeriod && recurringExpenses.length > 0 && (
        <div className="card bg-accent/5 border-accent/20">
          <div className="flex items-center gap-2 mb-4">
            <RefreshCw className="w-4 h-4 text-accent" />
            <h2 className="text-text-primary font-semibold text-sm">Wiederkehrende Ausgaben (Prognose)</h2>
          </div>
          <p className="text-text-tertiary text-xs mb-4">
            Basierend auf {recurringExpenses.reduce((sum, r) => sum + r.basedOn, 0)} wiederkehrenden Transaktionen aus den letzten 6 Monaten
          </p>
          <div className="flex flex-wrap gap-2">
            {recurringExpenses.slice(0, 5).map((exp) => (
              <div
                key={exp.category}
                className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-bg-card border border-border/50 text-xs"
              >
                <span className="text-text-secondary">{exp.category}</span>
                <span className="text-text-primary font-mono">{formatCHF(exp.amount)}</span>
                <span className="text-text-tertiary">({exp.frequency})</span>
                <span className="text-accent">{exp.confidence}%</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Aktionspunkte — Sparpotenzial vs. Peer-Group */}
      {peerData?.opportunities && peerData.opportunities.length > 0 && (
        <div className="card border-orange-800/40 bg-orange-900/5">
          <div className="flex items-center gap-2 mb-4">
            <Lightbulb className="w-4 h-4 text-orange-400" />
            <h2 className="text-text-primary font-semibold text-sm">Sparpotenzial vs. Peer-Group</h2>
            <span className="ml-auto text-xs text-text-tertiary bg-bg-surface2 px-2 py-0.5 rounded-full">
              {peerData.opportunities.length} Aktionspunkt{peerData.opportunities.length !== 1 ? "e" : ""}
            </span>
          </div>
          <div className="space-y-3">
            {peerData.opportunities.map((opp: SavingsOpportunity) => (
              <div key={opp.peer_key} className="flex items-start gap-3 p-3 rounded-lg bg-bg-surface2/60 border border-border/30">
                <AlertTriangle className="w-4 h-4 text-orange-400 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-text-primary text-sm font-medium">{opp.category}</span>
                    <span className="text-orange-400 text-xs font-mono shrink-0">
                      +{opp.excess_pct}% über Ø
                    </span>
                  </div>
                  <div className="flex items-center gap-4 mb-1.5">
                    <span className="text-xs text-text-tertiary">
                      Du: <span className="text-text-secondary font-mono">{formatCHF(opp.actual)}/M</span>
                    </span>
                    <span className="text-xs text-text-tertiary">
                      Peer Ø: <span className="text-orange-400/80 font-mono">{formatCHF(opp.peer_benchmark)}/M</span>
                    </span>
                    <span className="text-xs text-gain font-mono ml-auto">
                      → spare {formatCHF(opp.monthly_saving)}/M
                    </span>
                  </div>
                  {/* Visual bar comparison */}
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-tertiary w-8">Du</span>
                      <div className="flex-1 h-1.5 bg-bg-surface2 rounded-full overflow-hidden">
                        <div className="h-full bg-orange-500/70 rounded-full" style={{ width: "100%" }} />
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-tertiary w-8">Ø</span>
                      <div className="flex-1 h-1.5 bg-bg-surface2 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-accent/60 rounded-full"
                          style={{ width: `${Math.round((opp.peer_benchmark / opp.actual) * 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {peerData.peer_info && (
            <p className="text-xs text-text-tertiary mt-3 pt-3 border-t border-border/20">
              Vergleichsgruppe: {peerData.peer_info.age_range} Jahre · {peerData.peer_info.household_type} · {peerData.peer_info.peer_count.toLocaleString("de-CH")} Personen · Sparquote Ø {peerData.peer_info.savings_rate_pct}%
            </p>
          )}
        </div>
      )}

      {/* Category budgets */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-text-primary font-semibold text-sm">
            {isFuturePeriod ? "Erwartete Ausgaben nach Kategorie" : "Budgets nach Kategorie"}
          </h2>
          <div className="flex items-center gap-3">
            {peerData?.peer_info && (
              <div className="flex items-center gap-3 text-xs text-text-tertiary">
                <span className="flex items-center gap-1">
                  <span className="inline-block w-3 h-1.5 rounded-full bg-accent" />
                  Du
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-3 h-1.5 rounded-full bg-orange-500/70" />
                  Peer Ø ({peerData.peer_info.age_range} J. · {peerData.peer_info.household_type})
                </span>
              </div>
            )}
            <button
              onClick={() => setShowEditor(true)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-text-secondary border border-border/50 hover:bg-bg-surface2 hover:text-text-primary transition-colors"
              title="Transaktionen bearbeiten"
            >
              <Pencil className="w-3.5 h-3.5" />
              Bearbeiten
            </button>
          </div>
        </div>
        <div className="space-y-4">
          {(allCategories).map((cat: { category: string; total: number; isProjected?: boolean; frequency?: string; confidence?: number }) => {
            const budget = (budgets || []).find(
              (b: { category_id: number }) => b.category_id === null
            );
            const spent = cat.total;
            const limit = budget?.amount || 500;
            const pct = Math.min(100, (spent / limit) * 100);
            const over = spent > limit;

            // Inline peer benchmark (always shown when data available)
            const inlinePeer = peerBenchmarkByCat.get(cat.category) ?? null;

            // Comparison mode data (for wizard/combined/peer detail section)
            const comparison = comparisonByCategory.get(cat.category);
            const showComparison = analysisMode !== "past" && !!comparison;
            const peerVal = showComparison ? (comparison?.peer_benchmark ?? null) : inlinePeer;
            const plannedVal = comparison?.planned ?? null;
            const actualVal = comparison?.actual ?? spent;

            // Show grouped bars when: inline peer exists, OR in a comparison mode with data
            const showBars = inlinePeer != null || showComparison;
            const showPeer = showBars && peerVal != null;
            const showPlanned = showComparison && (analysisMode === "wizard" || analysisMode === "combined") && plannedVal != null;
            const compMax = showBars
              ? Math.max(actualVal, peerVal ?? 0, plannedVal ?? 0, 1)
              : limit;

            return (
              <div key={cat.category}>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-text-secondary text-sm">{cat.category || "Sonstige"}</span>
                    {cat.isProjected && (
                      <span className="inline-flex items-center gap-1 text-xs text-accent bg-accent/10 px-1.5 py-0.5 rounded">
                        <Sparkles className="w-3 h-3" />
                        {cat.frequency}
                      </span>
                    )}
                  </div>
                  <div className="text-right">
                    <span className={clsx("text-sm font-mono", over ? "text-loss" : "text-text-primary")}>
                      {formatCHF(spent)}
                    </span>
                    <span className="text-text-tertiary text-xs"> / {formatCHF(limit)}</span>
                    {cat.isProjected && cat.confidence !== undefined && (
                      <span className="text-text-tertiary text-xs ml-1">({cat.confidence}% sicher)</span>
                    )}
                  </div>
                </div>

                {showBars ? (
                  /* Grouped comparison bars */
                  <div className="space-y-1">
                    {/* Actual / "Du" */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-tertiary w-14 shrink-0 text-right">Du</span>
                      <div className="flex-1 h-2 bg-bg-surface2 rounded-full overflow-hidden">
                        <div
                          className={clsx("h-full rounded-full transition-all duration-500", over ? "bg-loss" : pct > 80 ? "bg-warning" : "bg-accent")}
                          style={{ width: `${Math.min(100, (actualVal / compMax) * 100)}%` }}
                        />
                      </div>
                      <span className="text-xs font-mono text-text-primary w-20 shrink-0">{formatCHF(actualVal)}</span>
                    </div>
                    {/* Peer benchmark */}
                    {showPeer && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-text-tertiary w-14 shrink-0 text-right">Peer Ø</span>
                        <div className="flex-1 h-2 bg-bg-surface2 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full bg-orange-500/70 transition-all duration-500"
                            style={{ width: `${Math.min(100, (peerVal! / compMax) * 100)}%` }}
                          />
                        </div>
                        <span className="text-xs font-mono text-orange-400 w-20 shrink-0">{formatCHF(peerVal!)}</span>
                      </div>
                    )}
                    {/* Wizard planned */}
                    {showPlanned && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-text-tertiary w-14 shrink-0 text-right">Planung</span>
                        <div className="flex-1 h-2 bg-bg-surface2 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full bg-violet-500/70 transition-all duration-500"
                            style={{ width: `${Math.min(100, (plannedVal! / compMax) * 100)}%` }}
                          />
                        </div>
                        <span className="text-xs font-mono text-violet-400 w-20 shrink-0">{formatCHF(plannedVal!)}</span>
                      </div>
                    )}
                  </div>
                ) : (
                  /* Single progress bar (past mode) */
                  <div className="h-2 bg-bg-surface2 rounded-full overflow-hidden">
                    <div
                      className={clsx(
                        "h-full rounded-full transition-all duration-500",
                        cat.isProjected ? "bg-accent/60" :
                        over ? "bg-loss" : pct > 80 ? "bg-warning" : "bg-accent"
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}

                <p className="text-text-tertiary text-xs mt-0.5 text-right">
                  {isFuturePeriod
                    ? `${formatCHF(limit - spent)} verfügbar`
                    : over
                      ? `${formatCHF(spent - limit)} über Budget`
                      : `${formatCHF(limit - spent)} verbleibend`
                  }
                </p>
              </div>
            );
          })}
          {(allCategories.length === 0) && (
            <p className="text-text-tertiary text-sm text-center py-8">
              {isFuturePeriod
                ? "Keine wiederkehrenden Ausgaben erkannt. Importiere mehr Transaktionen für bessere Prognosen."
                : "Keine Ausgaben in diesem Monat"}
            </p>
          )}
        </div>
      </div>

      {/* ── Multi-Modal Analysis Results ─────────────────────── */}
      {analysisMode !== "past" && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-text-primary font-semibold text-sm">
              {{
                wizard:   "Planung vs. Ist-Ausgaben",
                combined: "Kombinierte Analyse (60 % Ist / 40 % Planung)",
                peer:     "Peer-Vergleich: Deine Ausgaben vs. Benchmarks",
              }[analysisMode]}
            </h2>
            {multiAnalysis?.peer_info && (
              <span className="text-xs text-text-tertiary bg-bg-surface2 px-2 py-1 rounded">
                Vergleichsgruppe: {multiAnalysis.peer_info.age_range} Jahre ·{" "}
                {multiAnalysis.peer_info.household_type} ·{" "}
                {multiAnalysis.peer_info.peer_count.toLocaleString("de-CH")} Personen
              </span>
            )}
          </div>

          {isMultiLoading && (
            <p className="text-text-tertiary text-sm text-center py-8">Analyse wird berechnet…</p>
          )}

          {!isMultiLoading && multiAnalysis && (
            <>
              {/* Summary row */}
              <div className="grid grid-cols-3 gap-3 mb-4">
                <div className="bg-bg-surface2 rounded-lg p-3">
                  <p className="text-text-tertiary text-xs mb-1">Einnahmen</p>
                  <p className="text-gain font-mono font-semibold">{formatCHF(multiAnalysis.income)}</p>
                </div>
                <div className="bg-bg-surface2 rounded-lg p-3">
                  <p className="text-text-tertiary text-xs mb-1">Ausgaben</p>
                  <p className="text-loss font-mono font-semibold">{formatCHF(multiAnalysis.total_expenses)}</p>
                </div>
                <div className="bg-bg-surface2 rounded-lg p-3">
                  <p className="text-text-tertiary text-xs mb-1">Sparquote</p>
                  <p className={clsx("font-mono font-semibold", multiAnalysis.savings_rate >= 0 ? "text-gain" : "text-loss")}>
                    {multiAnalysis.savings_rate.toFixed(1)} %
                  </p>
                </div>
              </div>

              {/* Category table */}
              {multiAnalysis.categories.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border/50 text-text-tertiary text-xs">
                        <th className="text-left py-2 pr-3">Kategorie</th>
                        {analysisMode === "wizard" && <th className="text-right py-2 px-3">Planung</th>}
                        {(analysisMode === "wizard" || analysisMode === "combined") && (
                          <th className="text-right py-2 px-3">Ist</th>
                        )}
                        {analysisMode === "combined" && <th className="text-right py-2 px-3">Gewichtet</th>}
                        {analysisMode === "peer" && <th className="text-right py-2 px-3">Deine Ausgaben</th>}
                        {analysisMode === "peer" && <th className="text-right py-2 px-3">Benchmark</th>}
                        {analysisMode === "peer" && <th className="text-right py-2 px-3">Delta</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/30">
                      {multiAnalysis.categories.map((cat) => (
                        <tr key={cat.category} className="hover:bg-bg-surface2/50">
                          <td className="py-2 pr-3 text-text-secondary font-medium">{cat.category}</td>

                          {/* Wizard columns */}
                          {analysisMode === "wizard" && (
                            <td className="text-right py-2 px-3 font-mono text-text-primary">
                              {cat.planned != null ? formatCHF(cat.planned) : "—"}
                            </td>
                          )}
                          {(analysisMode === "wizard") && (
                            <td className="text-right py-2 px-3 font-mono text-text-tertiary">
                              {cat.actual != null ? formatCHF(cat.actual) : "—"}
                            </td>
                          )}

                          {/* Combined columns */}
                          {analysisMode === "combined" && (
                            <>
                              <td className="text-right py-2 px-3 font-mono text-text-tertiary">
                                {cat.actual != null ? formatCHF(cat.actual) : "—"}
                              </td>
                              <td className="text-right py-2 px-3 font-mono text-text-primary font-medium">
                                {cat.blended != null ? formatCHF(cat.blended) : "—"}
                              </td>
                            </>
                          )}

                          {/* Peer columns */}
                          {analysisMode === "peer" && (
                            <>
                              <td className="text-right py-2 px-3 font-mono text-text-primary">
                                {cat.actual != null ? formatCHF(cat.actual) : "—"}
                              </td>
                              <td className="text-right py-2 px-3 font-mono text-text-tertiary">
                                {cat.peer_benchmark != null ? formatCHF(cat.peer_benchmark) : "—"}
                              </td>
                              <td className="text-right py-2 px-3 font-mono">
                                {cat.delta_vs_peer != null ? (
                                  <span className={clsx(
                                    "inline-flex items-center gap-1",
                                    cat.delta_vs_peer > 0 ? "text-loss" : "text-gain"
                                  )}>
                                    {cat.delta_vs_peer > 0
                                      ? <TrendingUp className="w-3 h-3" />
                                      : cat.delta_vs_peer < 0
                                        ? <TrendingDown className="w-3 h-3" />
                                        : <Minus className="w-3 h-3" />
                                    }
                                    {formatCHF(Math.abs(cat.delta_vs_peer))}
                                  </span>
                                ) : "—"}
                              </td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-text-tertiary text-sm text-center py-8">
                  {analysisMode === "wizard"
                    ? "Keine Wizard-Planungsdaten vorhanden. Bitte Setup-Wizard abschliessen."
                    : "Keine Daten für diesen Zeitraum verfügbar."}
                </p>
              )}

              {/* Peer info banner */}
              {multiAnalysis.peer_info && analysisMode === "peer" && (
                <div className="mt-4 border-t border-border/30 pt-3 text-xs text-text-tertiary flex flex-wrap gap-4">
                  <span>Median-Einkommen Peer-Gruppe: <span className="text-text-secondary font-mono">{formatCHF(multiAnalysis.peer_info.median_income)}</span></span>
                  <span>Sparquote Peer-Gruppe: <span className="text-text-secondary">{multiAnalysis.peer_info.savings_rate_pct} %</span></span>
                  <span className="ml-auto text-slate-600">Grün = unter Durchschnitt (gut) · Rot = über Durchschnitt</span>
                </div>
              )}
            </>
          )}
        </div>
      )}
      {showEditor && (
        <TransactionSidebarEditor
          transactions={periodTransactions}
          periodLabel={range.label}
          onClose={() => setShowEditor(false)}
        />
      )}
    </div>
  );
}
