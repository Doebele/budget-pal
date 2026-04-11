/**
 * BudgetStackedBarChart — ECharts stacked bar visualisation
 *
 * Two modes (toggle):
 *
 *   "historical" — actual monthly transactions, X-axis = historicalAxisMonths
 *                  (same as ForecastComparisonChart historical side)
 *
 *   "forecast"   — future projection, X-axis = forecastAxisMonths
 *                  (same as ForecastComparisonChart forecast side)
 *                  Data source cascade (first available wins):
 *                    1. Wizard empirical data  — flat monthly amounts, no AI drift
 *                    2. Historical recurring    — seasonal month-of-year averages
 *                       from the last 12 months of actual transactions
 *                    3. AI forecast (capped)   — AI prediction engine output with
 *                       Steuern + all categories capped to ≤110 % historical avg
 *
 * Tooltip shows per-supercategory total AND sub-category breakdown (historical mode).
 */
import { useMemo, useState } from "react";
import ReactECharts from "echarts-for-react";
import type { SuperCategory } from "@/lib/categories";
import { resolveSuperCategoryFromList, useTaxonomySuperCategories } from "@/lib/categories";
import { formatCHF } from "@/lib/theme";

// ── Types ────────────────────────────────────────────────────────

export interface HistoricalCategoryItem {
  month: string;       // "2025-01"
  category: string;
  amount: number;      // positive (absolute expense)
}

export interface ForecastMonthBreakdown {
  month: string;
  category_breakdown: Record<string, { predicted: number }>;
  predicted_expense: number;
}

export interface WizardSnapshot {
  housingMode?: string;
  monthlyRent?: number;
  nebenkosten?: number;
  monthlyAmortization?: number;
  healthInsurancePerPerson?: number;
  zusatzversicherung?: number;
  hausrat?: number;
  autoversicherung?: number;
  hasAutoInsurance?: boolean;
  groceries?: number;
  monthlyFuel?: number;
  parking?: number;
  carAmortization?: number;
  hasSbbHalbtax?: boolean;
  hasSbbGa?: boolean;
  subscriptionTotal?: number;
  serafe?: number;
  freizeit?: number;
  unterhaltung?: number;
  kleidung?: number;
  direkteSteuern?: number;
  weiterbildung?: number;
}

interface Props {
  historicalData: HistoricalCategoryItem[];
  forecastData: ForecastMonthBreakdown[];
  historicalAxisMonths?: string[];
  forecastAxisMonths?: string[];
  wizardData?: WizardSnapshot | null;
  height?: number;
}

type SubCatDetail = Record<string, Record<string, Record<string, number>>>;

// ── Supercategory order — warm/cool alternation for max contrast ──
const CHART_SC_ORDER = [
  "wohnen", "bildung", "steuern", "abos",
  "freizeit", "versicherungen", "essen", "shopping", "mobilitaet",
];

// ── Month helpers ─────────────────────────────────────────────────

const MONTH_NAMES_SHORT = ["Jan","Feb","Mär","Apr","Mai","Jun","Jul","Aug","Sep","Okt","Nov","Dez"];

function fmtMonth(m: string): string {
  const [y, mo] = m.split("-");
  return `${MONTH_NAMES_SHORT[parseInt(mo, 10) - 1]} ${y.slice(2)}`;
}

/** Returns "YYYY-MM" for the month that is `n` months before today */
function cutoffMonth(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 7);
}

// ── 1. Aggregate real transactions ───────────────────────────────

function aggregateHistoricalFull(
  items: HistoricalCategoryItem[],
  resolveTxn: (cat: string) => SuperCategory,
): {
  byMonth: Record<string, Record<string, number>>;
  subsByMonth: SubCatDetail;
} {
  const byMonth: Record<string, Record<string, number>> = {};
  const subsByMonth: SubCatDetail = {};

  for (const item of items) {
    if (!item.category) continue;
    const sc = resolveTxn(item.category);
    if (sc.id === "sparen" || sc.id === "sonstiges") continue;

    if (!byMonth[item.month]) byMonth[item.month] = {};
    byMonth[item.month][sc.id] = (byMonth[item.month][sc.id] ?? 0) + item.amount;

    if (!subsByMonth[item.month]) subsByMonth[item.month] = {};
    if (!subsByMonth[item.month][sc.id]) subsByMonth[item.month][sc.id] = {};
    subsByMonth[item.month][sc.id][item.category] =
      (subsByMonth[item.month][sc.id][item.category] ?? 0) + item.amount;
  }

  return { byMonth, subsByMonth };
}

