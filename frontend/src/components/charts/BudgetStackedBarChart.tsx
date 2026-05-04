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
import { useMemo, useState, useRef, useEffect, useCallback } from "react";
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
  /** Pre-computed Budgetplan supercategory breakdown: month → scId → expense CHF */
  budgetPlanByMonth?: Record<string, Record<string, number>>;
  /** Ordered list of months for the budgetplan mode axis */
  budgetPlanMonths?: string[];
  height?: number;
  /** When true: skip the outer card div + title row (embed inside a parent card) */
  embedded?: boolean;
  /** Supercategory IDs to hide from the chart (mirrors Budget page filter chips) */
  hiddenScIds?: Set<string>;
  /** "amount" → sort stack layers by first-month total descending; "default" → taxonomy order */
  sortOrder?: "default" | "amount";
}

type SubCatDetail = Record<string, Record<string, Record<string, number>>>;

// ── Supercategory order (bottom → top of stacked bar) ────────────
// Matches the taxonomy order used in filter chips; excludes "sparen" (income).
export const CHART_SC_ORDER = [
  "wohnen", "essen", "mobilitaet", "versicherungen",
  "freizeit", "abos", "shopping", "bildung", "steuern", "sonstiges",
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
    if (sc.id === "sparen") continue; // income — never shown as expense

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

// ── Color shade generator ─────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * Generate `count` shades of `baseColor` from full saturation (i=0) to
 * ~60 % lighter (i=count-1), so the most-dominant sub-cat gets the richest tone.
 */
function generateShades(baseColor: string, count: number): string[] {
  if (!baseColor.startsWith("#") || count <= 0) return Array(count).fill(baseColor);
  if (count === 1) return [baseColor];
  const [r, g, b] = hexToRgb(baseColor);
  return Array.from({ length: count }, (_, i) => {
    const t = (i / (count - 1)) * 0.62; // 0 → base, (count-1) → 62 % towards white
    const nr = Math.round(r + (255 - r) * t);
    const ng = Math.round(g + (255 - g) * t);
    const nb = Math.round(b + (255 - b) * t);
    return `#${nr.toString(16).padStart(2, "0")}${ng.toString(16).padStart(2, "0")}${nb.toString(16).padStart(2, "0")}`;
  });
}

// ── Layer computation (shared by buildOption + injectRibbons) ────────

export interface ChartLayers {
  keys: string[];
  labels: string[];
  colors: string[];
  data: Record<string, Record<string, number>>;
  singleScMode: boolean;
  subCatColors: string[];
  orderedSc: SuperCategory[];
}

export function computeLayers(
  months: string[],
  byMonth: Record<string, Record<string, number>>,
  subsByMonth: SubCatDetail,
  chartScIn: SuperCategory[],
  sortOrder: "default" | "amount" = "default",
): ChartLayers {
  let chartSc = chartScIn;
  if (sortOrder === "amount" && months.length > 0) {
    const firstMonth = months[0];
    chartSc = [...chartScIn].sort(
      (a, b) => (byMonth[firstMonth]?.[b.id] ?? 0) - (byMonth[firstMonth]?.[a.id] ?? 0),
    );
  }

  const singleScMode = chartSc.length === 1;
  let subCats: string[] = [];
  let subCatColors: string[] = [];
  const subCatData: Record<string, Record<string, number>> = {};

  if (singleScMode) {
    const sc = chartSc[0];
    const totals: Record<string, number> = {};
    for (const m of months) {
      const subs = subsByMonth[m]?.[sc.id] ?? {};
      for (const [name, amt] of Object.entries(subs)) {
        totals[name] = (totals[name] ?? 0) + amt;
      }
    }
    subCats = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
    subCatColors = generateShades(sc.color, subCats.length);
    for (const m of months) {
      subCatData[m] = {};
      const subs = subsByMonth[m]?.[sc.id] ?? {};
      for (const name of subCats) subCatData[m][name] = subs[name] ?? 0;
    }
  }

  return {
    keys:        singleScMode ? subCats             : chartSc.map((sc) => sc.id),
    labels:      singleScMode ? subCats             : chartSc.map((sc) => sc.label),
    colors:      singleScMode ? subCatColors        : chartSc.map((sc) => sc.color),
    data:        singleScMode ? subCatData          : byMonth,
    singleScMode,
    subCatColors,
    orderedSc: chartSc,
  };
}

// ── ECharts option builder ────────────────────────────────────────

function buildOption(
  months: string[],
  layers: ChartLayers,
  subsByMonth: SubCatDetail,
  firstForecastIdx = -1,
) {
  const { keys, labels, colors, data, singleScMode, subCatColors, orderedSc } = layers;
  const axisColor = "#64748b";
  const gridColor = "#1e293b";
  const labelColor = "#94a3b8";

  // ── Bar series ────────────────────────────────────────────────────
  const series = keys.map((key, i) => {
    const isTop = i === keys.length - 1;
    const s: Record<string, unknown> = {
      name: labels[i],
      type: "bar",
      stack: "ausgaben",
      data: months.map((m, mi) => ({
        value: +(data[m]?.[key] ?? 0).toFixed(2),
        itemStyle: {
          color: colors[i],
          opacity: firstForecastIdx >= 0 && mi >= firstForecastIdx ? 0.55 : 1,
          borderRadius: isTop ? [2, 2, 0, 0] : 0,
          ...(singleScMode && keys.length > 1
            ? { borderColor: "#0f172a44", borderWidth: 1 }
            : {}),
        },
      })),
      emphasis: { focus: "series" as const },
    };

    if (i === 0 && firstForecastIdx > 0) {
      s.markLine = {
        silent: true,
        symbol: ["none", "none"],
        lineStyle: { color: "#475569", type: "dashed", width: 1.5 },
        label: { show: true, position: "insideStartTop", color: "#64748b", fontSize: 10, formatter: "Prognose →" },
        data: [{ xAxis: firstForecastIdx - 0.5 }],
      };
    }
    return s;
  });

  // ── Tooltip formatter ─────────────────────────────────────────────
  type TooltipParam = { seriesName: string; value: number; color: string; name: string; dataIndex: number };

  const tooltipFormatter = (raw: TooltipParam[] | TooltipParam) => {
    const first = Array.isArray(raw) ? raw[0] : raw;
    if (!first) return "";
    const idx = first.dataIndex;
    if (idx == null || idx < 0 || idx >= months.length) return "";

    const visible = labels
      .map((label, i) => ({
        seriesName: label,
        value: +(data[months[idx]]?.[keys[i]] ?? 0).toFixed(2),
        color: colors[i],
      }))
      .filter((p) => p.value > 0);
    if (!visible.length) return "";

    const monthKey = months[idx] ?? "";
    const monthSubs = subsByMonth[monthKey] ?? {};
    const total = visible.reduce((s, p) => s + (p.value ?? 0), 0);
    const isFuture = firstForecastIdx >= 0 && idx >= firstForecastIdx;

    let html = `<div style="font-weight:600;margin-bottom:4px;font-size:13px;color:#f1f5f9">${first.name ?? fmtMonth(monthKey)}</div>`;
    if (isFuture) {
      html += `<div style="margin-bottom:6px"><span style="background:#7c3aed22;border:1px solid #7c3aed55;color:#a78bfa;font-size:10px;padding:1px 6px;border-radius:9999px">Prognose (Periodizität)</span></div>`;
    }
    for (const p of visible) {
      const pct = total > 0 ? ((p.value / total) * 100).toFixed(1) : "0.0";
      html += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">
        <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${p.color};flex-shrink:0"></span>
        <span style="color:#e2e8f0;flex:1;font-weight:500">${p.seriesName}</span>
        <span style="font-family:monospace;color:#f1f5f9">${formatCHF(p.value)}</span>
        <span style="color:#64748b;font-size:11px;min-width:38px;text-align:right">${pct}%</span>
      </div>`;

      if (!singleScMode) {
        const scId = orderedSc.find((sc) => sc.label === p.seriesName)?.id ?? "";
        const subEntries = Object.entries(monthSubs[scId] ?? {})
          .sort((a, b) => b[1] - a[1]).filter(([, amt]) => amt > 0);
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
    }
    html += `<div style="border-top:1px solid #334155;margin-top:6px;padding-top:6px;display:flex;justify-content:space-between;">
      <span style="color:#94a3b8">Total</span>
      <span style="font-family:monospace;font-weight:600;color:#f1f5f9">${formatCHF(total)}</span>
    </div>`;
    return html;
  };

  const legendData = singleScMode
    ? (layers.keys as string[]).map((subName, ci) => ({
        name: subName,
        itemStyle: { color: subCatColors[ci] ?? orderedSc[0]?.color },
      }))
    : orderedSc.map((sc) => ({ name: sc.label, itemStyle: { color: sc.color } }));
  const legendBottom = singleScMode && keys.length > 6 ? 96 : 72;

  return {
    backgroundColor: "transparent",
    animation: true,
    animationDuration: 400,
    tooltip: {
      trigger: "item" as const,
      appendToBody: true,
      backgroundColor: "#1e293b",
      borderColor: "#334155",
      borderWidth: 1,
      textStyle: { color: "#e2e8f0", fontSize: 12 },
      formatter: tooltipFormatter,
    },
    legend: { bottom: 0, textStyle: { color: labelColor, fontSize: 11 }, data: legendData },
    grid: { top: 12, left: 16, right: 16, bottom: legendBottom, containLabel: true },
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
        formatter: (v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v),
      },
      splitLine: { lineStyle: { color: gridColor } },
      axisLine: { show: false },
    },
    // graphic is injected separately after render via injectRibbons()
    graphic: { elements: [] },
    series,
  };
}

// ── Graphic polygon ribbon injector ───────────────────────────────
/**
 * Computes trapezoid polygons that fill the gap between adjacent stacked bars.
 * Called after the chart renders so we have pixel-space coordinates via
 * convertToPixel. Mirrors the technique from the official ECharts example:
 * https://echarts.apache.org/examples/en/editor.html?c=bar-stack-normalization-and-variation
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function computeRibbonGraphic(inst: any, months: string[], layers: ChartLayers): object {
  if (!inst || months.length < 2) return { elements: [] };
  const { keys, colors, data } = layers;
  const snap = (v: number) => Math.round(v * 2) / 2;

  // ── Measure bar pixel edges per month ───────────────────────────
  // barEdges[j] = { left, right } in screen-pixel space.
  //
  // Method 1 (exact): Read from the chart VIEW's rendered data layout.
  //   In ECharts 5, layout is written onto the view's data store during render,
  //   not onto the model's data. We must go via getViewOfSeriesModel().
  //
  // Method 2 (fallback): derive from convertToPixel category centres +
  //   the actual barCategoryGap option (default '20%' → bar = 80% of band).
  //   This is accurate because we control the chart options.
  const barEdges: Array<{ left: number; right: number } | null> = months.map(() => null);

  // Pre-format month labels so we can look up categories by string (guaranteed match)
  const fmtMonths = months.map(fmtMonth);

  // Method 1 — chart view layout (exact pixel coords from ECharts internals)
  let method1Found = 0;
  try {
    const seriesModels = inst.getModel().getSeries();
    for (const sm of seriesModels) {
      if (sm.type !== "bar") continue;
      // getViewOfSeriesModel is a public ECharts API; view._data has post-render layout
      const view = inst.getViewOfSeriesModel?.(sm);
      const barData = view?._data ?? view?.getData?.() ?? sm.getData?.();
      if (!barData) continue;
      let found = 0;
      for (let idx = 0; idx < months.length; idx++) {
        const lay = barData.getItemLayout?.(idx);
        if (lay && Number.isFinite(lay.x) && lay.width > 0) {
          barEdges[idx] = { left: lay.x as number, right: (lay.x + lay.width) as number };
          found++;
        }
      }
      if (found > 0) { method1Found = found; break; }
    }
  } catch (_) { /* ignore — fall through to Method 2 */ }

  // Extract bar half-width from Method 1 results so Method 2 can reuse the measured value.
  // This avoids gap% guessing: if even one month has a real layout, all fallback months
  // use the same bar width, just centred on their convertToPixel coordinate.
  let measuredBarHalfWidth: number | null = null;
  for (const e of barEdges) {
    if (e && (e.right - e.left) > 0) {
      measuredBarHalfWidth = (e.right - e.left) / 2;
      break;
    }
  }

  // Method 2 — fills months still missing from Method 1.
  // Priority: (a) measured width from Method 1, (b) sm.get('barCategoryGap'),
  //           (c) empirical 30% fallback (ECharts stacked-bar rendered gap is ~30%).
  if (barEdges.some((e) => e === null)) {
    try {
      const c0 = inst.convertToPixel({ xAxisIndex: 0 }, fmtMonths[0]) as number;
      const c1 = inst.convertToPixel({ xAxisIndex: 0 }, fmtMonths[1]) as number;
      const bandWidth = Math.abs(c1 - c0);
      if (bandWidth > 0) {
        let barHalfWidth: number;
        if (measuredBarHalfWidth !== null && measuredBarHalfWidth > 0) {
          // Best: use the real bar width already measured from Method 1
          barHalfWidth = measuredBarHalfWidth;
        } else {
          // Fallback: read gap% from series model (includes registered defaults).
          // If that is also unavailable, '30%' is the empirically correct value
          // for ECharts 5 stacked bar charts (~70% bar / ~30% category gap).
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const barSm = inst.getModel().getSeries().find((s: any) => s.type === "bar");
          const gapStr: string = barSm?.get?.("barCategoryGap") ?? "30%";
          barHalfWidth = (bandWidth * (1 - parseFloat(gapStr) / 100)) / 2;
        }
        for (let idx = 0; idx < months.length; idx++) {
          if (barEdges[idx] !== null) continue;
          const cx = inst.convertToPixel({ xAxisIndex: 0 }, fmtMonths[idx]) as number;
          if (Number.isFinite(cx)) {
            barEdges[idx] = { left: cx - barHalfWidth, right: cx + barHalfWidth };
          }
        }
      }
    } catch (_) { /* ignore */ }
  }

  // Diagnostic — visible in browser DevTools
  if (import.meta.env?.DEV) {
    try {
      // eslint-disable-next-line no-console
      console.debug("[ribbon] barEdges", {
        method1Found,
        measuredBarHalfWidth: measuredBarHalfWidth && Math.round(measuredBarHalfWidth),
        edges: barEdges.slice(0, 4).map((e) => e && {
          left: Math.round(e.left), right: Math.round(e.right), width: Math.round(e.right - e.left),
        }),
      });
    } catch (_) { /* ignore diagnostic errors */ }
  }

  // Precompute cumulative bottom/top per layer per month (data space values)
  const cumBot: number[][] = months.map(() => new Array(keys.length).fill(0));
  const cumTop: number[][] = months.map(() => new Array(keys.length).fill(0));
  for (let j = 0; j < months.length; j++) {
    let acc = 0;
    for (let i = 0; i < keys.length; i++) {
      cumBot[j][i] = acc;
      acc += data[months[j]]?.[keys[i]] ?? 0;
      cumTop[j][i] = acc;
    }
  }

  const elements: object[] = [];

  for (let j = 1; j < months.length; j++) {
    const le = barEdges[j - 1];
    const re = barEdges[j];
    if (!le || !re) continue;

    // 2 px overlap into each bar eliminates sub-pixel seams at bar/ribbon boundaries.
    const leftX  = snap(le.right - 2);
    const rightX = snap(re.left  + 2);
    if (rightX <= leftX) continue; // bars touching or overlapping — no gap to fill

    for (let i = 0; i < keys.length; i++) {
      try {
        const leftBottomY  = inst.convertToPixel({ yAxisIndex: 0 }, cumBot[j-1][i]) as number;
        const leftTopY     = inst.convertToPixel({ yAxisIndex: 0 }, cumTop[j-1][i]) as number;
        const rightBottomY = inst.convertToPixel({ yAxisIndex: 0 }, cumBot[j][i]) as number;
        const rightTopY    = inst.convertToPixel({ yAxisIndex: 0 }, cumTop[j][i]) as number;

        // Skip invisible (zero-height) layers
        if (Math.abs(leftTopY - leftBottomY) < 0.5 && Math.abs(rightTopY - rightBottomY) < 0.5) continue;

        elements.push({
          type: "polygon",
          z: 1,
          shape: {
            points: [
              [leftX,  snap(leftBottomY)],
              [leftX,  snap(leftTopY)],
              [rightX, snap(rightTopY)],
              [rightX, snap(rightBottomY)],
            ],
          },
          style: {
            fill: colors[i],
            opacity: 0.12,
            lineWidth: 0,
          },
          silent: true,
        });
      } catch (_) { /* ignore */ }
    }
  }

  return { elements };
}

// ── Main component ────────────────────────────────────────────────

export default function BudgetStackedBarChart({
  historicalData,
  forecastData,
  historicalAxisMonths,
  forecastAxisMonths,
  wizardData,
  budgetPlanByMonth,
  budgetPlanMonths,
  height = 320,
  embedded = false,
  hiddenScIds,
  sortOrder = "default",
}: Props) {
  const [mode, setMode] = useState<"historical" | "forecast" | "budgetplan">("historical");
  // In embedded mode always show historical data (no forecast toggle)
  const activeMode = embedded ? "historical" : mode;
  const hasBudgetPlan = (budgetPlanMonths?.length ?? 0) > 0 && budgetPlanByMonth != null;
  const superCategories = useTaxonomySuperCategories();
  const chartSc = useMemo(
    () =>
      CHART_SC_ORDER
        .map((id) => superCategories.find((sc) => sc.id === id))
        .filter((sc): sc is SuperCategory => sc !== undefined)
        .filter((sc) => !hiddenScIds?.has(sc.id)),
    [superCategories, hiddenScIds],
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
  const activeMonths = activeMode === "historical"
    ? historicalCombinedMonths
    : activeMode === "budgetplan"
      ? (budgetPlanMonths ?? forecastMonths)
      : forecastMonths;
  const activeByMonth = activeMode === "historical"
    ? historicalCombinedByMonth
    : activeMode === "budgetplan"
      ? (budgetPlanByMonth ?? {})
      : forecastByMonth;
  const activeSubs = activeMode === "historical"
    ? historicalCombinedSubs
    : (activeMode === "budgetplan" ? {} : forecastSubs) as SubCatDetail;
  const activeFirstForecastIdx = activeMode === "historical" ? histFirstForecastIdx : -1;

  // Compute layer data (keys/colors/sorted SC order) — shared by option + ribbon injector
  const layers = useMemo(
    () => computeLayers(activeMonths, activeByMonth, activeSubs, chartSc, sortOrder),
    [activeMonths, activeByMonth, activeSubs, chartSc, sortOrder],
  );

  const option = useMemo(
    () => buildOption(activeMonths, layers, activeSubs, activeFirstForecastIdx),
    [activeMonths, layers, activeSubs, activeFirstForecastIdx],
  );

  // ── Ribbon polygon injection ───────────────────────────────────
  // Use canvas renderer so convertToPixel returns correct pixel coords.
  // After each render cycle, compute trapezoid polygons that fill the gap
  // between the right edge of bar N and the left edge of bar N+1.
  const echartsRef = useRef<ReactECharts>(null);

  const injectRibbons = useCallback(() => {
    const inst = echartsRef.current?.getEchartsInstance();
    if (!inst) return;
    const graphic = computeRibbonGraphic(inst, activeMonths, layers);
    inst.setOption({ graphic }, false);
  }, [activeMonths, layers]);

  useEffect(() => {
    // Wait one tick for ECharts to finish painting bars before reading layouts
    const id = setTimeout(injectRibbons, 0);
    return () => clearTimeout(id);
  }, [injectRibbons]);

  // Status label under the chart title
  const sourceLabel = useMemo(() => {
    if (activeMode === "budgetplan") return "Budgetplan · Wiederkehrende Einträge nach Superkategorie";
    if (activeMode === "historical") {
      return histFirstForecastIdx >= 0
        ? "Ist-Daten + Prognose aus wiederkehrenden Zahlungen (Ø 12 Mt.)"
        : "Ist-Daten aus realen Transaktionen";
    }
    if (wizardData) return "Empirische Angaben · Steuern fix";
    if (Object.keys(recurringPatterns.monthlyAvg).length > 0)
      return "Wiederkehrende Zahlungen · Ø letzte 12 Monate";
    return "KI-Prognose · Steuern auf histor. Ø begrenzt";
  }, [activeMode, histFirstForecastIdx, wizardData, recurringPatterns]);

  const hasData = activeMonths.length > 0;

  const modeToggle = embedded ? null : (
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
      {hasBudgetPlan && (
        <button
          type="button"
          onClick={() => setMode("budgetplan")}
          className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
            mode === "budgetplan"
              ? "bg-accent text-white shadow-sm"
              : "text-text-secondary hover:text-text-primary"
          }`}
        >
          Budgetplan
        </button>
      )}
    </div>
  );

  const chartBody = (
    <>
      {!hasData ? (
        <div
          className="flex items-center justify-center text-text-tertiary text-sm"
          style={{ height }}
        >
          {activeMode === "historical"
            ? "Keine historischen Transaktionsdaten verfügbar."
            : activeMode === "budgetplan"
              ? "Keine Budgetplan-Einträge vorhanden."
              : "Keine Prognosedaten — wähle einen Zeithorizont."}
        </div>
      ) : (
        <ReactECharts
          ref={echartsRef}
          option={option}
          style={{ height }}
          opts={{ renderer: "canvas" }}
          notMerge
        />
      )}
    </>
  );

  if (embedded) {
    return (
      <div>
        <div className="px-4 pt-2 pb-1">
          <p className="text-text-tertiary text-[11px]">{sourceLabel}</p>
        </div>
        <div className="px-2 pb-2">
          {chartBody}
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-text-primary font-semibold text-sm">
            Ausgaben nach Kategorie
          </h2>
          <p className="text-text-tertiary text-[11px] mt-0.5">{sourceLabel}</p>
        </div>
        {modeToggle}
      </div>
      {chartBody}
    </div>
  );
}
