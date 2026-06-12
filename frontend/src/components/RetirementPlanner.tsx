/**
 * RetirementPlanner — scenario simulation for retirement phase.
 *
 * Uses the existing /api/projections/run endpoint (Monte Carlo + AHV/BVG/3a)
 * combined with the /api/forecasting/scenario endpoint for expense-side projections.
 *
 * Shows:
 *   · Wealth accumulation until retirement (Monte Carlo p10/p50/p90)
 *   · Estimated pension income breakdown (AHV + BVG + Pillar 3a)
 *   · Monthly cash-flow simulation post-retirement
 *   · Deficit / surplus indicator
 */
import { clsx } from "clsx";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { ArrowRight, Calendar, Coins, GraphUp, ShieldCheck, WarningTriangle } from "@/lib/icons";
import { projectionsApi, api } from "@/lib/api";
import { formatCHF } from "@/lib/theme";

interface Props {
  /** Current total net worth from accounts */
  currentNetWorth: number;
  /** Monthly savings from forecast baseline */
  monthlyNetMean: number;
  /** User DOB (ISO string) or null */
  dateOfBirth: string | null;
}

const AGES = Array.from({ length: 11 }, (_, i) => 60 + i); // 60–70

// Consistent pillar palette (matches Finanzplan / PILLAR_COLOR)
const PILLAR_COLORS = {
  ahv: "#38bdf8",  // sky   — Säule 1
  bvg: "#a78bfa",  // violet — Säule 2
  "3a": "#10b981", // emerald — Säule 3a
  "3b": "#f59e0b", // amber — Säule 3b
} as const;

