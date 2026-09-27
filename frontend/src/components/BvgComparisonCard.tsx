import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { BvgComparison, BvgVariant } from "@/lib/api";
import { formatCHF } from "@/lib/theme";
import { useThemeColors } from "@/hooks/useThemeColors";

const VARIANT_COLORS: Record<BvgVariant["key"], string> = {
  pension: "#a78bfa", // wie die BVG-Rente
  capital: "#10b981",
  own: "#f59e0b",
};

/**
 * Pensionskasse ganz als Rente, ganz als Kapital (weiter angelegt) und der
 * eigene Plan: freies Vermoegen im Median (optional im schlechten Fall, 10 %),
 * dazu Kennzahlen. Gerechnet mit denselben Maerkten fuer alle Varianten
 * (POST /projections/compare-bvg), in heutigen Franken.
 */
export default function BvgComparisonCard({ data }: { data: BvgComparison }) {
  const { t } = useTranslation();
  const { colors } = useThemeColors();
  const [showBad, setShowBad] = useState(false);
  const age0 = data.current_age ?? 0;

  const chart = data.years.map((year, i) => {
    const row: Record<string, number> = { year, age: age0 + i };
    for (const v of data.variants) {
      row[v.key] = Math.round(v.p50[i] / 1000);
      row[`${v.key}_p10`] = Math.round(v.p10[i] / 1000);
    }
    return row;
  });
  const fmt = (v: number | null) => (v == null ? "–" : formatCHF(v));
  const rows: { label: string; value: (v: BvgVariant) => string }[] = [
    { label: t("pages:bvgCompare.rowPension"), value: (v) => formatCHF(v.bvg_monthly) },
    { label: t("pages:bvgCompare.rowCapital"), value: (v) => formatCHF(v.capital_net) },
    { label: t("pages:bvgCompare.rowWealth85"), value: (v) => fmt(v.wealth_85) },
    { label: t("pages:bvgCompare.rowWealth85Bad"), value: (v) => fmt(v.wealth_85_p10) },
    { label: t("pages:bvgCompare.rowWealth90"), value: (v) => fmt(v.wealth_90) },
    {
      label: t("pages:bvgCompare.rowLasts"),
      value: (v) => (v.depletion_age != null ? t("pages:ui.untilAge", { age: v.depletion_age }) : t("pages:bvgCompare.lastsAll")),
    },
    { label: t("pages:bvgCompare.rowSuccess"), value: (v) => `${Math.round(v.success_rate * 100)} %` },
    { label: t("pages:bvgCompare.rowTaxes"), value: (v) => formatCHF(v.taxes_total) },
  ];
  const axis = { fill: colors.textTertiary, fontSize: 11 };

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="text-text-primary font-semibold text-sm">{t("pages:bvgCompare.title")}</h2>
        <p className="text-text-tertiary text-xs mt-0.5">{t("pages:bvgCompare.subtitle")}</p>
      </div>

      <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
        <input type="checkbox" checked={showBad} onChange={(e) => setShowBad(e.target.checked)} className="accent-accent" />
        {t("pages:bvgCompare.showBad")}
      </label>

      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={chart} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={colors.borderSubtle} vertical={false} />
          <XAxis dataKey="age" tick={axis} axisLine={false} tickLine={false} />
          <YAxis tick={axis} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}k`} />
          <Tooltip
            contentStyle={{ backgroundColor: colors.bgElevated, border: `1px solid ${colors.border}`, borderRadius: "6px", color: colors.textPrimary, fontSize: 12 }}
            labelFormatter={(age) => t("pages:bvgCompare.atAge", { age })}
            formatter={(v: number) => formatCHF(v * 1000)}
          />
          <Legend wrapperStyle={{ fontSize: 11, color: colors.textSecondary }} />
          {data.variants.map((v) => (
            <Line key={v.key} type="monotone" dataKey={v.key} name={t(`pages:bvgCompare.${v.key}`)}
              stroke={VARIANT_COLORS[v.key]} strokeWidth={2.5} dot={false} />
          ))}
          {showBad && data.variants.map((v) => (
            <Line key={`${v.key}_p10`} type="monotone" dataKey={`${v.key}_p10`}
              name={`${t(`pages:bvgCompare.${v.key}`)} (10 %)`}
              stroke={VARIANT_COLORS[v.key]} strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>

      <p className="text-text-secondary text-xs">
        {data.breakeven_age != null
          ? t("pages:bvgCompare.breakeven", { age: data.breakeven_age })
          : t("pages:bvgCompare.noBreakeven", { age: age0 + data.years.length - 1 })}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-text-tertiary text-left">
              <th className="py-1 pr-3 font-medium" />
              {data.variants.map((v) => (
                <th key={v.key} className="py-1 pr-3 font-medium text-right" style={{ color: VARIANT_COLORS[v.key] }}>
                  {t(`pages:bvgCompare.${v.key}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="font-mono">
            {rows.map((row) => (
              <tr key={row.label} className="border-t border-border/30">
                <td className="py-1 pr-3 font-sans text-text-secondary">{row.label}</td>
                {data.variants.map((v) => (
                  <td key={v.key} className="py-1 pr-3 text-right text-text-primary">{row.value(v)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-text-tertiary text-[11px] leading-relaxed max-w-3xl">{t("pages:bvgCompare.explain")}</p>
    </div>
  );
}
