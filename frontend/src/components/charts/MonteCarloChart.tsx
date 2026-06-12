/**
 * Monte Carlo fan chart.
 *
 * Renders 5 area layers (p10–p90) using recharts AreaChart.
 * Each band is filled with a semi-transparent gradient.
 * The p50 (median) line is drawn solid.
 */
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { formatCHF } from "@/lib/theme";
import { useThemeColors } from "@/hooks/useThemeColors";

interface ProjectionData {
  years: number[];
  p10: number[];
  p25: number[];
  p50: number[];
  p75: number[];
  p90: number[];
}

interface MonteCarloChartProps {
  data: ProjectionData;
  height?: number;
  showRetirementLine?: boolean;
  retirementYear?: number;
}

interface ChartRow {
  year: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  // recharts stacked areas need incremental deltas
  band_10_25: number;  // p25 - p10
  band_25_50: number;  // p50 - p25
  band_50_75: number;  // p75 - p50
  band_75_90: number;  // p90 - p75
}

function buildChartData(data: ProjectionData): ChartRow[] {
  return data.years.map((year, i) => ({
    year,
    p10: Math.round(data.p10[i] / 1000),
    p25: Math.round(data.p25[i] / 1000),
    p50: Math.round(data.p50[i] / 1000),
    p75: Math.round(data.p75[i] / 1000),
    p90: Math.round(data.p90[i] / 1000),
    band_10_25: Math.round((data.p25[i] - data.p10[i]) / 1000),
    band_25_50: Math.round((data.p50[i] - data.p25[i]) / 1000),
    band_50_75: Math.round((data.p75[i] - data.p50[i]) / 1000),
    band_75_90: Math.round((data.p90[i] - data.p75[i]) / 1000),
  }));
}

function CustomTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; payload: ChartRow }>;
  label?: string;
}) {
  const { colors } = useThemeColors();
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div
      style={{
        backgroundColor: colors.bgElevated,
        border: `1px solid ${colors.border}`,
        borderRadius: 6,
        color: colors.textPrimary,
        fontSize: 12,
        padding: "8px 12px",
      }}
    >
      <p className="font-semibold mb-1">{label}</p>
      <div className="space-y-0.5 text-xs font-mono">
        <p style={{ color: colors.textSecondary }}>p90: {formatCHF(row.p90 * 1000, true)}</p>
        <p style={{ color: colors.textSecondary }}>p75: {formatCHF(row.p75 * 1000, true)}</p>
        <p style={{ color: colors.accent }}>p50: <strong>{formatCHF(row.p50 * 1000, true)}</strong></p>
        <p style={{ color: colors.textSecondary }}>p25: {formatCHF(row.p25 * 1000, true)}</p>
        <p style={{ color: colors.textSecondary }}>p10: {formatCHF(row.p10 * 1000, true)}</p>
      </div>
    </div>
  );
}

export default function MonteCarloChart({
  data,
  height = 320,
  showRetirementLine = false,
  retirementYear,
}: MonteCarloChartProps) {
  const { colors } = useThemeColors();
  if (!data?.years?.length) {
    return (
      <div style={{ height }} className="flex items-center justify-center text-text-tertiary text-sm">
        Keine Daten verfügbar
      </div>
    );
  }

  const chartData = buildChartData(data);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
        <defs>
          {/* Gradient for each band */}
          <linearGradient id="mc-grad-outer" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={colors.accent} stopOpacity={0.06} />
            <stop offset="95%" stopColor={colors.accent} stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="mc-grad-mid" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={colors.accent} stopOpacity={0.12} />
            <stop offset="95%" stopColor={colors.accent} stopOpacity={0.04} />
          </linearGradient>
          <linearGradient id="mc-grad-inner" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={colors.accent} stopOpacity={0.2} />
            <stop offset="95%" stopColor={colors.accent} stopOpacity={0.06} />
          </linearGradient>
        </defs>

        <CartesianGrid strokeDasharray="3 3" stroke={colors.borderSubtle} vertical={false} />
        <XAxis
          dataKey="year"
          tick={{ fill: colors.textTertiary, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={{ fill: colors.textTertiary, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v) => `${v}k`}
          width={52}
        />
        <Tooltip content={<CustomTooltip />} />

        {/* Retirement line */}
        {showRetirementLine && retirementYear && (
          <ReferenceLine
            x={retirementYear}
            stroke={colors.warning}
            strokeDasharray="4 4"
            strokeWidth={1.5}
            label={{ value: "Rente", fill: colors.warning, fontSize: 10, position: "top" }}
          />
        )}

        {/* Stacked band areas — from bottom p10 up */}
        {/* Base: p10 (invisible fill, just positions the stack) */}
        <Area
          type="monotone"
          dataKey="p10"
          stroke="none"
          fill="transparent"
          stackId="mc"
          legendType="none"
          dot={false}
          activeDot={false}
          isAnimationActive={false}
        />
        {/* Band p10→p25 */}
        <Area
          type="monotone"
          dataKey="band_10_25"
          stroke="none"
          fill="url(#mc-grad-outer)"
          stackId="mc"
          legendType="none"
          dot={false}
          activeDot={false}
          isAnimationActive={false}
        />
        {/* Band p25→p50 */}
        <Area
          type="monotone"
          dataKey="band_25_50"
          stroke="none"
          fill="url(#mc-grad-mid)"
          stackId="mc"
          legendType="none"
          dot={false}
          activeDot={false}
          isAnimationActive={false}
        />
        {/* Band p50→p75 */}
        <Area
          type="monotone"
          dataKey="band_50_75"
          stroke="none"
          fill="url(#mc-grad-mid)"
          stackId="mc"
          legendType="none"
          dot={false}
          activeDot={false}
          isAnimationActive={false}
        />
        {/* Band p75→p90 */}
        <Area
          type="monotone"
          dataKey="band_75_90"
          stroke="none"
          fill="url(#mc-grad-outer)"
          stackId="mc"
          legendType="none"
          dot={false}
          activeDot={false}
          isAnimationActive={false}
        />

        {/* Median line — drawn on top (non-stacked) */}
        <Area
          type="monotone"
          dataKey="p50"
          stroke={colors.accent}
          strokeWidth={2.5}
          fill="transparent"
          dot={false}
          activeDot={{ r: 4, fill: colors.accent, stroke: colors.bgSurface, strokeWidth: 2 }}
          name="Median (p50)"
          isAnimationActive={true}
          animationDuration={600}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
