/**
 * ForecastComparisonChart
 *
 * Overlays:
 *   · Solid line  — historical monthly net (actual income − expense)
 *   · Dotted line — predicted net (from forecast API)
 *   · Shaded band — 90 % confidence interval
 *
 * Dark-mode first (bg-slate-800 background via parent card).
 */
import {
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { formatCHF } from "@/lib/theme";

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

interface Props {
  historical: HistoricalPoint[];
  forecast: ForecastPoint[];
  /** Show confidence band (default true) */
  showConfidence?: boolean;
  /** Show income / expense lines in addition to net (default false) */
  showBreakdown?: boolean;
  height?: number;
}

const COLORS = {
  historical: "#60a5fa", // blue-400
  forecast: "#a78bfa",   // violet-400
  income: "#4ade80",     // green-400
  expense: "#f87171",    // red-400
  confidence: "#7c3aed", // violet-700
  zero: "#6b7280",       // gray-500
};

function formatMonth(m: string): string {
  const [year, month] = m.split("-");
  const names = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun",
                  "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
  return `${names[parseInt(month, 10) - 1]} ${year.slice(2)}`;
}

// Custom tooltip
function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const isForecast = payload[0]?.payload?.isForecast;

  return (
    <div className="bg-bg-surface border border-border rounded-lg p-3 shadow-xl text-xs space-y-1 min-w-[180px]">
      <p className="font-semibold text-text-primary mb-1">{formatMonth(label)}</p>
      {isForecast && (
        <span className="inline-block bg-violet-500/20 text-violet-300 text-[10px] px-1.5 py-0.5 rounded mb-1">
          Prognose
        </span>
      )}
      {payload.map((entry: any) => {
        if (entry.name === "confidence_band") return null;
        return (
          <div key={entry.name} className="flex justify-between gap-4">
            <span style={{ color: entry.stroke || entry.fill }} className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full inline-block" style={{ background: entry.stroke || entry.fill }} />
              {entry.name === "net" && "Netto"}
              {entry.name === "predicted_net" && "Prognose Netto"}
              {entry.name === "income" && "Einnahmen"}
              {entry.name === "expense" && "Ausgaben"}
              {entry.name === "predicted_income" && "Progn. Einnahmen"}
              {entry.name === "predicted_expense" && "Progn. Ausgaben"}
            </span>
            <span className="text-text-primary font-mono">
              {formatCHF(entry.value)}
            </span>
          </div>
        );
      })}
      {isForecast && payload[0]?.payload?.confidence_low != null && (
        <div className="border-t border-border/50 pt-1 mt-1 text-text-tertiary">
          90%-Band: {formatCHF(payload[0].payload.confidence_low)} – {formatCHF(payload[0].payload.confidence_high)}
        </div>
      )}
      {isForecast && payload[0]?.payload?.peer_calibrated && (
        <div className="text-[10px] text-violet-400">⊕ Peer-Gruppe kalibriert</div>
      )}
    </div>
  );
}

export default function ForecastComparisonChart({
  historical,
  forecast,
  showConfidence = true,
  showBreakdown = false,
  height = 320,
}: Props) {
  // Merge historical + forecast into single dataset, with a gap marker
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

  // Last historical point bridges into forecast
  const bridgeMonth = histData.slice(-1)[0];
  const mergedData = [
    ...histData,
    ...forecastData.map((f) => ({
      ...f,
      // carry forward net for bridging
      net: bridgeMonth && f.month === forecastData[0]?.month ? bridgeMonth.net : undefined,
    })),
  ];

  return (
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
        />

        <Tooltip content={<CustomTooltip />} />

        <ReferenceLine y={0} stroke={COLORS.zero} strokeDasharray="4 4" strokeWidth={1} />

        {/* ── Confidence band (forecast) ── */}
        {showConfidence && (
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
        <Line
          dataKey="net"
          name="net"
          stroke={COLORS.historical}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, fill: COLORS.historical }}
          connectNulls
        />

        {/* ── Forecast net (dotted) ── */}
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

        {/* ── Optional income/expense breakdown ── */}
        {showBreakdown && (
          <>
            <Line
              dataKey="income"
              name="income"
              stroke={COLORS.income}
              strokeWidth={1.5}
              dot={false}
              strokeOpacity={0.7}
            />
            <Line
              dataKey="expense"
              name="expense"
              stroke={COLORS.expense}
              strokeWidth={1.5}
              dot={false}
              strokeOpacity={0.7}
            />
            <Line
              dataKey="predicted_income"
              name="predicted_income"
              stroke={COLORS.income}
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
              strokeOpacity={0.7}
            />
            <Line
              dataKey="predicted_expense"
              name="predicted_expense"
              stroke={COLORS.expense}
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
              strokeOpacity={0.7}
            />
          </>
        )}

        <Legend
          wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
          formatter={(value) => {
            const map: Record<string, string> = {
              net: "Historisch (Netto)",
              predicted_net: "Prognose (Netto)",
              income: "Einnahmen",
              expense: "Ausgaben",
              predicted_income: "Progn. Einnahmen",
              predicted_expense: "Progn. Ausgaben",
            };
            return <span style={{ color: "#94a3b8" }}>{map[value] ?? value}</span>;
          }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