export default function RetirementPlanner({ currentNetWorth, monthlyNetMean, dateOfBirth }: Props) {
  const [retirementAge, setRetirementAge] = useState(65);
  const [annualIncome, setAnnualIncome] = useState(90_000);
  const [meanReturn, setMeanReturn] = useState(0.07);

  const annualSavings = monthlyNetMean * 12;
  const yearsToRetirement = dateOfBirth
    ? retirementAge - (new Date().getFullYear() - new Date(dateOfBirth).getFullYear())
    : 25;

  const projectionParams = {
    current_net_worth: currentNetWorth,
    annual_savings: Math.max(annualSavings, 0),
    annual_income: annualIncome,
    years_to_project: Math.max(yearsToRetirement + 25, 30), // through age 90
    mean_return: meanReturn,
    return_volatility: 0.12,
    inflation_rate: 0.015,
    retirement_age: retirementAge,
    include_pension: true,
    date_of_birth: dateOfBirth ?? undefined,
  };

  const { data: projection, isLoading } = useQuery({
    queryKey: ["retirement-projection", projectionParams],
    queryFn: () => projectionsApi.run(projectionParams).then((r) => r.data),
    staleTime: 5 * 60_000,
  });

  // Retirement index — prefer server-computed value so frontend/backend agree.
  const serverRetIdx = typeof projection?.retirement_idx === "number" ? projection.retirement_idx : null;
  const retirementIdx = serverRetIdx !== null
    ? serverRetIdx
    : (yearsToRetirement > 0 ? Math.min(yearsToRetirement, (projection?.years?.length ?? 0) - 1) : 0);
  const wealthAtRetirement = projection?.p50?.[retirementIdx] ?? 0;

  // Post-retirement: monthly pension income (backend returns annual CHF, real terms).
  const ahvMonthly       = (projection?.pension_ahv?.[retirementIdx] ?? 0) / 12;
  const bvgMonthly       = (projection?.pension_bvg?.[retirementIdx] ?? 0) / 12;
  const pillar3aMonthly  = (projection?.pension_3a?.[retirementIdx] ?? 0) / 12;
  const pillar3bMonthly  = (projection?.pension_3b?.[retirementIdx] ?? 0) / 12;
  const totalPensionMonthly = ahvMonthly + bvgMonthly + pillar3aMonthly + pillar3bMonthly;

  // Estimate monthly expenses at retirement (rough: 80 % of current)
  const estimatedExpenseMonthly = Math.abs(monthlyNetMean) * 0.8 + (annualIncome / 12) * 0.5;
  const monthlyDeficitOrSurplus = totalPensionMonthly - estimatedExpenseMonthly;
  const isSurplus = monthlyDeficitOrSurplus >= 0;

  // Chart data: net worth over time
  const netWorthData = projection?.years?.map((yr: number, i: number) => ({
    year: yr,
    p10: Math.round((projection.p10?.[i] ?? 0) / 1000),
    p50: Math.round((projection.p50?.[i] ?? 0) / 1000),
    p90: Math.round((projection.p90?.[i] ?? 0) / 1000),
    isRetirement: i === retirementIdx,
  })) ?? [];

  // Chart data: pension income breakdown (per year, post retirement only)
  const pensionBarData = projection?.years
    ?.slice(retirementIdx, retirementIdx + 20)
    ?.map((yr: number, i: number) => ({
      year: yr,
      ahv:  Math.round((projection.pension_ahv?.[retirementIdx + i] ?? 0) / 12),
      bvg:  Math.round((projection.pension_bvg?.[retirementIdx + i] ?? 0) / 12),
      "3a": Math.round((projection.pension_3a?.[retirementIdx + i] ?? 0) / 12),
      "3b": Math.round((projection.pension_3b?.[retirementIdx + i] ?? 0) / 12),
    })) ?? [];

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="card">
        <h3 className="text-text-primary font-semibold text-sm mb-4 flex items-center gap-2">
          <Calendar className="w-4 h-4 text-accent" />
          Rentenparameter
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="text-text-tertiary text-xs mb-1 block">Rentenalter</label>
            <div className="flex gap-1 flex-wrap">
              {AGES.map((age) => (
                <button
                  key={age}
                  onClick={() => setRetirementAge(age)}
                  className={clsx("toggle-btn", retirementAge === age && "active")}
                >
                  {age}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-text-tertiary text-xs mb-1 block">
              Jahreseinkommen (CHF)
            </label>
            <input
              type="number"
              value={annualIncome}
              onChange={(e) => setAnnualIncome(Number(e.target.value))}
              step={5000}
              className="input-field w-full"
            />
          </div>

          <div>
            <label className="text-text-tertiary text-xs mb-1 block">
              Ø-Rendite ({(meanReturn * 100).toFixed(1)}%)
            </label>
            <input
              type="range"
              min={0.02}
              max={0.12}
              step={0.005}
              value={meanReturn}
              onChange={(e) => setMeanReturn(Number(e.target.value))}
              className="w-full accent-accent"
            />
            <div className="flex justify-between text-[10px] text-text-tertiary mt-0.5">
              <span>2% (konservativ)</span>
              <span>12% (aggressiv)</span>
            </div>
          </div>
        </div>
      </div>

      {/* Summary KPIs — style matches Finanzplan cashflow cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard
          label="Vermögen bei Rente"
          value={formatCHF(wealthAtRetirement)}
          sub={`in ${Math.max(yearsToRetirement, 0)} Jahren`}
          icon={<GraphUp className="w-4 h-4" style={{ color: "#10b981" }} />}
          valueColor="#10b981"
        />
        <KPICard
          label="Rente/Monat"
          value={formatCHF(totalPensionMonthly)}
          sub="AHV + BVG + 3a + 3b"
          icon={<Coins className="w-4 h-4" style={{ color: PILLAR_COLORS.bvg }} />}
          valueColor={PILLAR_COLORS.bvg}
        />
        <KPICard
          label={isSurplus ? "Überschuss/Monat" : "Lücke/Monat"}
          value={formatCHF(Math.abs(monthlyDeficitOrSurplus))}
          sub={isSurplus ? "nach Ausgaben" : "Deckungslücke"}
          icon={
            isSurplus
              ? <ShieldCheck className="w-4 h-4 text-gain" />
              : <WarningTriangle className="w-4 h-4 text-loss" />
          }
          valueColor={isSurplus ? "#10b981" : "#f87171"}
        />
        <KPICard
          label="Säulen-Struktur"
          value={`${Math.round((ahvMonthly / (totalPensionMonthly || 1)) * 100)}% AHV`}
          sub={`${Math.round((bvgMonthly / (totalPensionMonthly || 1)) * 100)}% BVG · ${Math.round((pillar3aMonthly / (totalPensionMonthly || 1)) * 100)}% 3a · ${Math.round((pillar3bMonthly / (totalPensionMonthly || 1)) * 100)}% 3b`}
          icon={<ShieldCheck className="w-4 h-4" style={{ color: PILLAR_COLORS.ahv }} />}
          valueColor={PILLAR_COLORS.ahv}
        />
      </div>

      {/* Pension income breakdown (post retirement) */}
      {pensionBarData.length > 0 && (
        <div className="card">
          <h3 className="text-text-primary font-semibold text-sm mb-4 flex items-center gap-2">
            <ArrowRight className="w-4 h-4 text-accent" />
            Monatliche Rente nach Säule (CHF, real)
          </h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={pensionBarData} margin={{ top: 8, right: 16, bottom: 0, left: 16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
              <XAxis dataKey="year" tick={{ fill: "#94a3b8", fontSize: 10 }} axisLine={{ stroke: "#334155" }} tickLine={false} interval={3} />
              <YAxis tickFormatter={(v) => `${v}`} tick={{ fill: "#94a3b8", fontSize: 10 }} axisLine={false} tickLine={false} width={40} />
              <Tooltip
                contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8 }}
                formatter={(v: number) => [formatCHF(v), ""]}
              />
              <Bar dataKey="ahv" name="AHV (Säule 1)" stackId="a" fill={PILLAR_COLORS.ahv} radius={[0, 0, 0, 0]} />
              <Bar dataKey="bvg" name="BVG (Säule 2)" stackId="a" fill={PILLAR_COLORS.bvg} />
              <Bar dataKey="3a" name="Säule 3a" stackId="a" fill={PILLAR_COLORS["3a"]} />
              <Bar dataKey="3b" name="Säule 3b" stackId="a" fill={PILLAR_COLORS["3b"]} radius={[4, 4, 0, 0]} />
              <ReferenceLine
                y={estimatedExpenseMonthly}
                stroke="#f87171"
                strokeDasharray="4 3"
                label={{ value: "Ausgaben", position: "right", fill: "#f87171", fontSize: 10 }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} formatter={(v) => <span style={{ color: "#94a3b8" }}>{v}</span>} />
            </BarChart>
          </ResponsiveContainer>
          <p className="text-text-tertiary text-[11px] mt-2">
            Rote Linie = geschätzte monatliche Ausgaben im Ruhestand (80 % des aktuellen Niveaus)
          </p>
        </div>
      )}

      {/* Wealth Monte Carlo */}
      <div className="card">
        <h3 className="text-text-primary font-semibold text-sm mb-4">
          Vermögensentwicklung (Monte Carlo — p10 / p50 / p90)
        </h3>
        {isLoading ? (
          <div className="h-56 flex items-center justify-center text-text-tertiary text-sm animate-pulse">
            Berechne…
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={netWorthData} margin={{ top: 8, right: 16, bottom: 0, left: 16 }}>
              <defs>
                <linearGradient id="wealthGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
              <XAxis dataKey="year" tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={{ stroke: "#334155" }} tickLine={false} />
              <YAxis tickFormatter={(v) => `${v}k`} tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
              <Tooltip
                contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8 }}
                labelStyle={{ color: "#f1f5f9" }}
                formatter={(v: number) => [`CHF ${v}k`, ""]}
              />
              <ReferenceLine
                x={projection?.years?.[retirementIdx]}
                stroke="#f59e0b"
                strokeDasharray="4 3"
                label={{ value: "Rente", position: "top", fill: "#f59e0b", fontSize: 10 }}
              />
              <Area type="monotone" dataKey="p90" stroke="#60a5fa" fill="url(#wealthGrad)" strokeWidth={1} name="p90 (optimistisch)" />
              <Area type="monotone" dataKey="p50" stroke="#3b82f6" fill="none" strokeWidth={2} name="p50 (Median)" />
              <Area type="monotone" dataKey="p10" stroke="#1d4ed8" fill="none" strokeWidth={1} strokeDasharray="3 3" name="p10 (pessimistisch)" />
              <Legend wrapperStyle={{ fontSize: 11 }} formatter={(v) => <span style={{ color: "#94a3b8" }}>{v}</span>} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

// ── KPI card helper ───────────────────────────────────────────

function KPICard({
  label,
  value,
  sub,
  icon,
  valueColor,
}: {
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
  valueColor?: string;
}) {
  return (
    <div className="bg-bg-surface2 rounded-xl border border-border/40 px-4 py-3">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <p className="text-text-tertiary text-[11px] uppercase tracking-widest font-semibold">
          {label}
        </p>
      </div>
      <p
        className="font-mono font-bold text-xl"
        style={valueColor ? { color: valueColor } : undefined}
      >
        {value}
      </p>
      <p className="text-text-tertiary text-xs mt-1">{sub}</p>
    </div>
  );
}