// ── 2. Recurring-pattern projection from historical transactions ──

/**
 * Analyses the last `lookbackMonths` of actual transactions per supercategory.
 *
 * Returns:
 *   monthlyAvg  — overall average per supercategory per month
 *   seasonal    — month-of-year (1–12) average; only set when ≥2 observations
 *                 exist for that calendar month (otherwise fallback to monthlyAvg)
 *
 * Seasonality example: insurance invoice paid in January shows up as a spike
 * in seasonal[scId][1], keeping the projection realistic for future Januaries.
 */
function computeRecurringPatterns(
  items: HistoricalCategoryItem[],
  lookbackMonths: number,
  resolveTxn: (cat: string) => SuperCategory,
): {
  monthlyAvg: Record<string, number>;
  seasonal: Record<string, Record<number, number>>;
} {
  const cutoff = cutoffMonth(lookbackMonths);

  // Aggregate by (month, scId)
  const byMonthSc: Record<string, Record<string, number>> = {};
  for (const item of items) {
    if (!item.category || item.month < cutoff) continue;
    const sc = resolveTxn(item.category);
    if (sc.id === "sparen" || sc.id === "sonstiges") continue;
    if (!byMonthSc[item.month]) byMonthSc[item.month] = {};
    byMonthSc[item.month][sc.id] = (byMonthSc[item.month][sc.id] ?? 0) + item.amount;
  }

  const distinctMonths = Object.keys(byMonthSc).length || 1;

  // Accumulate totals + month-of-year buckets
  const scTotal: Record<string, number> = {};
  const scMoY: Record<string, Record<number, number[]>> = {};

  for (const [month, scMap] of Object.entries(byMonthSc)) {
    const moy = parseInt(month.split("-")[1], 10); // 1–12
    for (const [scId, amount] of Object.entries(scMap)) {
      scTotal[scId] = (scTotal[scId] ?? 0) + amount;
      if (!scMoY[scId]) scMoY[scId] = {};
      if (!scMoY[scId][moy]) scMoY[scId][moy] = [];
      scMoY[scId][moy].push(amount);
    }
  }

  const monthlyAvg: Record<string, number> = {};
  const seasonal: Record<string, Record<number, number>> = {};

  for (const scId of Object.keys(scTotal)) {
    monthlyAvg[scId] = scTotal[scId] / distinctMonths;
    seasonal[scId] = {};
    for (const [moyStr, amounts] of Object.entries(scMoY[scId])) {
      // Only apply seasonal adjustment when we have ≥2 data points
      // (single observation is too noisy — fall back to monthlyAvg)
      if (amounts.length >= 2) {
        seasonal[scId][parseInt(moyStr, 10)] =
          amounts.reduce((s, a) => s + a, 0) / amounts.length;
      }
    }
  }

  return { monthlyAvg, seasonal };
}

/**
 * Projects recurring patterns over forecastMonths.
 * Each future month gets the seasonal estimate (month-of-year average) if
 * available, otherwise the overall monthly average.
 */
function projectRecurring(
  forecastMonths: string[],
  patterns: ReturnType<typeof computeRecurringPatterns>,
): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  for (const m of forecastMonths) {
    const moy = parseInt(m.split("-")[1], 10);
    result[m] = {};
    for (const scId of CHART_SC_ORDER) {
      result[m][scId] =
        patterns.seasonal[scId]?.[moy] ??
        patterns.monthlyAvg[scId] ??
        0;
    }
  }
  return result;
}

// ── 3. AI forecast aggregation (with cap) ────────────────────────

