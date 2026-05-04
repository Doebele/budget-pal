/**
 * SeasonalityHeatmap
 *
 * Visualises monthly spending patterns for the top-N expense categories
 * over the last 12 months as a colour-coded grid.
 *
 * Data source: GET /transactions/monthly-category-breakdown?months=13
 * Shape: Array<{ month: "2025-01", category: string, amount: number }>
 *
 * Each row = one category, each column = one month.
 * Cell colour is normalised row-wise (relative to that category's own max).
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { transactionsApi } from "@/lib/api";
import { formatAmount } from "@/lib/theme";
import { clsx } from "clsx";
import { format, parseISO, subMonths, startOfMonth } from "date-fns";
import { de } from "date-fns/locale";
import { useTaxonomy } from "@/lib/categories";

interface MonthlyCategoryItem {
  month: string;   // "2025-01"
  category: string;
  amount: number;  // positive (expense absolute value)
}

const TOP_N = 10; // number of categories to show

export default function SeasonalityHeatmap() {
  const { resolveSuperCategory } = useTaxonomy();

  // Build last 13 months so we always have a complete trailing 12
  const today = new Date();
  const start = format(subMonths(startOfMonth(today), 12), "yyyy-MM-dd");
  const end   = format(today, "yyyy-MM-dd");

  const { data: rawData = [], isLoading } = useQuery<MonthlyCategoryItem[]>({
    queryKey: ["seasonality-heatmap", start, end],
    queryFn: () =>
      transactionsApi
        .monthlyCategoryBreakdown({ start, end })
        .then((r) => r.data as MonthlyCategoryItem[]),
    staleTime: 10 * 60_000,
  });

  // Build a sorted list of the last 12 calendar months (as "YYYY-MM" strings)
  const months = useMemo(() => {
    const ms: string[] = [];
    for (let i = 11; i >= 0; i--) {
      ms.push(format(subMonths(today, i), "yyyy-MM"));
    }
    return ms;
  }, []);

  // Aggregate: category → month → total amount
  const grid = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    for (const item of rawData) {
      if (!months.includes(item.month)) continue;
      if (!map.has(item.category)) map.set(item.category, new Map());
      const row = map.get(item.category)!;
      row.set(item.month, (row.get(item.month) ?? 0) + item.amount);
    }
    return map;
  }, [rawData, months]);

  // Rank categories by total spend, keep top N
  const topCategories = useMemo(() => {
    return [...grid.entries()]
      .map(([cat, monthMap]) => ({
        cat,
        total: [...monthMap.values()].reduce((s, v) => s + v, 0),
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, TOP_N)
      .map(({ cat }) => cat);
  }, [grid]);

  // For each category row, compute normalised intensity (0–1) per cell
  const getIntensity = (cat: string, month: string): number => {
    const row = grid.get(cat);
    if (!row) return 0;
    const val = row.get(month) ?? 0;
    const max = Math.max(...row.values());
    return max > 0 ? val / max : 0;
  };

  const getAmount = (cat: string, month: string): number =>
    grid.get(cat)?.get(month) ?? 0;

  if (isLoading) {
    return (
      <div className="card animate-pulse">
        <div className="skeleton h-4 w-48 rounded mb-4" />
        <div className="space-y-2">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="flex gap-1">
              <div className="skeleton h-7 w-28 rounded" />
              {[...Array(12)].map((_, j) => (
                <div key={j} className="skeleton h-7 flex-1 rounded" />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (topCategories.length === 0) {
    return (
      <div className="card text-center py-12 text-text-tertiary text-sm">
        Keine Transaktionsdaten für die Heatmap verfügbar.
      </div>
    );
  }

  // Short month labels: Jan, Feb, …
  const monthLabels = months.map((m) =>
    format(parseISO(`${m}-01`), "MMM", { locale: de })
  );

  return (
    <div className="card overflow-x-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-text-primary font-semibold text-sm">Saisonalitäts-Heatmap</h3>
          <p className="text-text-tertiary text-xs mt-0.5">
            Ausgaben pro Kategorie — letzte 12 Monate · Farbe = relativ zum Kategoriemax.
          </p>
        </div>
      </div>

      <div className="min-w-max">
        {/* Month header row */}
        <div className="flex items-center gap-1 mb-1.5 pl-32">
          {monthLabels.map((label, i) => (
            <div
              key={months[i]}
              className="w-11 text-center text-[10px] text-text-tertiary font-medium shrink-0"
            >
              {label}
            </div>
          ))}
        </div>

        {/* Category rows */}
        <div className="space-y-1">
          {topCategories.map((cat) => {
            const sc = resolveSuperCategory(cat);
            return (
              <div key={cat} className="flex items-center gap-1">
                {/* Category label */}
                <div className="w-32 flex items-center gap-1.5 shrink-0 pr-2">
                  <sc.icon
                    className="w-3 h-3 shrink-0"
                    style={{ color: sc.color }}
                  />
                  <span className="text-[11px] text-text-secondary truncate">{cat}</span>
                </div>

                {/* Month cells */}
                {months.map((month) => {
                  const intensity = getIntensity(cat, month);
                  const amount = getAmount(cat, month);
                  const isCurrentMonth = month === format(today, "yyyy-MM");

                  return (
                    <div
                      key={month}
                      title={
                        amount > 0
                          ? `${cat} · ${format(parseISO(`${month}-01`), "MMMM yyyy", { locale: de })}: ${formatAmount(amount, "CHF")}`
                          : "—"
                      }
                      className={clsx(
                        "w-11 h-7 rounded shrink-0 flex items-center justify-center text-[9px] font-mono transition-transform hover:scale-110 cursor-default",
                        isCurrentMonth && "ring-1 ring-accent/40",
                        intensity === 0 ? "bg-bg-surface2 text-transparent" : "text-white/70",
                      )}
                      style={
                        intensity > 0
                          ? {
                              backgroundColor: `${sc.color}${Math.round(intensity * 220 + 35)
                                .toString(16)
                                .padStart(2, "0")}`,
                            }
                          : undefined
                      }
                    >
                      {intensity > 0.3
                        ? amount >= 1000
                          ? `${(amount / 1000).toFixed(1)}k`
                          : Math.round(amount)
                        : ""}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Legend */}
        <div className="flex items-center gap-2 mt-4 pt-3 border-t border-border/40">
          <span className="text-[10px] text-text-tertiary">Niedrig</span>
          <div className="flex gap-0.5">
            {[0.1, 0.3, 0.5, 0.7, 0.9, 1.0].map((v) => (
              <div
                key={v}
                className="w-6 h-3 rounded-sm"
                style={{ backgroundColor: `#3b82f6${Math.round(v * 220 + 35).toString(16).padStart(2, "0")}` }}
              />
            ))}
          </div>
          <span className="text-[10px] text-text-tertiary">Hoch</span>
          <span className="text-[10px] text-text-tertiary ml-4">* relativ zum Monatsmax je Kategorie</span>
        </div>
      </div>
    </div>
  );
}
