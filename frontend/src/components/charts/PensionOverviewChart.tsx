import { clsx } from "clsx";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Area, Bar, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import type { ProjectionResult } from "@/lib/api";
import { formatCHF } from "@/lib/theme";
import { useThemeColors } from "@/hooks/useThemeColors";

export const PILLAR_COLORS = {
  ahv: "#38bdf8",  // Säule 1 — sky
  bvg: "#a78bfa",  // Säule 2 — violet
  "3a": "#10b981", // Säule 3a — emerald
  "3b": "#f59e0b", // Säule 3b — amber
} as const;

type View = "capital" | "income";

/**
 * Vorsorge in zwei Ansichten, damit Kapital und Rente nicht auf derselben
 * Achse landen (frueher fiel die Kurve bei der Pensionierung vom Guthaben auf
 * die Jahresrente):
 *  - Kapital: Pensionskasse bis zum Endbezug, 3a und 3b bis zum Bezug, dazu
 *    optional das freie Vermoegen (Median der Simulation) — dorthin fliessen
 *    die Kapitalbezuege und werden weiter angelegt.
 *  - Einkommen: ab der Pensionierung AHV und Pensionskassen-Rente pro Monat,
 *    der Rest der Lebenskosten aus dem Vermoegen, solange es reicht. Die Linie
 *    "verfuegbar" = Renten + gleichmaessiger Kapitalverzehr bis 90: was man
 *    ausgeben koennte, im Vergleich zu dem, was man ausgibt.
 * Alles in heutigen Franken; die Reihen rechnet das Backend.
 */
export default function PensionOverviewChart({
  projection,
  retirementIdx,
}: {
  projection: ProjectionResult;
  retirementIdx: number | null;
}) {
  const { t } = useTranslation();
  const { colors } = useThemeColors();
  const [view, setView] = useState<View>("capital");
  const [showWealth, setShowWealth] = useState(true);

  const k = (v?: number) => Math.round((v ?? 0) / 1000);
  const capitalData = projection.years.map((year, i) => ({
    year,
    bvg: k(projection.capital_bvg?.[i]),
    "3a": k(projection.pension_3a[i]),
    "3b": k(projection.pension_3b[i]),
    wealth: k(projection.p50[i]),
  }));

  const spending = (projection.retirement_spending ?? 0) / 12;
  const start = retirementIdx ?? projection.years.length;
  const incomeData = projection.years.slice(start).map((year, j) => {
    const i = start + j;
    const ahv = (projection.pension_ahv[i] ?? 0) / 12;
    const bvg = (projection.income_bvg?.[i] ?? 0) / 12;
    const rest = Math.max(0, spending - ahv - bvg);
    const drawdown = (projection.capital_drawdown?.[i] ?? 0) / 12;
    // Ist das Vermoegen im Median aufgebraucht, bleibt der Rest eine Luecke
    const funded = (projection.p50[i] ?? 0) > 0;
    return {
      year,
      ahv: Math.round(ahv),
      bvg: Math.round(bvg),
      wealth: funded ? Math.round(rest) : 0,
      gap: funded ? 0 : Math.round(rest),
      available: Math.round(ahv + bvg + drawdown),
    };
  });

  const retirementYear = retirementIdx != null ? projection.years[retirementIdx] : undefined;
  const axis = { fill: colors.textTertiary, fontSize: 11 };
  const tooltipStyle = {
    backgroundColor: colors.bgElevated,
    border: `1px solid ${colors.border}`,
    borderRadius: "6px",
    color: colors.textPrimary,
    fontSize: 12,
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          {(["capital", "income"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={clsx("toggle-btn", view === v && "active")}
            >
              {t(v === "capital" ? "pages:overview.viewCapital" : "pages:overview.viewIncome")}
            </button>
          ))}
        </div>
        {view === "capital" && (
          <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={showWealth}
              onChange={(e) => setShowWealth(e.target.checked)}
              className="accent-accent"
            />
            {t("pages:overview.showWealth")}
          </label>
        )}
      </div>

      <ResponsiveContainer width="100%" height={300}>
        {view === "capital" ? (
          <ComposedChart data={capitalData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={colors.borderSubtle} vertical={false} />
            <XAxis dataKey="year" tick={axis} axisLine={false} tickLine={false} />
            <YAxis tick={axis} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}k`} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => formatCHF(v * 1000)} />
            <Legend iconType="line" wrapperStyle={{ fontSize: 11, color: colors.textSecondary }} />
            {/* Stufen: ein Bezug ist ein Ereignis in einem Jahr, kein Verlauf */}
            <Area type="stepAfter" dataKey="bvg" stackId="cap" name={t("pages:overview.bvgCapital")}
              stroke={PILLAR_COLORS.bvg} fill={PILLAR_COLORS.bvg} fillOpacity={0.25} />
            <Area type="stepAfter" dataKey="3a" stackId="cap" name={t("pages:overview.p3a")}
              stroke={PILLAR_COLORS["3a"]} fill={PILLAR_COLORS["3a"]} fillOpacity={0.25} />
            <Area type="stepAfter" dataKey="3b" stackId="cap" name={t("pages:overview.p3b")}
              stroke={PILLAR_COLORS["3b"]} fill={PILLAR_COLORS["3b"]} fillOpacity={0.25} />
            {showWealth && (
              <Line type="monotone" dataKey="wealth" name={t("pages:overview.wealth")}
                stroke={colors.accent} strokeWidth={2.5} dot={false} />
            )}
            {retirementYear != null && (
              <ReferenceLine x={retirementYear} stroke={colors.textTertiary} strokeDasharray="4 3"
                label={{ value: t("pages:overview.retirement"), position: "insideTopLeft", fill: colors.textTertiary, fontSize: 10 }} />
            )}
          </ComposedChart>
        ) : (
          <ComposedChart data={incomeData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={colors.borderSubtle} vertical={false} />
            <XAxis dataKey="year" tick={axis} axisLine={false} tickLine={false} />
            <YAxis tick={axis} axisLine={false} tickLine={false} width={48} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => `${formatCHF(v)} / Mt.`} />
            <Legend wrapperStyle={{ fontSize: 11, color: colors.textSecondary }} />
            <Bar dataKey="ahv" stackId="inc" name={t("pages:overview.ahv")} fill={PILLAR_COLORS.ahv} />
            <Bar dataKey="bvg" stackId="inc" name={t("pages:overview.bvgPension")} fill={PILLAR_COLORS.bvg} />
            <Bar dataKey="wealth" stackId="inc" name={t("pages:overview.fromWealth")} fill={colors.accent} fillOpacity={0.5} />
            <Bar dataKey="gap" stackId="inc" name={t("pages:overview.gap")} fill={colors.loss} fillOpacity={0.6} />
            <Line type="monotone" dataKey="available" stroke={colors.gain} strokeWidth={2.5} dot={false}
              name={t("pages:overview.available", { age: projection.drawdown_until_age ?? 90 })} />
            <ReferenceLine y={Math.round(spending)} stroke={colors.loss} strokeDasharray="4 3"
              label={{ value: t("pages:overview.spending"), position: "insideTopRight", fill: colors.loss, fontSize: 10 }} />
          </ComposedChart>
        )}
      </ResponsiveContainer>
      <p className="text-text-tertiary text-[11px] leading-relaxed max-w-3xl">
        {t(view === "capital" ? "pages:overview.capitalHint" : "pages:overview.incomeHint")}
      </p>
    </div>
  );
}