function aggregateForecastFull(
  months: ForecastMonthBreakdown[],
  resolveTxn: (cat: string) => SuperCategory,
): {
  byMonth: Record<string, Record<string, number>>;
  subsByMonth: SubCatDetail;
} {
  const byMonth: Record<string, Record<string, number>> = {};
  const subsByMonth: SubCatDetail = {};

  for (const f of months) {
    for (const [cat, v] of Object.entries(f.category_breakdown)) {
      if (v.predicted >= 0) continue; // skip income / savings
      const sc = resolveTxn(cat);
      if (sc.id === "sparen" || sc.id === "sonstiges") continue;
      const abs = Math.abs(v.predicted);

      if (!byMonth[f.month]) byMonth[f.month] = {};
      byMonth[f.month][sc.id] = (byMonth[f.month][sc.id] ?? 0) + abs;

      if (!subsByMonth[f.month]) subsByMonth[f.month] = {};
      if (!subsByMonth[f.month][sc.id]) subsByMonth[f.month][sc.id] = {};
      subsByMonth[f.month][sc.id][cat] =
        (subsByMonth[f.month][sc.id][cat] ?? 0) + abs;
    }
  }

  return { byMonth, subsByMonth };
}

/**
 * Caps every supercategory in the AI forecast to ≤110 % of the historical
 * monthly average, preventing the unbounded trend-slope drift that causes
 * Steuern & other fixed costs to grow unrealistically.
 */
function capToHistoricalAvg(
  forecastByMonth: Record<string, Record<string, number>>,
  histMonthlyAvg: Record<string, number>,
): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  for (const [m, scMap] of Object.entries(forecastByMonth)) {
    result[m] = {};
    for (const [scId, amount] of Object.entries(scMap)) {
      const histAvg = histMonthlyAvg[scId];
      // Only cap when we have a meaningful historical baseline (> 0)
      result[m][scId] = histAvg && histAvg > 0
        ? Math.min(amount, histAvg * 1.10)
        : amount;
    }
  }
  return result;
}

// ── 4. Wizard → flat monthly amounts ─────────────────────────────

function wizardToMonthly(w: WizardSnapshot): Record<string, number> {
  const housing =
    w.housingMode === "hypothek"
      ? (w.monthlyAmortization ?? 0)
      : (w.monthlyRent ?? 0) + (w.nebenkosten ?? 0);

  const insurance =
    (w.healthInsurancePerPerson ?? 0) +
    (w.zusatzversicherung ?? 0) +
    (w.hausrat ?? 0) +
    (w.hasAutoInsurance ? (w.autoversicherung ?? 0) : 0);

  const mobility =
    (w.monthlyFuel ?? 0) +
    (w.parking ?? 0) +
    (w.carAmortization ?? 0) +
    (w.hasSbbHalbtax ? 19.0 : 0) +
    (w.hasSbbGa ? 345.0 : 0);

  return {
    wohnen:         housing,
    versicherungen: insurance,
    essen:          w.groceries ?? 0,
    mobilitaet:     mobility,
    abos:           (w.subscriptionTotal ?? 0) + (w.serafe ?? 27.92),
    freizeit:       (w.freizeit ?? 0) + (w.unterhaltung ?? 0),
    shopping:       w.kleidung ?? 0,
    steuern:        w.direkteSteuern ?? 0,  // fixed — no AI drift
    bildung:        w.weiterbildung ?? 0,
  };
}

function buildWizardForecast(
  months: string[],
  w: WizardSnapshot,
): Record<string, Record<string, number>> {
  const monthly = wizardToMonthly(w);
  const result: Record<string, Record<string, number>> = {};
  for (const m of months) result[m] = { ...monthly };
  return result;
}

// ── ECharts option builder ────────────────────────────────────────

/**
 * @param firstForecastIdx  index of the first "future" month in `months`.
 *   -1 = all months are actual data (no separator).
 *   ≥0 = draw a dashed separator before that index and render those bars at
 *        reduced opacity so the user can distinguish past from projected.
 */
