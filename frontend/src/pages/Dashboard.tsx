import { useMemo, useState, lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  ArrowUpRight, ArrowDownRight, Wallet, TrendingUp,
  Upload, ArrowRight, BarChart3, Target, FileUp, Wand2,
} from "lucide-react";
import { transactionsApi, accountsApi, budgetsApi } from "@/lib/api";
import { formatCHF } from "@/lib/theme";
import { format } from "date-fns";
import type { SankeyLink } from "@/components/charts/SankeyChart";

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
  const [sankeySource, setSankeySource] = useState<"real" | "empirisch">("real");

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

  // Fetch wizard budgets for the Empirisch Sankey view (always fetched so toggle is instant)
  const { data: wizardBudgets, isLoading: wizardLoading } = useQuery({
    queryKey: ["wizard-budgets-dashboard"],
    queryFn: () => budgetsApi.list().then((r) => r.data),
    staleTime: 60_000,
  });

  const totalBalance = (accounts || []).reduce(
    (sum: number, a: { balance: number }) => sum + a.balance, 0
  );

  // ── Sankey data (mode-aware) ───────────────────────────────────
  const sparenSuper = useMemo(
    () => superCategories.find((s) => s.id === "sparen"),
    [superCategories],
  );

  const sankeyData = useMemo(() => {
    if (sankeySource === "empirisch") {
      return buildSankeyDataEmpirical(wizardBudgets, months, resolveSuperCategory, sparenSuper);
    }
    return buildSankeyDataReal(stats, resolveSuperCategory, sparenSuper);
  }, [sankeySource, stats, wizardBudgets, months, resolveSuperCategory, sparenSuper]);

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
              <TrendingUp className="w-4 h-4" />
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
          icon={TrendingUp}
          colorClass={(stats?.net || 0) >= 0 ? "text-gain" : "text-loss"}
        />
      </div>

      {/* Sankey + Recent transactions */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* Sankey cash flow */}
        <div className="xl:col-span-2 card">
          <div className="mb-4 flex items-start justify-between gap-2">
            <div>
              <h2 className="text-text-primary font-semibold text-sm">Cashflow</h2>
              <p className="text-text-tertiary text-xs mt-0.5">{range.label}</p>
            </div>
            {/* Source toggle */}
            <div className="flex rounded-lg border border-border overflow-hidden text-xs shrink-0">
              <button
                onClick={() => setSankeySource("real")}
                className={clsx(
                  "px-2.5 py-1.5 transition-colors",
                  sankeySource === "real"
                    ? "bg-accent text-white"
                    : "text-text-tertiary hover:text-text-primary hover:bg-bg-surface2",
                )}
              >
                Reale Angaben
              </button>
              <button
                onClick={() => setSankeySource("empirisch")}
                className={clsx(
                  "px-2.5 py-1.5 transition-colors border-l border-border",
                  sankeySource === "empirisch"
                    ? "bg-accent text-white"
                    : "text-text-tertiary hover:text-text-primary hover:bg-bg-surface2",
                )}
              >
                Empirische Angaben
              </button>
            </div>
          </div>

          {sankeyData.links.length > 0 ? (
            <Suspense
              fallback={
                <div
                  style={{ height: 360 }}
                  className="animate-pulse rounded-xl bg-bg-surface2"
                />
              }
            >
              <SankeyChart data={sankeyData} height={360} />
            </Suspense>
          ) : (
            <div className="h-64 flex items-center justify-center text-text-tertiary text-sm text-center px-4">
              {sankeySource === "empirisch" && wizardLoading
                ? "Lade empirische Angaben…"
                : sankeySource === "empirisch"
                  ? "Keine empirischen Angaben. Bitte zuerst den Setup-Wizard abschliessen."
                  : `Noch keine Transaktionen im gewählten Zeitraum (${range.label})`}
            </div>
          )}
        </div>

        {/* Recent transactions */}
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

      {/* Top categories */}
      {stats?.top_categories && stats.top_categories.length > 0 && (
        <div className="card">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between mb-4">
            <h2 className="text-text-primary font-semibold text-sm">Top Ausgaben-Kategorien</h2>
            <span className="text-text-tertiary text-xs">{range.label}</span>
          </div>
          <div className="space-y-3">
            {stats.top_categories.slice(0, 6).map((cat: { category: string; total: number }) => {
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

      {/* Quick nav */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        {[
          { to: "/transactions", label: "Reale Angaben",     desc: "Alle ansehen & filtern", Icon: BarChart3  },
          { to: "/wizard",       label: "Empirische Angaben", desc: "Profil & Planungsdaten", Icon: Wand2      },
          { to: "/budget",       label: "Budgetanalyse",     desc: "Ziele verwalten",         Icon: Target     },
          { to: "/projections",  label: "Prognosen",         desc: "Monte Carlo & Rente",     Icon: TrendingUp },
          { to: "/import",       label: "Import",            desc: "CSV / PDF hochladen",     Icon: FileUp     },
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
    id: string; value: number; color: string;
    subs: Array<{ label: string; value: number }>;
  }> = [
    ...expSegments.map((e) => ({ id: e.sc.label, value: e.total, color: e.sc.color, subs: e.subs })),
    ...(savings > 0
      ? [{ id: "Sparen", value: savings, color: sparenSuper?.color ?? "#10b981", subs: sparenSubs }]
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
    id: string; value: number; color: string;
    subs: Array<{ label: string; value: number }>;
  }> = [
    ...expSegments.map((e) => ({ id: e.sc.label, value: e.total, color: e.sc.color, subs: e.subs })),
    ...(savings > 0
      ? [{ id: "Sparen", value: savings, color: sparenSuper?.color ?? "#10b981", subs: sparenSubs }]
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
      subItems:
        scaledSubs.length > 0
          ? subItemsForSankeyLink(scaledSubs, parentScaled, "wizard")
          : undefined,
    };
  });

  return { nodes, links };
}
