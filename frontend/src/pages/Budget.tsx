import { useQuery } from "@tanstack/react-query";
import { budgetsApi, transactionsApi } from "@/lib/api";
import { formatCHF } from "@/lib/theme";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { clsx } from "clsx";

export default function Budget() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const monthStart = format(startOfMonth(now), "yyyy-MM-dd");
  const monthEnd = format(endOfMonth(now), "yyyy-MM-dd");

  const { data: budgets } = useQuery({
    queryKey: ["budgets", year],
    queryFn: () => budgetsApi.list({ year }).then((r) => r.data),
  });

  const { data: stats } = useQuery({
    queryKey: ["transaction-stats-budget", monthStart, monthEnd],
    queryFn: () => transactionsApi.stats({ start: monthStart, end: monthEnd }).then((r) => r.data),
  });

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-display text-text-primary">Budget</h1>
        <p className="text-text-tertiary text-sm mt-0.5">{format(now, "MMMM yyyy")}</p>
      </div>

      {/* Overview */}
      <div className="grid grid-cols-2 gap-4">
        <div className="card">
          <p className="text-text-tertiary text-xs uppercase tracking-wide mb-2">Einnahmen</p>
          <p className="text-gain font-mono text-xl font-semibold">{formatCHF(stats?.total_income || 0)}</p>
        </div>
        <div className="card">
          <p className="text-text-tertiary text-xs uppercase tracking-wide mb-2">Ausgaben</p>
          <p className="text-loss font-mono text-xl font-semibold">{formatCHF(stats?.total_expenses || 0)}</p>
        </div>
      </div>

      {/* Category budgets */}
      <div className="card">
        <h2 className="text-text-primary font-semibold text-sm mb-4">Budgets nach Kategorie</h2>
        <div className="space-y-4">
          {(stats?.top_categories || []).map((cat: { category: string; total: number }) => {
            const budget = (budgets || []).find(
              (b: { category_id: number }) => b.category_id === null
            );
            const spent = cat.total;
            const limit = budget?.amount || 500;
            const pct = Math.min(100, (spent / limit) * 100);
            const over = spent > limit;

            return (
              <div key={cat.category}>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-text-secondary text-sm">{cat.category || "Sonstige"}</span>
                  <div className="text-right">
                    <span className={clsx("text-sm font-mono", over ? "text-loss" : "text-text-primary")}>
                      {formatCHF(spent)}
                    </span>
                    <span className="text-text-tertiary text-xs"> / {formatCHF(limit)}</span>
                  </div>
                </div>
                <div className="h-2 bg-bg-surface2 rounded-full overflow-hidden">
                  <div
                    className={clsx(
                      "h-full rounded-full transition-all duration-500",
                      over ? "bg-loss" : pct > 80 ? "bg-warning" : "bg-accent"
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className="text-text-tertiary text-xs mt-0.5 text-right">
                  {over ? `${formatCHF(spent - limit)} über Budget` : `${formatCHF(limit - spent)} verbleibend`}
                </p>
              </div>
            );
          })}
          {(!stats?.top_categories || stats.top_categories.length === 0) && (
            <p className="text-text-tertiary text-sm text-center py-8">Keine Ausgaben in diesem Monat</p>
          )}
        </div>
      </div>
    </div>
  );
}