function buildOption(
  months: string[],
  byMonth: Record<string, Record<string, number>>,
  subsByMonth: SubCatDetail,
  chartSc: SuperCategory[],
  firstForecastIdx = -1,
) {
  const axisColor = "#64748b";
  const gridColor = "#1e293b";
  const labelColor = "#94a3b8";

  const series = chartSc.map((sc, si) => {
    const s: Record<string, unknown> = {
      name: sc.label,
      type: "bar",
      stack: "ausgaben",
      data: months.map((m, mi) => ({
        value: +(byMonth[m]?.[sc.id] ?? 0).toFixed(2),
        itemStyle: {
          color: sc.color,
          // Future bars rendered at lower opacity to distinguish from actual data
          opacity: firstForecastIdx >= 0 && mi >= firstForecastIdx ? 0.55 : 1,
          borderRadius: 0,
        },
      })),
      emphasis: { focus: "series" },
    };

    // Add boundary markLine on the bottom-most series only
    if (si === 0 && firstForecastIdx > 0) {
      s.markLine = {
        silent: true,
        symbol: ["none", "none"],
        lineStyle: { color: "#475569", type: "dashed", width: 1.5 },
        label: {
          show: true,
          position: "insideStartTop",
          color: "#64748b",
          fontSize: 10,
          formatter: "Prognose →",
        },
        // Fractional index places the line between the last actual and first projected bar
        data: [{ xAxis: firstForecastIdx - 0.5 }],
      };
    }

    return s;
  });

  return {
    backgroundColor: "transparent",
    animation: true,
    animationDuration: 400,
    tooltip: {
      trigger: "axis" as const,
      axisPointer: { type: "shadow" as const },
      backgroundColor: "#1e293b",
      borderColor: "#334155",
      borderWidth: 1,
      textStyle: { color: "#e2e8f0", fontSize: 12 },
      formatter: (params: Array<{
        seriesName: string; value: number; color: string;
        name: string; dataIndex: number;
      }>) => {
        if (!params?.length) return "";
        const idx = params[0].dataIndex;
        const monthKey = months[idx] ?? "";
        const monthSubs = subsByMonth[monthKey] ?? {};
        const total = params.reduce((s, p) => s + (p.value ?? 0), 0);
        const isFuture = firstForecastIdx >= 0 && idx >= firstForecastIdx;

        let html = `<div style="font-weight:600;margin-bottom:4px;font-size:13px;color:#f1f5f9">${params[0]?.name ?? ""}</div>`;
        if (isFuture) {
          html += `<div style="margin-bottom:6px"><span style="background:#7c3aed22;border:1px solid #7c3aed55;color:#a78bfa;font-size:10px;padding:1px 6px;border-radius:9999px">Prognose (Periodizität)</span></div>`;
        }

        for (const p of params.filter((p) => p.value > 0)) {
          const pct = total > 0 ? ((p.value / total) * 100).toFixed(1) : "0.0";
          html += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">
            <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${p.color};flex-shrink:0"></span>
            <span style="color:#e2e8f0;flex:1;font-weight:500">${p.seriesName}</span>
            <span style="font-family:monospace;color:#f1f5f9">${formatCHF(p.value)}</span>
            <span style="color:#64748b;font-size:11px;min-width:38px;text-align:right">${pct}%</span>
          </div>`;

          const scId = chartSc.find((sc) => sc.label === p.seriesName)?.id ?? "";
          const subEntries = Object.entries(monthSubs[scId] ?? {})
            .sort((a, b) => b[1] - a[1])
            .filter(([, amt]) => amt > 0);

          if (subEntries.length > 1) {
            for (const [subCat, amt] of subEntries) {
              const subPct = p.value > 0 ? ((amt / p.value) * 100).toFixed(0) : "0";
              html += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:1px;padding-left:16px;">
                <span style="color:#475569;flex:1;font-size:11px">${subCat}</span>
                <span style="font-family:monospace;color:#94a3b8;font-size:11px">${formatCHF(amt)}</span>
                <span style="color:#475569;font-size:10px;min-width:38px;text-align:right">${subPct}%</span>
              </div>`;
            }
          }
        }

        html += `<div style="border-top:1px solid #334155;margin-top:6px;padding-top:6px;display:flex;justify-content:space-between;">
          <span style="color:#94a3b8">Total</span>
          <span style="font-family:monospace;font-weight:600;color:#f1f5f9">${formatCHF(total)}</span>
        </div>`;
        return html;
      },
    },
    legend: {
      bottom: 0,
      textStyle: { color: labelColor, fontSize: 11 },
      data: [...chartSc].reverse().map((sc) => sc.label),
    },
    grid: { top: 12, left: 16, right: 16, bottom: 72, containLabel: true },
    xAxis: {
      type: "category" as const,
      data: months.map(fmtMonth),
      axisLine: { lineStyle: { color: axisColor } },
      axisTick: { show: false },
      axisLabel: { color: labelColor, fontSize: 11, interval: "auto" },
    },
    yAxis: {
      type: "value" as const,
      axisLabel: {
        color: labelColor,
        fontSize: 11,
        formatter: (v: number) =>
          v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v),
      },
      splitLine: { lineStyle: { color: gridColor } },
      axisLine: { show: false },
    },
    series,
  };
}

