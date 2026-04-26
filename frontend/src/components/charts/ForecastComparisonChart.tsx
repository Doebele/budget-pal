/**
 * ForecastComparisonChart
 *
 * Overlays (each individually togglable):
 *   · Solid blue        — historical monthly net
 *   · Dashed violet     — predicted net (from forecast API)
 *   · Shaded band       — 90 % confidence interval
 *   · Dashed green      — peer-group reference line (flat)
 *   · Dashed amber      — empirical Swiss median (flat)
 *   · Green/red lines   — income / expense breakdown (optional)
 */
import { useState } from "react";
import {
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { formatCHF } from "@/lib/theme";
import { clsx } from "clsx";

export interface HistoricalPoint {
  month: string; // "2025-03"
  income: number;
  expense: number;
  net: number;
}

export interface ForecastPoint {
  month: string;
  predicted_income: number;
  predicted_expense: number;
  net: number;
  confidence_low: number;
  confidence_high: number;
  peer_calibrated: boolean;
}

export interface BudgetPlanPoint {
  month: string; // "2026-01"
  income: number;  // positive
  expense: number; // negative
  net: number;
}

// Which series are visible — controlled externally or via internal toggles
export interface LineVisibility {
  historical: boolean;
  forecast: boolean;
  confidence: boolean;
  peer: boolean;
  empirical: boolean;
  breakdown: boolean;
  budgetPlan: boolean;
}

interface Props {
  historical: HistoricalPoint[];
  forecast: ForecastPoint[];
  /** Monthly income/expense/net from the recurring plan (Budgetplan) */
  budgetPlanPoints?: BudgetPlanPoint[];
  /** Flat reference value for peer-group monthly net (CHF) */
  peerNetMonthly?: number;
  /** Flat reference value for empirical Swiss median net (CHF) */
  empiricalNetMonthly?: number;
  height?: number;
}

const COLORS = {
  historical:  "#60a5fa", // blue-400
  forecast:    "#a78bfa", // violet-400
  income:      "#4ade80", // green-400
  expense:     "#f87171", // red-400
  confidence:  "#7c3aed", // violet-700
  peer:        "#34d399", // emerald-400
  empirical:   "#fbbf24", // amber-400
  budgetPlan:  "#f97316", // orange-500
  zero:        "#6b7280", // gray-500
};

const DEFAULT_VISIBILITY: LineVisibility = {
  historical:  true,
  forecast:    true,
  confidence:  true,
  peer:        true,
  empirical:   true,
  breakdown:   false,
  budgetPlan:  true,
};

const LINE_LABELS: Record<keyof LineVisibility, string> = {
  historical:  "Historisch",
  forecast:    "Prognose",
  confidence:  "90%-Band",
  peer:        "Peer-Ø",
  empirical:   "Empirisch",
  breakdown:   "Einnahmen/Ausgaben",
  budgetPlan:  "Budgetplan",
};

const LINE_COLORS: Record<keyof LineVisibility, string> = {
  historical:  COLORS.historical,
  forecast:    COLORS.forecast,
  confidence:  COLORS.confidence,
  peer:        COLORS.peer,
  empirical:   COLORS.empirical,
  breakdown:   COLORS.income,
  budgetPlan:  COLORS.budgetPlan,
};

function formatMonth(m: string): string {
  const [year, month] = m.split("-");
  const names = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun",
                  "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
  return `${names[parseInt(month, 10) - 1]} ${year.slice(2)}`;
}

// ── Tooltip ───────────────────────────────────────────────────

function CustomTooltip({ active, payload, label, peerNet, empiricalNet }: any) {
  if (!active || !payload?.length) return null;
  const isForecast = payload[0]?.payload?.isForecast;

  const NAME_MAP: Record<string, string> = {
    net:               "Historisch (Netto)",
    predicted_net:     "Prognose (Netto)",
    budgetPlan_net:    "Budgetplan (Netto)",
    income:            "Einnahmen",
    expense:           "Ausgaben",
    predicted_income:  "Progn. Einnahmen",
    predicted_expense: "Progn. Ausgaben",
  };

  return (
    <div className="bg-bg-surface border border-border rounded-lg p-3 shadow-xl text-xs space-y-1 min-w-[200px]">
      <p className="font-semibold text-text-primary mb-1">{formatMonth(label)}</p>
      {isForecast && (
        <span className="inline-block bg-violet-500/20 text-violet-300 text-[10px] px-1.5 py-0.5 rounded mb-1">
          Prognose
        </span>
      )}
      {payload.map((entry: any) => {
        if (entry.name === "confidence_band") return null;
        const label_ = NAME_MAP[entry.name] ?? entry.name;
        return (
          <div key={entry.name} className="flex justify-between gap-4">
            <span style={{ color: entry.stroke || entry.fill }} className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full inline-block" style={{ background: entry.stroke || entry.fill }} />
              {label_}
            </span>
            <span className="text-text-primary font-mono">{formatCHF(entry.value)}</span>
          </div>
        );
      })}
      {isForecast && payload[0]?.payload?.confidence_low != null && (
        <div className="border-t border-border/50 pt-1 mt-1 text-text-tertiary">
          90%-Band: {formatCHF(payload[0].payload.confidence_low)} – {formatCHF(payload[0].payload.confidence_high)}
        </div>
      )}
      {/* Always show peer/empirical reference in tooltip */}
      {(peerNet !== 0 || empiricalNet !== 0) && (
        <div className="border-t border-border/50 pt-1 mt-1 space-y-0.5">
          {peerNet !== 0 && (
            <div className="flex justify-between gap-4">
              <span style={{ color: COLORS.peer }} className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full inline-block" style={{ background: COLORS.peer }} />
                Peer-Ø
              </span>
              <span className="text-text-primary font-mono">{formatCHF(peerNet)}</span>
            </div>
          )}
          {empiricalNet !== 0 && (
            <div className="flex justify-between gap-4">
              <span style={{ color: COLORS.empirical }} className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full inline-block" style={{ background: COLORS.empirical }} />
                Empirisch
              </span>
              <span className="text-text-primary font-mono">{formatCHF(empiricalNet)}</span>
            </div>
          )}
        </div>
      )}
      {isForecast && payload[0]?.payload?.peer_calibrated && (
        <div className="text-[10px] text-violet-400 pt-0.5">⊕ Peer-Gruppe kalibriert</div>
      )}
    </div>
  );
}

// ── Toggle pill ───────────────────────────────────────────────

function LinePill({
  id,
  active,
  color,
  label,
  dashed,
  onToggle,
}: {
  id: keyof LineVisibility;
  active: boolean;
  color: string;
  label: string;
  dashed?: boolean;
  onToggle: (id: keyof LineVisibility) => void;
}) {
  return (
    <button
      onClick={() => onToggle(id)}
      className={clsx(
        "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium transition-all border",
        active
          ? "border-transparent text-white"
          : "border-border/50 text-text-tertiary bg-transparent hover:text-text-secondary"
      )}
      style={active ? { backgroundColor: color + "33", borderColor: color + "66", color } : {}}
    >
      {/* Icon: line swatch */}
      <svg width="16" height="8" viewBox="0 0 16 8">
        <line
          x1="0" y1="4" x2="16" y2="4"
          stroke={active ? color : "#6b7280"}
          strokeWidth={dashed ? 1.5 : 2}
          strokeDasharray={dashed ? "4 3" : undefined}
        />
        {!dashed && (
          <circle cx="8" cy="4" r="2" fill={active ? color : "#6b7280"} />
        )}
      </svg>
      {label}
    </button>
  );
}

// ── Main component ────────────────────────────────────────────

export default function ForecastComparisonChart({
  historical,
  forecast,
  budgetPlanPoints = [],
  peerNetMonthly = 0,
  empiricalNetMonthly = 0,
  height = 320,
}: Props) {
  const [vis, setVis] = useState<LineVisibility>(DEFAULT_VISIBILITY);

  const toggle = (id: keyof LineVisibility) =>
    setVis((v) => ({ ...v, [id]: !v[id] }));

  // Build unified dataset
  const histData = historical.map((h) => ({
    month: h.month,
    net: h.net,
    income: h.income,
    expense: -Math.abs(h.expense),
    isForecast: false,
  }));

  const forecastData = forecast.map((f) => ({
    month: f.month,
    predicted_net: f.net,
    predicted_income: f.predicted_income,
    predicted_expense: -Math.abs(f.predicted_expense),
    confidence_low: f.confidence_low,
    confidence_high: f.confidence_high,
    confidence_band: [f.confidence_low, f.confidence_high] as [number, number],
    peer_calibrated: f.peer_calibrated,
    isForecast: true,
  }));

  // Map budget plan points by month for fast lookup
  const budgetPlanMap = new Map(budgetPlanPoints.map((p) => [p.month, p]));

  const bridgeMonth = histData.slice(-1)[0];
  const mergedData = [
    ...histData,
    ...forecastData.map((f) => ({
      ...f,
      net: bridgeMonth && f.month === forecastData[0]?.month ? bridgeMonth.net : undefined,
    })),
  ].map((d) => ({
    ...d,
    budgetPlan_net: budgetPlanMap.get(d.month)?.net,
  }));

  // Determine y-domain so peer/empirical/budgetPlan lines are always visible
  const allNets = [
    ...histData.map((d) => d.net),
    ...forecastData.map((d) => d.predicted_net ?? 0),
    ...forecastData.map((d) => d.confidence_low ?? 0),
    ...forecastData.map((d) => d.confidence_high ?? 0),
    ...budgetPlanPoints.map((p) => p.net),
    peerNetMonthly,
    empiricalNetMonthly,
  ].filter((v) => v !== undefined && !isNaN(v));

  const minY = Math.min(...allNets, 0);
  const maxY = Math.max(...allNets, 0);
  const pad  = (maxY - minY) * 0.12 || 5000;
  const yDomain: [number, number] = [Math.floor((minY - pad) / 1000) * 1000, Math.ceil((maxY + pad) / 1000) * 1000];

  return (
    <div className="space-y-3">
      {/* ── Toggle controls ── */}
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(DEFAULT_VISIBILITY) as (keyof LineVisibility)[]).map((key) => (
          <LinePill
            key={key}
            id={key}
            active={vis[key]}
            color={LINE_COLORS[key]}
            label={LINE_LABELS[key]}
            dashed={key !== "historical"}
            onToggle={toggle}
          />
        ))}
      </div>

      {/* ── Chart ── */}
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={mergedData} margin={{ top: 8, right: 16, bottom: 0, left: 16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />

          <XAxis
            dataKey="month"
            tickFormatter={formatMonth}
            tick={{ fill: "#94a3b8", fontSize: 11 }}
            axisLine={{ stroke: "#334155" }}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`}
            tick={{ fill: "#94a3b8", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={44}
            domain={yDomain}
          />

          <Tooltip
            content={
              <CustomTooltip
                peerNet={vis.peer ? peerNetMonthly : 0}
                empiricalNet={vis.empirical ? empiricalNetMonthly : 0}
              />
            }
          />

          {/* ── Zero reference ── */}
          <ReferenceLine y={0} stroke={COLORS.zero} strokeDasharray="4 4" strokeWidth={1} />

          {/* ── Peer-group flat reference line ── */}
          {vis.peer && peerNetMonthly !== 0 && (
            <ReferenceLine
              y={peerNetMonthly}
              stroke={COLORS.peer}
              strokeDasharray="6 3"
              strokeWidth={1.5}
              label={{
                value: `Peer-Ø ${formatCHF(peerNetMonthly)}`,
                position: "insideTopRight",
                fill: COLORS.peer,
                fontSize: 10,
              }}
            />
          )}

          {/* ── Empirical flat reference line ── */}
          {vis.empirical && empiricalNetMonthly !== 0 && (
            <ReferenceLine
              y={empiricalNetMonthly}
              stroke={COLORS.empirical}
              strokeDasharray="6 3"
              strokeWidth={1.5}
              label={{
                value: `Empirisch ${formatCHF(empiricalNetMonthly)}`,
                position: "insideTopRight",
                fill: COLORS.empirical,
                fontSize: 10,
              }}
            />
          )}

          {/* ── Confidence band ── */}
          {vis.confidence && (
            <Area
              dataKey="confidence_band"
              stroke="none"
              fill={COLORS.confidence}
              fillOpacity={0.15}
              activeDot={false}
              legendType="none"
              connectNulls
            />
          )}

          {/* ── Historical net (solid) ── */}
          {vis.historical && (
            <Line
              dataKey="net"
              name="net"
              stroke={COLORS.historical}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: COLORS.historical }}
              connectNulls
            />
          )}

          {/* ── Forecast net (dotted) ── */}
          {vis.forecast && (
            <Line
              dataKey="predicted_net"
              name="predicted_net"
              stroke={COLORS.forecast}
              strokeWidth={2}
              strokeDasharray="6 4"
              dot={false}
              activeDot={{ r: 4, fill: COLORS.forecast }}
              connectNulls
            />
          )}

          {/* ── Budgetplan net (orange dashed) ── */}
          {vis.budgetPlan && budgetPlanPoints.length > 0 && (
            <Line
              dataKey="budgetPlan_net"
              name="budgetPlan_net"
              stroke={COLORS.budgetPlan}
              strokeWidth={2}
              strokeDasharray="9 4"
              dot={false}
              activeDot={{ r: 4, fill: COLORS.budgetPlan }}
              connectNulls
            />
          )}

          {/* ── Breakdown lines (income / expense) ── */}
          {vis.breakdown && (
            <>
              <Line
                dataKey="income"
                name="income"
                stroke={COLORS.income}
                strokeWidth={1.5}
                dot={false}
                strokeOpacity={0.75}
              />
              <Line
                dataKey="expense"
                name="expense"
                stroke={COLORS.expense}
                strokeWidth={1.5}
                dot={false}
                strokeOpacity={0.75}
              />
              <Line
                dataKey="predicted_income"
                name="predicted_income"
                stroke={COLORS.income}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                dot={false}
                strokeOpacity={0.75}
              />
              <Line
                dataKey="predicted_expense"
                name="predicted_expense"
                stroke={COLORS.expense}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                dot={false}
                strokeOpacity={0.75}
              />
            </>
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
