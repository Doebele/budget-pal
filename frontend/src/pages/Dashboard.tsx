import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowUpRight, ArrowDownRight, Wallet, TrendingUp, Upload, ArrowRight, BarChart3, Target, FileUp, Wand2 } from "lucide-react";
import { transactionsApi, accountsApi } from "@/lib/api";
import { formatCHF } from "@/lib/theme";
import { format } from "date-fns";
import SankeyChart from "@/components/charts/SankeyChart";
import GranularityNavigator from "@/components/GranularityNavigator";
import { computeDateRange, TimeGranularity } from "@/lib/granularity";
import { clsx } from "clsx";

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
  const [granularity, setGranularity] = useState<TimeGranularity>("ytd");
  const [anchor, setAnchor] = useState<Date>(() => new Date());

  const range = useMemo(() => computeDateRange(granularity, anchor), [granularity, anchor]);
  const periodStart = format(range.from, "yyyy-MM-dd");
  const periodEnd = format(range.to, "yyyy-MM-dd");

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

  const totalBalance = (accounts || []).reduce((sum: number, a: { balance: number }) => sum + a.balance, 0);

  const sankeyData = buildSankeyData(stats);

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
          <div className="mb-4">
            <h2 className="text-text-primary font-semibold text-sm">Cashflow</h2>
            <p className="text-text-tertiary text-xs mt-0.5">{range.label}</p>
          </div>
          {sankeyData.nodes.length > 2 ? (
            <SankeyChart data={sankeyData} height={280} />
          ) : (
            <div className="h-64 flex items-center justify-center text-text-tertiary text-sm text-center px-4">
              Noch keine Transaktionen im gewählten Zeitraum ({range.label})
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
            }) => (
              <div key={txn.id} className="flex items-center justify-between py-1.5">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-7 h-7 rounded-full bg-bg-surface2 flex items-center justify-center flex-shrink-0 text-xs">
                    {getCategoryEmoji(txn.category || "")}
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
            ))}
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
              const pct = stats.total_expenses > 0 ? (cat.total / stats.total_expenses) * 100 : 0;
              return (
                <div key={cat.category}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-text-secondary text-xs">{cat.category || "Sonstige"}</span>
                    <span className="text-text-primary text-xs font-mono">{formatCHF(cat.total)}</span>
                  </div>
                  <div className="h-1.5 bg-bg-surface2 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-loss/70 rounded-full transition-all duration-500"
                      style={{ width: `${Math.min(100, pct)}%` }}
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
          { to: "/transactions", label: "Reale Angaben", desc: "Alle ansehen & filtern", Icon: BarChart3 },
          { to: "/wizard", label: "Empirische Angaben", desc: "Profil & Planungsdaten", Icon: Wand2 },
          { to: "/budget", label: "Budgetanalyse", desc: "Ziele verwalten", Icon: Target },
          { to: "/projections", label: "Prognosen", desc: "Monte Carlo & Rente", Icon: TrendingUp },
          { to: "/import", label: "Import", desc: "CSV / PDF hochladen", Icon: FileUp },
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

// ── Helpers ───────────────────────────────────────────────────

function getCategoryEmoji(category: string): string {
  const map: Record<string, string> = {
    Groceries: "🛒", "Food & Drink": "🍔", Transport: "🚆",
    Travel: "✈️", Health: "💊", Utilities: "⚡", Housing: "🏠",
    Shopping: "🛍️", Entertainment: "🎬", Finance: "🏦",
    Salary: "💰", Insurance: "🛡️", Education: "📚",
  };
  return map[category] || "💸";
}

function buildSankeyData(stats: {
  total_income?: number;
  total_expenses?: number;
  top_categories?: Array<{ category: string; total: number }>;
} | undefined) {
  if (!stats || !stats.total_income) {
    return { nodes: [], links: [] };
  }

  const nodes = [
    { id: "Einnahmen" },
    { id: "Verfügbar" },
    { id: "Sparen" },
    ...(stats.top_categories || []).slice(0, 6).map((c) => ({ id: c.category || "Sonstige" })),
  ];

  const links = [
    { source: "Einnahmen", target: "Verfügbar", value: stats.total_income },
  ];

  const totalExpenses = stats.total_expenses || 0;
  const savings = Math.max(0, stats.total_income - totalExpenses);

  if (savings > 0) {
    links.push({ source: "Verfügbar", target: "Sparen", value: savings });
  }

  (stats.top_categories || []).slice(0, 6).forEach((c) => {
    if (c.total > 0) {
      links.push({ source: "Verfügbar", target: c.category || "Sonstige", value: c.total });
    }
  });

  return { nodes, links };
}