// ── Main component ────────────────────────────────────────────────

export default function BudgetStackedBarChart({
  historicalData,
  forecastData,
  historicalAxisMonths,
  forecastAxisMonths,
  wizardData,
  height = 320,
}: Props) {
  const [mode, setMode] = useState<"historical" | "forecast">("historical");
  const superCategories = useTaxonomySuperCategories();
  const chartSc = useMemo(
    () =>
      CHART_SC_ORDER.map((id) => superCategories.find((sc) => sc.id === id)).filter(
        (sc): sc is SuperCategory => sc !== undefined,
      ),
    [superCategories],
  );
  const resolveTxn = useMemo(
    () => (cat: string) => resolveSuperCategoryFromList(superCategories, cat, false),
    [superCategories],
  );

  // ── Historical: real transactions ──────────────────────────────
  const { byMonth: historicalByMonth, subsByMonth: historicalSubs } = useMemo(
    () => aggregateHistoricalFull(historicalData, resolveTxn),
    [historicalData, resolveTxn],
  );

  const historicalMonths = useMemo(() => {
    if (historicalAxisMonths?.length) return [...historicalAxisMonths].sort();
    return Object.keys(historicalByMonth).sort();
  }, [historicalAxisMonths, historicalByMonth]);

  // ── Recurring patterns from last 12 months ────────────────────
  const recurringPatterns = useMemo(
    () => computeRecurringPatterns(historicalData, 12, resolveTxn),
    [historicalData, resolveTxn],
  );

  // ── Forecast months axis ──────────────────────────────────────
  const forecastMonths = useMemo(() => {
    if (forecastAxisMonths?.length) return [...forecastAxisMonths].sort();
    return forecastData.map((f) => f.month).sort();
  }, [forecastAxisMonths, forecastData]);

  // ── Recurring projection over forecast months ─────────────────
  const recurringByMonth = useMemo(
    () => projectRecurring(forecastMonths, recurringPatterns),
    [forecastMonths, recurringPatterns],
  );

  // ── AI forecast (capped) — last resort fallback ───────────────
  const { byMonth: aiForecastByMonthRaw, subsByMonth: aiForecastSubs } = useMemo(
    () => aggregateForecastFull(forecastData, resolveTxn),
    [forecastData, resolveTxn],
  );

  const aiForecastByMonth = useMemo(
    () => capToHistoricalAvg(aiForecastByMonthRaw, recurringPatterns.monthlyAvg),
    [aiForecastByMonthRaw, recurringPatterns.monthlyAvg],
  );

  // ── HISTORICAL mode: past actual + future recurring projection ─
  // Combines historicalMonths (real data) with forecastMonths (recurring),
  // keeping the Zeithorizont consistent with ForecastComparisonChart.
  const historicalCombinedMonths = useMemo(() => {
    const futureOnly = forecastMonths.filter((m) => !historicalMonths.includes(m));
    return [...historicalMonths, ...futureOnly]; // already sorted (hist < fore)
  }, [historicalMonths, forecastMonths]);

  const historicalCombinedByMonth = useMemo(() => {
    const result: Record<string, Record<string, number>> = {};
    for (const m of historicalCombinedMonths) {
      // Past month → actual data; future month → recurring projection
      result[m] = historicalByMonth[m] ?? recurringByMonth[m] ?? {};
    }
    return result;
  }, [historicalCombinedMonths, historicalByMonth, recurringByMonth]);

  // Sub-categories only for actual past months
  const historicalCombinedSubs = useMemo(() => {
    const result: SubCatDetail = {};
    for (const m of historicalCombinedMonths) {
      result[m] = historicalSubs[m] ?? {};
    }
    return result;
  }, [historicalCombinedMonths, historicalSubs]);

  // Index of first future month in the combined historical list (for separator)
  const histFirstForecastIdx = useMemo(() => {
    const firstFuture = forecastMonths.find((m) => !historicalMonths.includes(m));
    if (!firstFuture) return -1;
    return historicalCombinedMonths.indexOf(firstFuture);
  }, [forecastMonths, historicalMonths, historicalCombinedMonths]);

  // ── FORECAST mode: wizard > recurring > capped AI ─────────────
  const forecastByMonth = useMemo(() => {
    if (wizardData) return buildWizardForecast(forecastMonths, wizardData);
    if (Object.keys(recurringPatterns.monthlyAvg).length > 0) return recurringByMonth;
    return aiForecastByMonth;
  }, [wizardData, forecastMonths, recurringPatterns, recurringByMonth, aiForecastByMonth]);

  const forecastSubs = useMemo(() => {
    if (!wizardData && Object.keys(recurringPatterns.monthlyAvg).length === 0)
      return aiForecastSubs;
    return {} as SubCatDetail;
  }, [wizardData, recurringPatterns, aiForecastSubs]);

  // ── Active data for current mode ──────────────────────────────
  const activeMonths       = mode === "historical" ? historicalCombinedMonths : forecastMonths;
  const activeByMonth      = mode === "historical" ? historicalCombinedByMonth : forecastByMonth;
  const activeSubs         = mode === "historical" ? historicalCombinedSubs : forecastSubs;
  const activeFirstForecastIdx = mode === "historical" ? histFirstForecastIdx : -1;

  const option = useMemo(
    () =>
      buildOption(activeMonths, activeByMonth, activeSubs, chartSc, activeFirstForecastIdx),
    [activeMonths, activeByMonth, activeSubs, chartSc, activeFirstForecastIdx],
  );

  // Status label under the chart title
  const sourceLabel = useMemo(() => {
    if (mode === "historical") {
      return histFirstForecastIdx >= 0
        ? "Ist-Daten + Prognose aus wiederkehrenden Zahlungen (Ø 12 Mt.)"
        : "Ist-Daten aus realen Transaktionen";
    }
    if (wizardData) return "Empirische Angaben · Steuern fix";
    if (Object.keys(recurringPatterns.monthlyAvg).length > 0)
      return "Wiederkehrende Zahlungen · Ø letzte 12 Monate";
    return "KI-Prognose · Steuern auf histor. Ø begrenzt";
  }, [mode, histFirstForecastIdx, wizardData, recurringPatterns]);

  const hasData = activeMonths.length > 0;

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-text-primary font-semibold text-sm">
            Ausgaben nach Kategorie
          </h2>
          <p className="text-text-tertiary text-[11px] mt-0.5">{sourceLabel}</p>
        </div>
        <div className="flex items-center gap-1 p-0.5 rounded-lg bg-bg-surface2 border border-border">
          <button
            type="button"
            onClick={() => setMode("historical")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              mode === "historical"
                ? "bg-accent text-white shadow-sm"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            Historisch (Ist)
          </button>
          <button
            type="button"
            onClick={() => setMode("forecast")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              mode === "forecast"
                ? "bg-accent text-white shadow-sm"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            Prognose (Empirisch)
          </button>
        </div>
      </div>

      {!hasData ? (
        <div
          className="flex items-center justify-center text-text-tertiary text-sm"
          style={{ height }}
        >
          {mode === "historical"
            ? "Keine historischen Transaktionsdaten verfügbar."
            : "Keine Prognosedaten — wähle einen Zeithorizont."}
        </div>
      ) : (
        <ReactECharts
          option={option}
          style={{ height }}
          opts={{ renderer: "svg" }}
          notMerge
        />
      )}
    </div>
  );
}
