/**
 * CategoryGaugeChart — ECharts ring gauge grid for budget categories.
 *
 * Each supercategory gets its own gauge with up to 3 concentric rings:
 *   Outer  (largest)  : Historisch  — actual spending
 *   Middle            : Peer-Ø      — always anchored to 50% of scale (the benchmark)
 *   Inner  (smallest) : Empirisch   — wizard/planned amount
 *
 * The gauge max = peer × 2, so the peer ring always stops exactly at the
 * midpoint.  Actual/planned beyond 2× peer are clamped and rendered in
 * warning red so over-budget items are immediately visible.
 */
import ReactECharts from "echarts-for-react";
import { useMemo } from "react";
import { colors, formatCHF } from "@/lib/theme";
import type { SuperCategory } from "@/lib/categories";
import { EyeOff } from "lucide-react";

// ── Public types ───────────────────────────────────────────────
export interface GaugeRow {
  sc: SuperCategory;
  actual: number;   // historical (real transactions)
  planned: number;  // empirical (wizard budgets)
  peer?: number;    // peer benchmark (per period)
  hidden?: boolean; // currently hidden via filter
}

interface CategoryGaugeChartProps {
  rows: GaugeRow[];
  /** true when peer data has been loaded and at least one row has a peer value */
  hasPeer: boolean;
  /** Called when user clicks the eye icon on a gauge card */
  onToggleHide: (scId: string) => void;
}

// ── Constants ──────────────────────────────────────────────────
const SA = 225;   // startAngle  — lower-left  (standard speedometer)
const EA = -45;   // endAngle    — lower-right
const TRACK = "#1a1b23";   // empty-track background

// ── Helpers ────────────────────────────────────────────────────
function pctLabel(actual: number, ref: number): string {
  if (ref <= 0) return "";
  const pct = Math.round((actual / ref) * 100);
  return pct > 100 ? `+${pct - 100}% über Ø` : `${pct}% von Ø`;
}

function fmtCompact(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000)    return `${(v / 1_000).toFixed(0)}k`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}

// ── Gauge option factory ───────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeOption(row: GaugeRow, hasPeer: boolean): any {
  const { sc, actual, planned, peer } = row;
  const hasPeerVal = hasPeer && (peer ?? 0) > 0;

  // Scale: peer anchored at exactly 50% of gauge max
  const gaugeMax = hasPeerVal
    ? (peer! * 2)
    : Math.max(actual, planned, 1) * 2;

  // Clamp displayed values to gaugeMax (overflow shown via color change)
  const actualClamped  = Math.min(actual,  gaugeMax * 0.999);
  const peerClamped    = hasPeerVal ? peer! * 0.999 : 0;   // ≈ 50%
  const plannedClamped = Math.min(planned, gaugeMax * 0.999);

  const isOverPeer  = hasPeerVal && actual  > peer!;
  const isOverPlan  =              planned  > 0 && actual > planned;
  const actualColor = isOverPeer ? "#f87171" : sc.color;
  const plannedColor = sc.color + "70";

  // ── series definitions ──────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const series: any[] = [];

  // ── Center label offsets (3-line stack) ────────────────────────
  // Actual: large, top of center
  // Peer + Planned: small, below
  const hasSecondary = hasPeerVal || planned > 0;
  const actualOffset  = hasSecondary ? "-12%" : "8%";
  const peerOffset    = planned > 0 ? "14%"  : "28%";
  const plannedOffset = "28%";

  // OUTER RING — Historisch (actual) — shows main CHF value
  series.push({
    name: "Historisch",
    type: "gauge",
    radius: "98%",
    startAngle: SA, endAngle: EA,
    min: 0, max: gaugeMax,
    progress: { show: true, width: 12, roundCap: true, overlap: false },
    axisLine: { lineStyle: { width: 12, color: [[1, TRACK]] } },
    splitLine: { show: false },
    axisTick: { show: false },
    axisLabel: { show: false },
    pointer: { show: false },
    detail: {
      show: true,
      offsetCenter: [0, actualOffset],
      fontSize: 14,
      fontWeight: 700,
      fontFamily: "Syne, system-ui, sans-serif",
      color: isOverPeer ? "#f87171" : isOverPlan ? "#fbbf24" : colors.textSecondary,
      formatter: () => `CHF ${fmtCompact(actual)}`,
    },
    title: { show: false },
    data: [{ value: actualClamped, itemStyle: { color: actualColor } }],
  });

  // MIDDLE RING — Peer-Benchmark (always ≈ 50%) — shows Ø value small
  if (hasPeerVal) {
    series.push({
      name: "Peer-Ø",
      type: "gauge",
      radius: "78%",
      startAngle: SA, endAngle: EA,
      min: 0, max: gaugeMax,
      progress: { show: true, width: 11, roundCap: true, overlap: false },
      axisLine: { lineStyle: { width: 11, color: [[1, TRACK]] } },
      splitLine: { show: false },
      axisTick: { show: false },
      axisLabel: { show: false },
      pointer: { show: false },
      detail: {
        show: true,
        offsetCenter: [0, peerOffset],
        fontSize: 9,
        fontWeight: 400,
        fontFamily: "Syne, system-ui, sans-serif",
        color: "#64748b",
        formatter: () => `Ø ${fmtCompact(peer!)}`,
      },
      title: { show: false },
      data: [{ value: peerClamped, itemStyle: { color: "#64748b" } }],
    });
  }

  // INNER RING — Empirisch (planned) — shows Soll value small
  if (planned > 0) {
    series.push({
      name: "Empirisch",
      type: "gauge",
      radius: hasPeerVal ? "60%" : "78%",
      startAngle: SA, endAngle: EA,
      min: 0, max: gaugeMax,
      progress: { show: true, width: 10, roundCap: true, overlap: false },
      axisLine: { lineStyle: { width: 10, color: [[1, TRACK]] } },
      splitLine: { show: false },
      axisTick: { show: false },
      axisLabel: { show: false },
      pointer: { show: false },
      detail: {
        show: true,
        offsetCenter: [0, plannedOffset],
        fontSize: 9,
        fontWeight: 400,
        fontFamily: "Syne, system-ui, sans-serif",
        color: sc.color + "bb",
        formatter: () => `≈ ${fmtCompact(planned)}`,
      },
      title: { show: false },
      data: [{ value: plannedClamped, itemStyle: { color: plannedColor } }],
    });
  }

  return {
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item",
      backgroundColor: colors.bgElevated,
      borderColor: colors.border,
      borderWidth: 1,
      padding: [6, 10],
      textStyle: {
        color: colors.textPrimary,
        fontSize: 11,
        fontFamily: "Syne, system-ui, sans-serif",
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      formatter: (params: any) => {
        if (params.seriesName === "Historisch") {
          return `<b>Historisch</b><br/>
            ${formatCHF(actual)}
            ${hasPeerVal ? `<br/><span style="color:${colors.textTertiary}">${pctLabel(actual, peer!)}</span>` : ""}`;
        }
        if (params.seriesName === "Peer-Ø") {
          return `<b>Peer-Ø (Benchmark)</b><br/>${formatCHF(peer ?? 0)}`;
        }
        if (params.seriesName === "Empirisch") {
          return `<b>Empirisch (Soll)</b><br/>${formatCHF(planned)}`;
        }
        return params.seriesName;
      },
    },
    series,
  };
}

