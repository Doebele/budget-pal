import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowUpRight, ArrowDownRight, Wallet, TrendingUp, Upload, ArrowRight } from "lucide-react";
import { transactionsApi, accountsApi } from "@/lib/api";
import { formatCHF, colors } from "@/lib/theme";
import { format, startOfMonth, endOfMonth } from "date-fns";
import SankeyChart from "@/components/charts/SankeyChart";
import { clsx } from "clsx";

// ── Stat card ─────────────────────────────────────────────────

function StatCard({
  label,
  value,
  delta,
  icon: Icon,
  colorClass = "text-text-primary",
}: {
  label: string;
  value: string;
  delta?: number;
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
  const now = new Date();
  const monthStart = format(startOfMonth(now), "yyyy-MM-dd");
  const monthEnd = format(endOfMonth(now), "yyyy-MM-dd");

  const { data: stats } = useQuery({
    queryKey: ["transaction-stats", monthStart, monthEnd],
    queryFn: () => transactionsApi.stats({ start: monthStart, end: monthEnd }).then((r) => r.data),
  });

  const { data: accounts } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => accountsApi.list().then((r) => r.data),
  });

  const { data: recentTxns } = useQuery({
    queryKey: ["recent-transactions"],
    queryFn: () => transactionsApi.list({ limit: 8 }).then((r) => r.data),
  });

  const { data: monthlySummary } = useQuery({
    queryKey: ["monthly-summary", now.getFullYear()],
    queryFn: () => transactionsApi.monthlySummary({ year: now.getFullYear() }).then((r) => r.data),
  });

  const totalBalance = (accounts || []).reduce((sum: number, a: { balance: number }) => sum + a.balance, 0);

  // Build Sankey data from monthly stats
  const sankeyData = buildSankeyData(stats, monthlySummary?.[monthlySummary?.length - 1]);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-display text-text-primary">Dashboard</h1>
          <p className="text-text-tertiary text-sm mt-0.5">{format(now, "MMMM yyyy")}</p>
        </div>
        <div className="flex gap-2">
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

      {/* Stat cards */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard
          label="Gesamtvermögen"
          value={formatCHF(totalBalance, true)}
          icon={Wallet}
          colorClass="text-text-primary"
        />
        <StatCard
          label="Einnahmen (Monat)"
          value={formatCHF(stats?.total_income || 0)}
          icon={ArrowUpRight}
          colorClass="text-gain"
        />
        <StatCard
          label="Ausgaben (Monat)"
          value={formatCHF(stats?.total_expenses || 0)}
          icon={ArrowDownRight}
          colorClass="text-loss"
        />
        <StatCard
          label="Netto (Monat)"
          value={formatCHF((stats?.total_income || 0) - (stats?.total_expenses || 0))}
          icon={TrendingUp}
          colorClass={(stats?.net || 0) >= 0 ? "text-gain" : "text-loss"}
        />
      </div>

      {/* Sankey + Recent transactions */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* Sankey cash flow */}
        <div className="xl:col-span-2 card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-text-primary font-semibold text-sm">Cashflow — {format(now, "MMMM")}</h2>
          </div>
          {sankeyData.nodes.length > 2 ? (
            <SankeyChart data={sankeyData} height={280} />
          ) : (
            <div className="h-64 flex items-center justify-center text-text-tertiary text-sm">
              Noch keine Transaktionen in diesem Monat
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
          <h2 className="text-text-primary font-semibold text-sm mb-4">Top Ausgaben-Kategorien</h2>
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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { to: "/transactions", label: "Transaktionen", desc: "Alle ansehen & filtern", icon: "📊" },
          { to: "/budget", label: "Budget", desc: "Ziele verwalten", icon: "🎯" },
          { to: "/projections", label: "Prognosen", desc: "Monte Carlo & Rente", icon: "📈" },
          { to: "/import", label: "Import", desc: "CSV / PDF hochladen", icon: "📂" },
        ].map(({ to, label, desc, icon }) => (
          <Link
            key={to}
            to={to}
            className="card hover:border-accent/30 transition-colors cursor-pointer group"
          >
            <span className="text-2xl mb-2 block">{icon}</span>
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
} | undefined, _month: unknown) {
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
