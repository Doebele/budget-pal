import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { projectionsApi, accountsApi } from "@/lib/api";
import { formatCHF, colors } from "@/lib/theme";
import MonteCarloChart from "@/components/charts/MonteCarloChart";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { TrendingUp, RefreshCw, Save } from "lucide-react";

type HorizonKey = "1yr" | "5yr" | "10yr" | "retirement" | "age90";

const HORIZONS: Array<{ key: HorizonKey; label: string; years: number }> = [
  { key: "1yr", label: "1 Jahr", years: 1 },
  { key: "5yr", label: "5 Jahre", years: 5 },
  { key: "10yr", label: "10 Jahre", years: 10 },
  { key: "retirement", label: "Bis Rente", years: 25 },
  { key: "age90", label: "Bis 90", years: 50 },
];

export default function Projections() {
  const [horizon, setHorizon] = useState<HorizonKey>("10yr");
  const [params, setParams] = useState({
    current_net_worth: 100000,
    annual_savings: 24000,
    annual_income: 90000,
    mean_return: 0.07,
    return_volatility: 0.12,
    inflation_rate: 0.015,
    retirement_age: 65,
    include_pension: true,
  });

  const selectedHorizon = HORIZONS.find((h) => h.key === horizon)!;

  const { data: accounts } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => accountsApi.list().then((r) => r.data),
  });

  // Auto-compute net worth from accounts
  const totalBalance = (accounts || []).reduce((sum: number, a: { balance: number }) => sum + a.balance, 0);

  const { data: projection, isLoading, refetch } = useQuery({
    queryKey: ["projection", horizon, params],
    queryFn: () =>
      projectionsApi
        .run({
          ...params,
          current_net_worth: totalBalance || params.current_net_worth,
          years_to_project: selectedHorizon.years,
        })
        .then((r) => r.data),
    enabled: true,
  });

  // Pension chart data
  const pensionChartData = projection?.years?.map((year: number, i: number) => ({
    year,
    ahv: Math.round((projection.pension_ahv?.[i] || 0) / 1000),
    bvg: Math.round((projection.pension_bvg?.[i] || 0) / 1000),
    "3a": Math.round((projection.pension_3a?.[i] || 0) / 1000),
  })) || [];

  const retirementYear = new Date().getFullYear() + (params.retirement_age - 40);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-display text-text-primary">Finanzprognosen</h1>
          <p className="text-text-tertiary text-sm mt-0.5">Monte Carlo Simulation · Schweizer Rente (AHV/BVG/3a)</p>
        </div>
        <button onClick={() => refetch()} className="btn-secondary flex items-center gap-2" disabled={isLoading}>
          <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
          Neu berechnen
        </button>
      </div>

      {/* Horizon selector */}
      <div className="flex gap-2 flex-wrap">
        {HORIZONS.map((h) => (
          <button
            key={h.key}
            onClick={() => setHorizon(h.key)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              horizon === h.key
                ? "bg-accent text-white"
                : "bg-bg-surface2 text-text-secondary hover:text-text-primary border border-border"
            }`}
          >
            {h.label}
          </button>
        ))}
      </div>

      {/* Parameters */}
      <div className="card">
        <h2 className="text-text-primary font-semibold text-sm mb-4">Simulationsparameter</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <label className="label">Aktuelles Nettovermögen</label>
            <input
              type="number"
              className="input"
              value={params.current_net_worth}
              onChange={(e) => setParams((p) => ({ ...p, current_net_worth: +e.target.value }))}
            />
          </div>
          <div>
            <label className="label">Jährliche Ersparnisse</label>
            <input
              type="number"
              className="input"
              value={params.annual_savings}
              onChange={(e) => setParams((p) => ({ ...p, annual_savings: +e.target.value }))}
            />
          </div>
          <div>
            <label className="label">Jahreseinkommen</label>
            <input
              type="number"
              className="input"
              value={params.annual_income}
              onChange={(e) => setParams((p) => ({ ...p, annual_income: +e.target.value }))}
            />
          </div>
          <div>
            <label className="label">Rentenalter</label>
            <input
              type="number"
              className="input"
              value={params.retirement_age}
              onChange={(e) => setParams((p) => ({ ...p, retirement_age: +e.target.value }))}
            />
          </div>
          <div>
            <label className="label">Ø Rendite p.a.</label>
            <input
              type="number"
              step="0.01"
              className="input"
              value={params.mean_return}
              onChange={(e) => setParams((p) => ({ ...p, mean_return: +e.target.value }))}
            />
          </div>
          <div>
            <label className="label">Volatilität (σ)</label>
            <input
              type="number"
              step="0.01"
              className="input"
              value={params.return_volatility}
              onChange={(e) => setParams((p) => ({ ...p, return_volatility: +e.target.value }))}
            />
          </div>
          <div>
            <label className="label">Inflation CHF</label>
            <input
              type="number"
              step="0.001"
              className="input"
              value={params.inflation_rate}
              onChange={(e) => setParams((p) => ({ ...p, inflation_rate: +e.target.value }))}
            />
          </div>
        </div>
      </div>

      {/* Monte Carlo fan chart */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-text-primary font-semibold text-sm">Nettovermögen Prognose</h2>
            <p className="text-text-tertiary text-xs mt-0.5">
              {(10000).toLocaleString()} Monte Carlo Simulationen · Reale CHF (inflationsbereinigt)
            </p>
          </div>
          {projection && (
            <div className="text-right">
              <p className="text-text-tertiary text-xs">Median in {selectedHorizon.years} Jahren</p>
              <p className="text-text-primary font-mono font-semibold text-lg">
                {formatCHF(projection.p50?.[projection.p50.length - 1] || 0, true)}
              </p>
            </div>
          )}
        </div>
        {isLoading ? (
          <div className="h-80 flex items-center justify-center">
            <div className="flex items-center gap-3 text-text-tertiary">
              <RefreshCw className="w-5 h-5 animate-spin" />
              <span className="text-sm">Simulation läuft...</span>
            </div>
          </div>
        ) : projection ? (
          <MonteCarloChart data={projection} height={320} />
        ) : null}
      </div>

      {/* Swiss pension breakdown */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-text-primary font-semibold text-sm">Schweizer Rente (3-Säulen)</h2>
            <p className="text-text-tertiary text-xs mt-0.5">AHV (Säule 1) · BVG/Pensionskasse (Säule 2) · Säule 3a</p>
          </div>
        </div>
        {pensionChartData.length > 0 && (
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={pensionChartData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="ahv-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={colors.accent} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={colors.accent} stopOpacity={0.0} />
                </linearGradient>
                <linearGradient id="bvg-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={colors.gain} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={colors.gain} stopOpacity={0.0} />
                </linearGradient>
                <linearGradient id="p3a-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={colors.purple} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={colors.purple} stopOpacity={0.0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={colors.borderSubtle} vertical={false} />
              <XAxis
                dataKey="year"
                tick={{ fill: colors.textTertiary, fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: colors.textTertiary, fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `${v}k`}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: colors.bgElevated,
                  border: `1px solid ${colors.border}`,
                  borderRadius: "6px",
                  color: colors.textPrimary,
                  fontSize: 12,
                }}
                formatter={(v: number) => [`${formatCHF(v * 1000, true)}`, undefined]}
              />
              <Legend
                iconType="line"
                wrapperStyle={{ fontSize: 11, color: colors.textSecondary }}
              />
              {/* Retirement line */}
              <Area type="monotone" dataKey="ahv" name="AHV (Säule 1)" stroke={colors.accent} fill="url(#ahv-grad)" strokeWidth={2} dot={false} />
              <Area type="monotone" dataKey="bvg" name="BVG (Säule 2)" stroke={colors.gain} fill="url(#bvg-grad)" strokeWidth={2} dot={false} />
              <Area type="monotone" dataKey="3a" name="Säule 3a" stroke={colors.purple} fill="url(#p3a-grad)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}

        {/* Pension summary */}
        <div className="grid grid-cols-3 gap-4 mt-4 pt-4 border-t border-border/50">
          {[
            { label: "AHV (Säule 1)", value: "bis CHF 30'240/Jahr", desc: "Bei 44 Beitragsjahren", color: "text-accent" },
            { label: "BVG (Säule 2)", value: "Kapital × 6.8%", desc: "Umwandlungssatz 2024", color: "text-gain" },
            { label: "Säule 3a", value: `max. CHF 7'056/Jahr`, desc: "Steuerlich abzugsfähig", color: "text-purple" },
          ].map(({ label, value, desc, color }) => (
            <div key={label} className="card-elevated">
              <p className="text-text-tertiary text-xs">{label}</p>
              <p className={`text-sm font-semibold mt-1 font-mono ${color}`}>{value}</p>
              <p className="text-text-tertiary text-xs mt-0.5">{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