// ── Component ──────────────────────────────────────────────────
export default function CategoryGaugeChart({ rows, hasPeer, onToggleHide }: CategoryGaugeChartProps) {
  const visibleRows = useMemo(
    () => rows.filter((r) => !r.hidden),
    [rows],
  );
  const hiddenRows = useMemo(
    () => rows.filter((r) => r.hidden),
    [rows],
  );

  if (visibleRows.length === 0 && hiddenRows.length === 0) {
    return (
      <div className="py-10 text-center text-text-tertiary text-sm">
        Keine Daten verfügbar
      </div>
    );
  }

  return (
    <div className="px-4 py-4">
      {/* Legend */}
      <div className="flex flex-wrap gap-x-5 gap-y-1 mb-4 text-xs text-text-tertiary">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full inline-block bg-accent/80" />
          Historisch (Ist)
        </span>
        {hasPeer && (
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-full inline-block bg-slate-600" />
            Peer-Ø — immer bei 50 %
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full inline-block bg-accent/30" />
          Empirisch (Soll)
        </span>
      </div>

      {/* Gauge grid */}
      {visibleRows.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
          {visibleRows.map((row) => {
            const option = makeOption(row, hasPeer);
            const isOver = hasPeer && (row.peer ?? 0) > 0 && row.actual > (row.peer ?? 0);

            return (
              <div
                key={row.sc.id}
                className="relative flex flex-col items-center rounded-xl bg-bg-surface2 border border-border/40 pt-2 pb-3 px-2"
              >
                {/* Eye/hide button */}
                <button
                  type="button"
                  title={`${row.sc.label} ausblenden`}
                  onClick={() => onToggleHide(row.sc.id)}
                  className="absolute top-1.5 right-1.5 p-1 rounded-md text-text-disabled hover:text-text-tertiary hover:bg-bg-elevated transition-colors"
                >
                  <EyeOff className="w-3 h-3" />
                </button>

                {/* ECharts ring gauge */}
                <ReactECharts
                  option={option}
                  style={{ width: "100%", height: 150 }}
                  opts={{ renderer: "svg" }}
                />

                {/* Category label */}
                <div className="flex items-center gap-1.5 mt-1">
                  <span
                    className="w-5 h-5 rounded-md flex items-center justify-center shrink-0"
                    style={{ backgroundColor: row.sc.color + "22" }}
                  >
                    <row.sc.icon className="w-3 h-3" style={{ color: row.sc.color }} />
                  </span>
                  <span className="text-xs font-medium text-text-secondary truncate max-w-[90px]">
                    {row.sc.label}
                  </span>
                </div>

                {/* Peer comparison hint */}
                {hasPeer && (row.peer ?? 0) > 0 && (
                  <p
                    className="text-[10px] mt-0.5 font-mono"
                    style={{ color: isOver ? "#f87171" : colors.textTertiary }}
                  >
                    {pctLabel(row.actual, row.peer!)}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-center text-text-tertiary text-sm py-6">
          Alle Kategorien ausgeblendet — nutze die Filter-Chips oben um Kategorien einzublenden.
        </p>
      )}
    </div>
  );
}
