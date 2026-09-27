import { clsx } from "clsx";
import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Area, AreaChart, Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { projectionsApi } from "@/lib/api";
import { formatCHF } from "@/lib/theme";
import { useThemeColors } from "@/hooks/useThemeColors";
import { PILLAR_COLORS } from "@/components/charts/PensionOverviewChart";

const FUND_COLOR = "#22d3ee";
const UNTIL = [85, 90, 95, 0] as const; // 0 = nur Ertrag

/**
 * Einkommensplan: ab einem frei gewaehlten Rentenalter AHV, Pensionskassen-Rente
 * und die Auszahlung aus einem Fonds (Kapitalbezuege, Lebensversicherung,
 * optional das freie Vermoegen) pro Monat, netto nach Steuern. Die Rechnung
 * macht POST /projections/income-plan.
 */
export default function IncomePlanCard({
  body,
  scenarioId,
  defaultAge,
}: {
  body: Record<string, unknown>;
  scenarioId: number | null;
  defaultAge: number;
}) {
  const { t } = useTranslation();
  const { colors } = useThemeColors();
  const [age, setAge] = useState<number | null>(null);
  const [fundReturn, setFundReturn] = useState(4);
  const [until, setUntil] = useState<(typeof UNTIL)[number]>(90);
  const [indexed, setIndexed] = useState(true);
  const [includeWealth, setIncludeWealth] = useState(true);
  const retirementAge = age ?? defaultAge;

  const { data: plan } = useQuery({
    queryKey: ["income-plan", body, scenarioId, retirementAge, fundReturn, until, indexed, includeWealth],
    queryFn: () =>
      projectionsApi
        .incomePlan(
          {
            ...body,
            retirement_age: retirementAge,
            fund_return: fundReturn / 100,
            payout_until_age: until || null,
            indexed,
            include_wealth: includeWealth,
          },
          scenarioId ?? undefined,
        )
        .then((r) => r.data),
    placeholderData: keepPreviousData,
  });

  const rows = (plan?.rows ?? []).map((r) => ({
    ...r,
    ahv: Math.round(r.ahv),
    bvg: Math.round(r.bvg),
    fund: Math.round(r.fund),
    net: Math.round(r.net),
    balance: Math.round(r.fund_balance / 1000),
  }));
  const at = (a: number) => rows.find((r) => r.age === a);
  const axis = { fill: colors.textTertiary, fontSize: 11 };
  const tooltipStyle = {
    backgroundColor: colors.bgElevated, border: `1px solid ${colors.border}`,
    borderRadius: "6px", color: colors.textPrimary, fontSize: 12,
  };

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="text-text-primary font-semibold text-sm">{t("pages:incomePlan.title")}</h2>
        <p className="text-text-tertiary text-xs mt-0.5">{t("pages:incomePlan.subtitle")}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div>
          <label className="label">{t("pages:incomePlan.age", { age: retirementAge })}</label>
          <input type="range" min={58} max={70} value={retirementAge}
            onChange={(e) => setAge(Number(e.target.value))} className="w-full accent-accent" />
        </div>
        <div>
          <label className="label">{t("pages:incomePlan.return", { pct: fundReturn.toFixed(1) })}</label>
          <input type="range" min={0} max={8} step={0.5} value={fundReturn}
            onChange={(e) => setFundReturn(Number(e.target.value))} className="w-full accent-accent" />
        </div>
        <div>
          <label className="label">{t("pages:incomePlan.until")}</label>
          <div className="flex gap-1 flex-wrap">
            {UNTIL.map((u) => (
              <button key={u} type="button" onClick={() => setUntil(u)} className={clsx("toggle-btn", until === u && "active")}>
                {u ? t("pages:incomePlan.untilAge", { age: u }) : t("pages:incomePlan.yieldOnly")}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1.5 text-xs text-text-secondary">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={indexed} onChange={(e) => setIndexed(e.target.checked)} className="accent-accent" />
            {t("pages:incomePlan.indexed")}
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={includeWealth} onChange={(e) => setIncludeWealth(e.target.checked)} className="accent-accent" />
            {t("pages:incomePlan.includeWealth")}
          </label>
        </div>
      </div>

      {plan && (
        <>
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
            {[plan.retirement_age, Math.max(plan.retirement_age, 75), Math.max(plan.retirement_age, 85)]
              .filter((a, i, all) => all.indexOf(a) === i)
              .map((a) => (
                <div key={a} className="bg-bg-elevated rounded-lg px-4 py-3 border border-border/30">
                  <p className="text-text-tertiary text-[11px]">{t("pages:incomePlan.netAt", { age: a })}</p>
                  <p className="font-mono font-bold text-lg text-accent">{formatCHF(at(a)?.net ?? 0)}</p>
                  <p className="text-text-tertiary text-[10px]">{t("pages:incomePlan.perMonth")}</p>
                </div>
              ))}
            <div className="bg-bg-elevated rounded-lg px-4 py-3 border border-border/30">
              <p className="text-text-tertiary text-[11px]">{t("pages:incomePlan.fundCapital")}</p>
              <p className="font-mono font-bold text-lg" style={{ color: FUND_COLOR }}>
                {formatCHF(plan.fund_start + plan.fund_inflows.reduce((s, i) => s + i.amount, 0))}
              </p>
              <p className="text-text-tertiary text-[10px]">{t("pages:incomePlan.fundCapitalHint")}</p>
            </div>
          </div>

          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={colors.borderSubtle} vertical={false} />
              <XAxis dataKey="age" tick={axis} axisLine={false} tickLine={false} />
              <YAxis tick={axis} axisLine={false} tickLine={false} width={52} />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={(a) => t("pages:bvgCompare.atAge", { age: a })}
                formatter={(v: number) => `${formatCHF(v)} / Mt.`} />
              <Legend wrapperStyle={{ fontSize: 11, color: colors.textSecondary }} />
              <Bar dataKey="ahv" stackId="m" name={t("pages:overview.ahv")} fill={PILLAR_COLORS.ahv} />
              <Bar dataKey="bvg" stackId="m" name={t("pages:overview.bvgPension")} fill={PILLAR_COLORS.bvg} />
              <Bar dataKey="fund" stackId="m" name={t("pages:incomePlan.fund")} fill={FUND_COLOR} />
              <Line type="monotone" dataKey="net" name={t("pages:incomePlan.net")} stroke={colors.gain} strokeWidth={2.5} dot={false} />
              <Line type="monotone" dataKey={() => Math.round(plan.spending_monthly)} name={t("pages:overview.spending")}
                stroke={colors.loss} strokeDasharray="4 3" strokeWidth={1.5} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>

          <div>
            <p className="text-text-secondary text-xs font-semibold mb-1">{t("pages:incomePlan.balanceTitle")}</p>
            <ResponsiveContainer width="100%" height={140}>
              <AreaChart data={rows} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={colors.borderSubtle} vertical={false} />
                <XAxis dataKey="age" tick={axis} axisLine={false} tickLine={false} />
                <YAxis tick={axis} axisLine={false} tickLine={false} width={52} tickFormatter={(v) => `${v}k`} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => formatCHF(v * 1000)} />
                <Area type="monotone" dataKey="balance" name={t("pages:incomePlan.balance")}
                  stroke={FUND_COLOR} fill={FUND_COLOR} fillOpacity={0.2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
      <p className="text-text-tertiary text-[11px] leading-relaxed max-w-3xl">{t("pages:incomePlan.hint")}</p>
    </div>
  );
}
