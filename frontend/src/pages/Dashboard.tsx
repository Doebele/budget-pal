import { useMemo, useState, lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowDownRight, ArrowRight, ArrowUpRight, GraphUp, MagicWand, PageUp, Position, Reports, Upload, Wallet } from "@/lib/icons";
import { transactionsApi, accountsApi, budgetsApi, goalsApi } from "@/lib/api";
import NetIncomeCard from "@/components/NetIncomeCard";
import HealthScoreWidget from "@/components/HealthScoreWidget";
import { formatCHF } from "@/lib/theme";
import { format } from "date-fns";
import type { SankeyFlowOrder, SankeyLink } from "@/components/charts/SankeyChart";

const SankeyChart = lazy(() => import("@/components/charts/SankeyChart"));
import GranularityNavigator from "@/components/GranularityNavigator";
import { computeDateRange, TimeGranularity } from "@/lib/granularity";
import { clsx } from "clsx";
import { useTaxonomy, type SuperCategory } from "@/lib/categories";
import { deduplicateWizardBatch } from "@/lib/wizardUtils";

// ── Stat card ─────────────────────────────────────────────────

function StatCard({
  label,
  value,
  delta,
  periodHint,
  icon: Icon,
  colorClass = "text-text-primary",
}: {
  label: string;
  value: string;
  delta?: number;
  periodHint?: string;
  icon: React.ElementType;
  colorClass?: string;
}) {
  return (
    <div className="card flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-text-tertiary text-xs uppercase tracking-wide">{label}</span>
        <div className="w-8 h-8 rounded-lg bg-bg-surface2 flex items-center justify-center">
          <Icon className="w-4 h-4 text-text-tertiary" />
        </div>
      </div>
      {periodHint && (
        <p className="text-text-tertiary text-xs -mt-2 truncate" title={periodHint}>
          {periodHint}
        </p>
      )}
      <div>
        <p className={clsx("text-2xl font-mono font-semibold", colorClass)}>{value}</p>
        {delta !== undefined && (
          <p className={clsx("text-xs mt-1 flex items-center gap-1", delta >= 0 ? "text-gain" : "text-loss")}>
            {delta >= 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
            {Math.abs(delta).toFixed(1)}% ggü. Vormonat
          </p>
        )}
      </div>
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────

export default function Dashboard() {
  const { resolveSuperCategory, superCategories } = useTaxonomy();
  const [granularity, setGranularity] = useState<TimeGranularity>("ytd");
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [sankeyFlowOrder, setSankeyFlowOrder] = useState<SankeyFlowOrder>("value");

  const range = useMemo(() => computeDateRange(granularity, anchor), [granularity, anchor]);
  const periodStart = format(range.from, "yyyy-MM-dd");
  const periodEnd   = format(range.to,   "yyyy-MM-dd");

  // Number of calendar months in the selected period (for wizard scaling)
  const months = useMemo(() => Math.max(
    1,
    (range.to.getFullYear() - range.from.getFullYear()) * 12 +
    (range.to.getMonth() - range.from.getMonth()) + 1,
  ), [range]);

  const { data: stats } = useQuery({
    queryKey: ["transaction-stats", granularity, anchor.toISOString(), periodStart, periodEnd],
    queryFn: () =>
      transactionsApi.stats({ start: periodStart, end: periodEnd }).then((r) => r.data),
  });

  const { data: accounts } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => accountsApi.list().then((r) => r.data),
  });

  const { data: recentTxns } = useQuery({
    queryKey: ["recent-transactions"],
    queryFn: () => transactionsApi.list({ limit: 8 }).then((r) => r.data),
  });

  const { data: wizardBudgets, isLoading: wizardLoading } = useQuery({
    queryKey: ["wizard-budgets-dashboard"],
    queryFn: () => budgetsApi.list().then((r) => r.data),
    staleTime: 60_000,
  });

  const { data: goals } = useQuery({
    queryKey: ["goals"],
    queryFn: () => goalsApi.list().then((r) => r.data as Array<{
      id: number; name: string; goal_type: string;
      target_amount: number; current_amount: number; progress_pct: number;
      months_to_target?: number | null; is_achieved: boolean;
    }>),
    staleTime: 60_000,
  });

  const totalBalance = (accounts || []).reduce(
    (sum: number, a: { balance: number }) => sum + a.balance, 0
  );

  const sparenSuper = useMemo(
    () => superCategories.find((s) => s.id === "sparen"),
    [superCategories],
  );

  const superCategoryOrderIds = useMemo(
    () => superCategories.map((s) => s.id),
    [superCategories],
  );

  const sankeyDataReal = useMemo(
    () => buildSankeyDataReal(stats, resolveSuperCategory, sparenSuper),
    [stats, resolveSuperCategory, sparenSuper],
  );

  const sankeyDataEmpirical = useMemo(
    () => buildSankeyDataEmpirical(wizardBudgets, months, resolveSuperCategory, sparenSuper),
    [wizardBudgets, months, resolveSuperCategory, sparenSuper],
  );

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-display text-text-primary">Dashboard</h1>
          <p className="text-text-tertiary text-sm mt-0.5">{range.label}</p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center lg:justify-end">
          <GranularityNavigator
            granularity={granularity}
            anchor={anchor}
            onChange={(g, a) => {
              setGranularity(g);
              setAnchor(a);
            }}
          />
          <div className="flex gap-2 flex-wrap">
            <Link to="/import" className="btn-secondary flex items-center gap-2">
              <Upload className="w-4 h-4" />
              Import
            </Link>
            <Link to="/projections" className="btn-primary flex items-center gap-2">
              <GraphUp className="w-4 h-4" />
              Prognosen
            </Link>
          </div>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard
          label="Gesamtvermögen"
          value={formatCHF(totalBalance, true)}
          icon={Wallet}
          colorClass="text-text-primary"
        />
        <StatCard
          label="Einnahmen"
          periodHint={range.label}
          value={formatCHF(stats?.total_income || 0)}
          icon={ArrowUpRight}
          colorClass="text-gain"
        />
        <StatCard
          label="Ausgaben"
          periodHint={range.label}
          value={formatCHF(stats?.total_expenses || 0)}
          icon={ArrowDownRight}
          colorClass="text-loss"
        />
        <StatCard
          label="Netto"
          periodHint={range.label}
          value={formatCHF((stats?.total_income || 0) - (stats?.total_expenses || 0))}
          icon={GraphUp}
          colorClass={(stats?.net || 0) >= 0 ? "text-gain" : "text-loss"}
        />
      </div>

      {/* Net income + Health Score row */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="md:col-span-1">
          <NetIncomeCard compact />
        </div>
        <div className="md:col-span-3">
          <HealthScoreWidget />
        </div>
      </div>

      {/* Cashflow — Reale vs. Empirische nebeneinander */}
      <div className="card">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-text-primary font-semibold text-sm">Cashflow</h2>
            <p className="text-text-tertiary text-xs mt-0.5">{range.label}</p>
          </div>
          <div
            className="flex rounded-lg border border-border overflow-hidden text-xs shrink-0"
            role="group"
            aria-label="Sankey-Sortierung"
          >
            <button
              type="button"
              onClick={() => setSankeyFlowOrder("value")}
              className={clsx(
                "px-2.5 py-1.5 transition-colors",
                sankeyFlowOrder === "value"
                  ? "bg-accent text-white"
                  : "text-text-tertiary hover:text-text-primary hover:bg-bg-surface2",
              )}
            >
              Nach Betrag
            </button>
            <button
              type="button"
              onClick={() => setSankeyFlowOrder("superCategory")}
              className={clsx(
                "px-2.5 py-1.5 transition-colors border-l border-border",
                sankeyFlowOrder === "superCategory"
                  ? "bg-accent text-white"
                  : "text-text-tertiary hover:text-text-primary hover:bg-bg-surface2",
              )}
            >
              Nach Kategorien
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 xl:gap-8">
          <div className="min-w-0">
            <h3 className="text-text-secondary text-xs font-semibold uppercase tracking-wide mb-3">
              Reale Angaben
            </h3>
            {sankeyDataReal.links.length > 0 ? (
              <Suspense
                fallback={
                  <div
                    style={{ height: 320 }}
                    className="animate-pulse rounded-xl bg-bg-surface2"
                  />
                }
              >
                <SankeyChart
                  data={sankeyDataReal}
                  height={320}
                  flowOrder={sankeyFlowOrder}
                  superCategoryOrder={superCategoryOrderIds}
                />
              </Suspense>
            ) : (
              <div className="h-56 flex items-center justify-center text-text-tertiary text-sm text-center px-3 rounded-xl bg-bg-surface2/40 border border-border/30">
                {`Noch keine Transaktionen im gewählten Zeitraum (${range.label})`}
              </div>
            )}
          </div>

          <div className="min-w-0">
            <h3 className="text-text-secondary text-xs font-semibold uppercase tracking-wide mb-3">
              Empirische Angaben
            </h3>
            {wizardLoading ? (
              <div className="h-56 flex items-center justify-center text-text-tertiary text-sm rounded-xl bg-bg-surface2/40 border border-border/30">
                Lade empirische Angaben…
              </div>
            ) : sankeyDataEmpirical.links.length > 0 ? (
              <Suspense
                fallback={
                  <div
                    style={{ height: 320 }}
                    className="animate-pulse rounded-xl bg-bg-surface2"
                  />
                }
              >
                <SankeyChart
                  data={sankeyDataEmpirical}
                  height={320}
                  flowOrder={sankeyFlowOrder}
                  superCategoryOrder={superCategoryOrderIds}
                />
              </Suspense>
            ) : (
              <div className="h-56 flex items-center justify-center text-text-tertiary text-sm text-center px-3 rounded-xl bg-bg-surface2/40 border border-border/30">
                Keine empirischen Angaben. Bitte zuerst den Setup-Wizard abschliessen.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Top Ausgaben-Kategorien + Letzte Transaktionen (nebeneinander ab xl) */}
      <div
        className={clsx(
          "grid grid-cols-1 gap-4",
          stats?.top_categories && stats.top_categories.length > 0 && "xl:grid-cols-2",
        )}
      >
        {stats?.top_categories && stats.top_categories.length > 0 && (
          <div className="card">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between mb-4">
              <h2 className="text-text-primary font-semibold text-sm">Top Ausgaben-Kategorien</h2>
              <span className="text-text-tertiary text-xs">{range.label}</span>
            </div>
            <div className="space-y-3">
              {stats.top_categories.slice(0, 10).map((cat: { category: string; total: number }) => {
                const sc = resolveSuperCategory(cat.category);
                const pct = stats.total_expenses > 0 ? (cat.total / stats.total_expenses) * 100 : 0;
                return (
                  <div key={cat.category}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="flex items-center gap-1.5 text-text-secondary text-xs">
                        <span
                          className="w-4 h-4 rounded flex items-center justify-center shrink-0"
                          style={{ backgroundColor: sc.color + "22" }}
                        >
                          <sc.icon className="w-2.5 h-2.5" style={{ color: sc.color }} />
                        </span>
                        {cat.category || "Sonstige"}
                      </span>
                      <span className="text-text-primary text-xs font-mono">{formatCHF(cat.total)}</span>
                    </div>
                    <div className="h-1.5 bg-bg-surface2 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{
                          width: `${Math.min(100, pct)}%`,
                          backgroundColor: sc.color,
                          opacity: 0.75,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="card flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-text-primary font-semibold text-sm">Letzte Transaktionen</h2>
            <Link to="/transactions" className="text-accent text-xs flex items-center gap-1 hover:text-accent-light">
              Alle <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="space-y-2 flex-1">
            {(recentTxns || []).slice(0, 8).map((txn: {
              id: number;
              merchant_normalized?: string;
              description: string;
              category?: string;
              date: string;
              amount: number;
              currency: string;
            }) => {
              const sc = resolveSuperCategory(txn.category || "");
              if (!sc) return null;
              return (
                <div key={txn.id} className="flex items-center justify-between py-1.5">
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0"
                      style={{ backgroundColor: sc.color + "22" }}
                    >
                      <sc.icon className="w-3.5 h-3.5" style={{ color: sc.color }} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-text-primary text-xs font-medium truncate">
                        {txn.merchant_normalized || txn.description.slice(0, 30)}
                      </p>
                      <p className="text-text-tertiary text-xs">
                        {format(new Date(txn.date), "dd.MM.")} · {txn.category || "Unkategorisiert"}
                      </p>
                    </div>
                  </div>
                  <span className={clsx("text-xs font-mono flex-shrink-0 ml-2", txn.amount >= 0 ? "text-gain" : "text-loss")}>
                    {txn.amount >= 0 ? "+" : ""}{formatCHF(txn.amount)}
                  </span>
                </div>
              );
            })}
            {(!recentTxns || recentTxns.length === 0) && (
              <p className="text-text-tertiary text-xs text-center py-8">Keine Transaktionen</p>
            )}
          </div>
        </div>
      </div>

      {/* Goals widget */}
      {goals && goals.length > 0 && (
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-text-primary font-semibold text-sm flex items-center gap-2">
              <Position className="w-4 h-4 text-accent" />
              Sparziele
            </h2>
            <Link to="/goals" className="text-accent text-xs flex items-center gap-1 hover:text-accent-light">
              Alle <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {goals.filter(g => !g.is_achieved).slice(0, 3).map((g) => {
              const COLORS: Record<string, string> = {
                savings: "#10b981", debt_payoff: "#f43f5e",
                emergency_fund: "#3b82f6", purchase: "#f59e0b",
                retirement: "#a78bfa", other: "#6b7280",
              };
              const color = COLORS[g.goal_type] ?? "#6b7280";
              return (
                <div key={g.id} className="bg-bg-surface2 rounded-xl p-3 border border-border/50">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-text-primary text-xs font-medium truncate">{g.name}</p>
                    <span className="text-xs font-mono text-text-tertiary shrink-0 ml-2">
                      {g.progress_pct.toFixed(0)}%
                    </span>
                  </div>
                  <div className="h-1.5 bg-bg-surface rounded-full overflow-hidden mb-1.5">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${Math.min(100, g.progress_pct)}%`, backgroundColor: color }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] text-text-tertiary">
                    <span>{formatCHF(g.current_amount)}</span>
                    {g.months_to_target != null && g.months_to_target > 0 && (
                      <span>~{g.months_to_target} Monate</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Quick nav */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        {[
          { to: "/transactions", label: "Reale Angaben",     desc: "Alle ansehen & filtern", Icon: Reports  },
          { to: "/wizard",       label: "Empirische Angaben", desc: "Profil & Planungsdaten", Icon: MagicWand      },
          { to: "/goals",        label: "Sparziele",          desc: "Ziele verwalten",         Icon: Position     },
          { to: "/projections",  label: "Prognosen",         desc: "Monte Carlo & Rente",     Icon: GraphUp },
          { to: "/import",       label: "Import",            desc: "CSV / PDF hochladen",     Icon: PageUp     },
        ].map(({ to, label, desc, Icon }) => (
          <Link
            key={to}
            to={to}
            className="card hover:border-accent/30 transition-colors cursor-pointer group"
          >
            <Icon className="w-7 h-7 mb-2 text-accent" />
            <p className="text-text-primary text-sm font-semibold group-hover:text-accent transition-colors">{label}</p>
            <p className="text-text-tertiary text-xs mt-0.5">{desc}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ── Sankey data builders ──────────────────────────────────────

interface StatsPayload {
  total_income?: number;
  total_expenses?: number;
  top_categories?: Array<{ category: string; total: number }>;
  top_income_categories?: Array<{ category: string; total: number }>;
}

type ResolveSuper = (name: string, isWizard?: boolean) => SuperCategory;

/**
 * Unterkategorien mit gleichem Namen (nur Schreibweise) zusammenführen;
 * Anzeige = kanonischer Txn-Name aus der Taxonomie, falls vorhanden.
 */
function mergeSubItemsForSuper(
  subs: Array<{ label: string; value: number }>,
  sc: SuperCategory,
): Array<{ label: string; value: number }> {
  const byKey = new Map<string, { label: string; value: number }>();
  for (const s of subs) {
    const key = s.label.trim().toLowerCase();
    if (!key) continue;
    const canonical =
      sc.txnCategories.find((t) => t.toLowerCase() === key) ??
      sc.legacyAliases?.find((a) => a.toLowerCase() === key);
    const display = canonical ?? s.label.trim();
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { label: display, value: s.value });
    } else {
      prev.value += s.value;
    }
  }
  return [...byKey.values()];
}

/** Skaliert Unterknoten so ihre Summe der Zielbreite des Mittelknotens entspricht (Sankey-Konsistenz). */
function scaleSubsToTotal(
  subs: Array<{ label: string; value: number }>,
  targetTotal: number,
): Array<{ label: string; value: number }> {
  if (targetTotal <= 0) return [];
  if (subs.length === 0) return [{ label: "Überschuss", value: targetTotal }];
  const sum = subs.reduce((s, x) => s + x.value, 0);
  if (sum <= 0) return [{ label: "Überschuss", value: targetTotal }];
  const k = targetTotal / sum;
  return subs.map((x) => ({ label: x.label, value: x.value * k }));
}

function buildSparenSubsFromIncomeRows(
  rows: Array<{ category: string; total: number }> | undefined,
  resolveSuperCategory: ResolveSuper,
  sparenSuper: SuperCategory | undefined,
): Array<{ label: string; value: number }> {
  const raw: Array<{ label: string; value: number }> = [];
  for (const row of rows || []) {
    if (row.total <= 0) continue;
    const name = (row.category || "").trim();
    if (!name) continue;
    let sc = resolveSuperCategory(name, false);
    if (sc.id !== "sparen") {
      sc = resolveSuperCategory(name, true);
    }
    if (sc.id !== "sparen") continue;
    raw.push({ label: name, value: row.total });
  }
  if (!sparenSuper || raw.length === 0) return raw;
  return mergeSubItemsForSuper(raw, sparenSuper);
}

/** Summe der Unterkanten an den skalierten Mittelkantenwert anbinden (Rundungsdrift / Nullwerte). */
function subItemsForSankeyLink(
  subs: Array<{ label: string; value: number }>,
  parentScaled: number,
  source: "txn" | "wizard",
): Array<{ label: string; value: number; source: "txn" | "wizard" }> {
  if (parentScaled <= 0) return [];
  const scaled = subs
    .filter((s) => s.label?.trim())
    .map((s) => ({
      label: s.label.trim(),
      value: Math.max(0, Math.round(s.value * 100) / 100),
    }))
    .filter((s) => s.value > 0);
  if (scaled.length === 0) {
    return [{ label: "Überschuss (nicht kategorisiert)", value: parentScaled, source }];
  }
  const sum = scaled.reduce((a, b) => a + b.value, 0);
  if (sum <= 0) {
    return [{ label: "Überschuss (nicht kategorisiert)", value: parentScaled, source }];
  }
  const factor = parentScaled / sum;
  const out = scaled.map((s) => ({
    label: s.label,
    value: Math.round(s.value * factor * 100) / 100,
    source,
  }));
  const drift = parentScaled - out.reduce((a, b) => a + b.value, 0);
  if (Math.abs(drift) >= 0.01 && out.length > 0) {
    out[0] = { ...out[0], value: Math.round((out[0].value + drift) * 100) / 100 };
  }
  return out.filter((x) => x.value > 0);
}

/** Build Sankey from real transaction data, grouped by supercategory */
function buildSankeyDataReal(
  stats: StatsPayload | undefined,
  resolveSuperCategory: ResolveSuper,
  sparenSuper: SuperCategory | undefined,
) {
  if (!stats?.total_income || stats.total_income <= 0) {
    return { nodes: [], links: [] };
  }

  const income   = stats.total_income;
  const expenses = stats.total_expenses || 0;
  const savings  = Math.max(0, income - expenses);

  // Group top_categories into supercategories
  const superMap = new Map<
    string,
    { sc: SuperCategory; total: number; subs: Array<{ label: string; value: number }> }
  >();

  for (const cat of (stats.top_categories || [])) {
    if (cat.total <= 0) continue;
    const sc = resolveSuperCategory(cat.category, false);
    if (sc.id === "sparen") continue; // skip salary / income rows

    if (!superMap.has(sc.id)) {
      superMap.set(sc.id, { sc, total: 0, subs: [] });
    }
    const agg = superMap.get(sc.id)!;
    agg.total += cat.total;
    agg.subs.push({ label: cat.category, value: cat.total });
  }

  for (const agg of superMap.values()) {
    agg.subs = mergeSubItemsForSuper(agg.subs, agg.sc);
    agg.total = agg.subs.reduce((s, x) => s + x.value, 0);
  }

  // Ausgaben-Segmente nach Taxonomie-Super (mittlere Spalte), max. 8; «Sparen» = Rest unten.
  // «Sonstiges» (nicht klassifizierte Transaktionen) wird ausgeblendet.
  const expSegments = [...superMap.values()]
    .filter((e) => e.total > 0 && e.sc.id !== "sonstiges")
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  const sparenSubsMerged = buildSparenSubsFromIncomeRows(
    stats.top_income_categories,
    resolveSuperCategory,
    sparenSuper,
  );
  const sparenSubs = scaleSubsToTotal(sparenSubsMerged, savings);

  const segments: Array<{
    id: string;
    value: number;
    color: string;
    subs: Array<{ label: string; value: number }>;
    superCategoryId: string;
  }> = [
    ...expSegments.map((e) => ({
      id: e.sc.label,
      value: e.total,
      color: e.sc.color,
      subs: e.subs,
      superCategoryId: e.sc.id,
    })),
    ...(savings > 0
      ? [{
          id: "Sparen",
          value: savings,
          color: sparenSuper?.color ?? "#10b981",
          subs: sparenSubs,
          superCategoryId: "sparen",
        }]
      : []),
  ];

  if (!segments.length) return { nodes: [], links: [] };

  const totalSeg = segments.reduce((s, f) => s + f.value, 0);
  const scale    = totalSeg > income ? income / totalSeg : 1;

  const nodes = [{ id: "Einnahmen" }, ...segments.map((s) => ({ id: s.id }))];
  const links: SankeyLink[] = segments.map((s) => {
    const parentScaled = Math.round(s.value * scale * 100) / 100;
    const subsSorted = [...s.subs].sort((a, b) => b.value - a.value);
    const scaledSubs = subsSorted.map((sub) => ({
      label: sub.label,
      value: Math.round(sub.value * scale * 100) / 100,
    }));
    return {
      source: "Einnahmen",
      target: s.id,
      value: parentScaled,
      color: s.color,
      superCategoryId: s.superCategoryId,
      subItems:
        scaledSubs.length > 0
          ? subItemsForSankeyLink(scaledSubs, parentScaled, "txn")
          : undefined,
    };
  });

  return { nodes, links };
}

/** Build Sankey from wizard (empirical) budget data, grouped by supercategory */
function buildSankeyDataEmpirical(
  budgetsRaw: Array<{ id: number; notes: string | null; amount: number; created_at?: string }> | undefined,
  months: number,
  resolveSuperCategory: ResolveSuper,
  sparenSuper: SuperCategory | undefined,
) {
  if (!budgetsRaw || budgetsRaw.length === 0) return { nodes: [], links: [] };

  // Only entries that have a notes label (= wizard-created entries)
  const withNotes = budgetsRaw.filter((b) => b.notes && b.notes.trim() !== "");
  if (!withNotes.length) return { nodes: [], links: [] };

  // Deduplicate: latest batch by created_at, fallback to highest-id per label
  const latest = deduplicateWizardBatch(withNotes);

  // Group by supercategory (monthly amounts → scale by months)
  const superMap = new Map<
    string,
    { sc: SuperCategory; total: number; subs: Array<{ label: string; value: number }> }
  >();

  let monthlyIncome = 0;
  const sparenIncomeRaw: Array<{ label: string; value: number }> = [];

  for (const b of latest) {
    const label = b.notes || "Sonstiges";
    const sc = resolveSuperCategory(label, true);

    if (sc.id === "sparen") {
      monthlyIncome += b.amount;
      sparenIncomeRaw.push({ label, value: b.amount * months });
      continue;
    }

    const periodAmt = b.amount * months;
    if (!superMap.has(sc.id)) {
      superMap.set(sc.id, { sc, total: 0, subs: [] });
    }
    const agg = superMap.get(sc.id)!;
    agg.total += periodAmt;
    agg.subs.push({ label, value: periodAmt });
  }

  for (const agg of superMap.values()) {
    // For wizard data, keep the raw wizard label as-is (no txnCategory mapping).
    // Deduplicate by label. Suppress sub items whose name is identical to the
    // parent supercategory label (would render as a meaningless duplicate node).
    // The segment total is kept regardless so the middle node has correct width.
    const rawTotal = agg.subs.reduce((s, x) => s + x.value, 0);
    const byLabel = new Map<string, number>();
    for (const sub of agg.subs) {
      if (sub.label.toLowerCase() === agg.sc.label.toLowerCase()) continue;
      byLabel.set(sub.label, (byLabel.get(sub.label) ?? 0) + sub.value);
    }
    agg.subs = [...byLabel.entries()].map(([label, value]) => ({ label, value }));
    agg.total = rawTotal; // always keep original total for correct node width
  }

  const expSegments = [...superMap.values()]
    .filter((e) => e.total > 0 && e.sc.id !== "sonstiges") // hide unclassified entries
    .sort((a, b) => b.total - a.total);

  const totalExp = expSegments.reduce((s, e) => s + e.total, 0);

  // If wizard has no income entries, estimate income = expenses / 0.7 (≈ 30% savings)
  const income = monthlyIncome > 0 ? monthlyIncome * months : totalExp / 0.70;
  const savings = Math.max(0, income - totalExp);

  const sparenSubsMerged = sparenSuper
    ? mergeSubItemsForSuper(sparenIncomeRaw, sparenSuper)
    : sparenIncomeRaw;
  const sparenSubs = scaleSubsToTotal(sparenSubsMerged, savings);

  const segments: Array<{
    id: string;
    value: number;
    color: string;
    subs: Array<{ label: string; value: number }>;
    superCategoryId: string;
  }> = [
    ...expSegments.map((e) => ({
      id: e.sc.label,
      value: e.total,
      color: e.sc.color,
      subs: e.subs,
      superCategoryId: e.sc.id,
    })),
    ...(savings > 0
      ? [{
          id: "Sparen",
          value: savings,
          color: sparenSuper?.color ?? "#10b981",
          subs: sparenSubs,
          superCategoryId: "sparen",
        }]
      : []),
  ];

  if (!segments.length) return { nodes: [], links: [] };

  const totalSeg = segments.reduce((s, f) => s + f.value, 0);
  const scale    = totalSeg > income ? income / totalSeg : 1;

  const nodes = [{ id: "Einnahmen" }, ...segments.map((s) => ({ id: s.id }))];
  const links: SankeyLink[] = segments.map((s) => {
    const parentScaled = Math.round(s.value * scale * 100) / 100;
    const subsSorted = [...s.subs].sort((a, b) => b.value - a.value);
    const scaledSubs = subsSorted.map((sub) => ({
      label: sub.label,
      value: Math.round(sub.value * scale * 100) / 100,
    }));
    return {
      source: "Einnahmen",
      target: s.id,
      value: parentScaled,
      color: s.color,
      superCategoryId: s.superCategoryId,
      subItems:
        scaledSubs.length > 0
          ? subItemsForSankeyLink(scaledSubs, parentScaled, "wizard")
          : undefined,
    };
  });

  return { nodes, links };
}
