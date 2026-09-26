import { clsx } from "clsx";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { projectionsApi, accountsApi } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCHF } from "@/lib/theme";
import MonteCarloChart from "@/components/charts/MonteCarloChart";
import WithdrawalPlan from "@/components/WithdrawalPlan";
import PensionOverviewChart, { PILLAR_COLORS } from "@/components/charts/PensionOverviewChart";
import { Refresh } from "@/lib/icons";
import { useTranslation } from "react-i18next";

/** Match backend `projection._project_pensions` fallback age when DOB is missing. */
function currentAgeFromProfileBirth(iso: string | undefined): number {
  if (!iso) return 40;
  const normalized = iso.includes("T") ? iso : `${iso}T12:00:00`;
  const dob = new Date(normalized);
  if (Number.isNaN(dob.getTime())) return 40;
  const days = (Date.now() - dob.getTime()) / (1000 * 60 * 60 * 24);
  return Math.floor(days / 365.25);
}

interface ScenarioSummary {
  id: number;
  name: string;
  parameters?: Record<string, unknown> & { wizard_onboarding?: boolean };
}

type HorizonKey = "1yr" | "5yr" | "10yr" | "retirement" | "age90";

const HORIZONS: Array<{ key: HorizonKey; label: string; years: number }> = [
  { key: "1yr", label: "pages:ui.1_jahr", years: 1 },
  { key: "5yr", label: "pages:ui.5_jahre", years: 5 },
  { key: "10yr", label: "pages:ui.10_jahre", years: 10 },
  { key: "retirement", label: "pages:ui.bis_rente", years: 25 },
  { key: "age90", label: "pages:ui.bis_90", years: 50 },
];

export default function Projections() {
  const { t } = useTranslation();
  const { user } = useAuth();
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

  // Lebenskosten im Ruhestand pro Monat; null = aus Szenario bzw. geschaetzt
  const [spendingMonthly, setSpendingMonthly] = useState<number | null>(null);


  const profileBirthIso = user?.birthdate ?? user?.date_of_birth?.slice(0, 10) ?? undefined;
  const currentAge = useMemo(() => currentAgeFromProfileBirth(profileBirthIso), [profileBirthIso]);
  const yearsToRetirement = Math.max(0, params.retirement_age - currentAge);
  const retirementYear = new Date().getFullYear() + yearsToRetirement;
  // "Bis Rente" und "Bis 90" haengen vom Alter ab — fest 25/50 Jahre liefen
  // sonst bis 108
  const baseHorizon = HORIZONS.find((h) => h.key === horizon)!;
  const selectedHorizon = {
    ...baseHorizon,
    years:
      horizon === "retirement" ? Math.max(1, yearsToRetirement)
      : horizon === "age90" ? Math.max(1, 90 - currentAge)
      : baseHorizon.years,
  };

  const { data: accounts } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => accountsApi.list().then((r) => r.data),
  });

  // Gespeicherte Szenarien. Vorausgewaehlt wird der Finanzplan aus dem Wizard,
  // damit die Seite die echten Zahlen des Nutzers zeigt statt der Defaults oben.
  const { data: scenarios = [] } = useQuery<ScenarioSummary[]>({
    queryKey: ["projection-scenarios"],
    queryFn: () => projectionsApi.listScenarios().then((r) => r.data),
  });
  const [scenarioId, setScenarioId] = useState<number | null>(null);
  const [scenarioTouched, setScenarioTouched] = useState(false);
  useEffect(() => {
    if (scenarioTouched || scenarioId !== null || scenarios.length === 0) return;
    const wizard = scenarios.find((sc) => sc.parameters?.wizard_onboarding);
    setScenarioId((wizard ?? scenarios[0]).id);
  }, [scenarios, scenarioId, scenarioTouched]);

  // Auto-compute net worth from accounts
  const totalBalance = (accounts || []).reduce((sum: number, a: { balance: number }) => sum + a.balance, 0);

  const { data: projection, isLoading, refetch } = useQuery({
    queryKey: ["projection", horizon, selectedHorizon.years, params, profileBirthIso, totalBalance, scenarioId, spendingMonthly],
    queryFn: () => {
      // Bei gewaehltem Szenario Sparrate und Einkommen NICHT mitsenden — der
      // Server fuellt nur ungesetzte Felder aus parameters_json (exclude_unset).
      // Das Nettovermoegen kommt weiterhin aus den Konten.
      const { annual_savings, annual_income, ...rest } = params;
      const body = scenarioId ? rest : { ...rest, annual_savings, annual_income };
      return projectionsApi
        .run(
          {
            ...body,
            current_net_worth: totalBalance || params.current_net_worth,
            years_to_project: selectedHorizon.years,
            date_of_birth: profileBirthIso,
            ...(spendingMonthly != null ? { retirement_spending: spendingMonthly * 12 } : {}),
          },
          scenarioId ?? undefined,
        )
        .then((r) => r.data);
    },
    enabled: true,
  });

  // Das Szenario kann ein frueheres Rentenalter setzen — dann gilt das des Servers
  const serverRetIdx = projection?.retirement_idx ?? yearsToRetirement;
  const retirementInHorizon = serverRetIdx <= selectedHorizon.years;
  const retIdx = retirementInHorizon ? serverRetIdx : null;
  // Jede Saeule bei ihrem Bezugsbeginn lesen (AHV ab 63, BVG ab 58): davor
  // steht in der Reihe das Kapital, keine Rente. 3a und 3b zahlen keine
  // Rente — sie werden als Kapital bezogen (Bezugsplan).
  const pensionAt = (series: number[] | undefined, pillar: "1" | "2") => {
    if (retIdx == null || !series) return 0;
    const idx = Math.max(retIdx, projection?.payout_start_idx?.[pillar] ?? retIdx);
    return series[Math.min(idx, series.length - 1)] ?? 0;
  };
  const ahvAtRet = pensionAt(projection?.pension_ahv, "1");
  const bvgAtRet = pensionAt(projection?.pension_bvg, "2");
  const totalPensionAnnual = ahvAtRet + bvgAtRet;
  // Dazu der gleichmaessige Kapitalverzehr im selben Jahr (wenn alle Renten fliessen)
  const drawdownAtRet = (() => {
    if (retIdx == null || !projection) return 0;
    const starts = projection.payout_start_idx ?? { "1": retIdx, "2": retIdx };
    const idx = Math.min(Math.max(retIdx, starts["1"], starts["2"]), projection.years.length - 1);
    return projection.capital_drawdown?.[idx] ?? 0;
  })();
  const capitalNet = (source: "3a" | "3b") => (projection?.capital_withdrawals ?? [])
    .filter((w) => w.source === source)
    .reduce((sum, w) => sum + w.amount - w.tax, 0);
  const p3aNet = capitalNet("3a");
  const p3bNet = capitalNet("3b");

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-display text-text-primary">Finanzprognosen</h1>
          <p className="text-text-tertiary text-sm mt-0.5">{t("pages:ui.monte_carlo_simulation_schweizer_rente_ahv_b")}</p>
        </div>
        <button onClick={() => refetch()} className="btn-secondary flex items-center gap-2" disabled={isLoading}>
          <Refresh className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
          Neu berechnen
        </button>
      </div>

      {/* Horizon selector */}
      <div className="flex gap-2 flex-wrap">
        {HORIZONS.map((h) => (
          <button
            key={h.key}
            onClick={() => setHorizon(h.key)}
            className={clsx("toggle-btn", horizon === h.key && "active")}
          >
            {t(h.label)}
          </button>
        ))}
      </div>

      {/* Szenario-Auswahl */}
      {scenarios.length > 0 && (
        <div className="card flex flex-wrap items-center gap-3">
          <label className="label mb-0" htmlFor="scenario-select">
            {t("pages:ui.scenario")}
          </label>
          <select
            id="scenario-select"
            className="input w-full max-w-sm"
            value={scenarioId ?? ""}
            onChange={(e) => {
              setScenarioTouched(true);
              setScenarioId(e.target.value ? Number(e.target.value) : null);
            }}
          >
            <option value="">{t("pages:ui.noScenario")}</option>
            {scenarios.map((sc) => (
              <option key={sc.id} value={sc.id}>{sc.name}</option>
            ))}
          </select>
          {scenarioId !== null && (
            <span className="text-text-tertiary text-xs">{t("pages:ui.scenarioHint")}</span>
          )}
        </div>
      )}

      {/* Parameters */}
      <div className="card">
        <h2 className="text-text-primary font-semibold text-sm mb-4">{t("pages:ui.simulationParams")}</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <label className="label">{t("pages:misc.r30")}</label>
            <input
              type="number"
              className="input"
              value={params.current_net_worth}
              onChange={(e) => setParams((p) => ({ ...p, current_net_worth: +e.target.value }))}
            />
          </div>
          <div>
            <label className="label">{t("pages:misc.r32")}</label>
            <input
              type="number"
              className="input"
              value={params.annual_savings}
              onChange={(e) => setParams((p) => ({ ...p, annual_savings: +e.target.value }))}
            />
          </div>
          <div>
            <label className="label">{t("pages:ui.jahreseinkommen")}</label>
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
            <label className="label">{t("pages:misc.r37")}</label>
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
          <div>
            <label className="label">{t("pages:ui.retirementSpendingLabel")}</label>
            <input
              type="number"
              min={0}
              step={500}
              className="input"
              value={spendingMonthly ?? ""}
              placeholder={projection?.retirement_spending ? String(Math.round(projection.retirement_spending / 12)) : ""}
              onChange={(e) => setSpendingMonthly(e.target.value === "" ? null : Math.max(0, +e.target.value))}
            />
            <p className="text-text-tertiary text-[10px] mt-0.5">{t("pages:ui.retirementSpendingHint")}</p>
          </div>
        </div>
      </div>

      {/* Swiss pension breakdown */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-text-primary font-semibold text-sm">{t("pages:misc.r34")}</h2>
            <p className="text-text-tertiary text-xs mt-0.5">
              {t("pages:ui.ahv_saeule_1_bvg_pensionskasse_saeule_2_saeu")}
            </p>
          </div>
        </div>
        {projection && projection.years.length > 1 && (
          <PensionOverviewChart projection={projection} retirementIdx={retIdx} />
        )}

        {/* ── Monthly pension KPIs at retirement ── */}
        {projection && retirementInHorizon && retIdx != null && (
          <div className="mt-4 pt-4 border-t border-border/50 space-y-3">
            <p className="text-text-secondary text-xs">
              {projection.depletion_age != null
                ? t("pages:ui.wealthDepletes", { age: projection.depletion_age })
                : t("pages:ui.wealthHolds", { age: currentAge + projection.years.length - 1 })}
              {" · "}
              {t("pages:ui.successRate", { pct: Math.round((projection.success_rate ?? 0) * 100) })}
              {" · "}
              {t("pages:ui.spendingUsed", {
                amount: formatCHF((projection.retirement_spending ?? 0) / 12),
              })}
            </p>
            <p className="text-text-secondary text-xs font-semibold uppercase tracking-wide">
              {t("pages:hints.pensionAtRetirement", { year: projection.years[retIdx] })}
            </p>
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
              {[
                { label: t("pages:ui.ahv_saeule_1"), annual: ahvAtRet, color: PILLAR_COLORS.ahv },
                { label: t("pages:ui.bvg_saeule_2"), annual: bvgAtRet, color: PILLAR_COLORS.bvg },
              ].map(({ label, annual, color }) => (
                <div key={label} className="bg-bg-elevated rounded-lg px-4 py-3 border border-border/30">
                  <p className="text-text-tertiary text-[11px] mb-1">{label}</p>
                  <p className="font-mono font-bold text-lg" style={{ color }}>
                    {formatCHF(annual / 12)}
                  </p>
                  <p className="text-text-tertiary text-[10px] mt-0.5">{t("pages:ui.monat_real_chf")}</p>
                  <p className="text-text-tertiary text-[10px]">{formatCHF(annual)} / Jahr</p>
                </div>
              ))}
              {/* 3a: keine Rente, sondern Kapital (netto nach Steuer) */}
              <div className="bg-bg-elevated rounded-lg px-4 py-3 border border-border/30">
                <p className="text-text-tertiary text-[11px] mb-1">{t("pages:ui.saeule_3a")}</p>
                <p className="font-mono font-bold text-lg" style={{ color: PILLAR_COLORS["3a"] }}>
                  {formatCHF(p3aNet)}
                </p>
                <p className="text-text-tertiary text-[10px] mt-0.5">{t("pages:plan.p3aCard")}</p>
              </div>
              {/* Lebensversicherung: am Ablauf, steuerfrei */}
              {p3bNet > 0 && (
                <div className="bg-bg-elevated rounded-lg px-4 py-3 border border-border/30">
                  <p className="text-text-tertiary text-[11px] mb-1">{t("pages:ui.saeule_3b_lv")}</p>
                  <p className="font-mono font-bold text-lg" style={{ color: PILLAR_COLORS["3b"] }}>
                    {formatCHF(p3bNet)}
                  </p>
                  <p className="text-text-tertiary text-[10px] mt-0.5">{t("pages:plan.p3bCard")}</p>
                </div>
              )}
            </div>
            {/* Total */}
            <div className="flex items-center justify-between bg-accent/8 border border-accent/20 rounded-lg px-4 py-3">
              <div>
                <p className="text-text-secondary text-xs font-semibold">{t("pages:misc.r31")}</p>
                <p className="text-text-tertiary text-[10px] mt-0.5">{t("pages:misc.r36")}</p>
              </div>
              <div className="text-right">
                <p className="font-mono font-bold text-xl text-accent">{formatCHF(totalPensionAnnual / 12)}</p>
                <p className="text-text-tertiary text-[10px]">pro Monat · {formatCHF(totalPensionAnnual)} / Jahr</p>
              </div>
            </div>
            {drawdownAtRet > 0 && (
              <p className="text-gain text-xs">
                {t("pages:overview.drawdownTotal", {
                  age: projection.drawdown_until_age ?? 90,
                  amount: formatCHF((totalPensionAnnual + drawdownAtRet) / 12),
                })}
              </p>
            )}
            <WithdrawalPlan
              withdrawals={projection.capital_withdrawals}
              taxSingleYear={projection.capital_tax_single_year}
            />
          </div>
        )}
        {projection && !retirementInHorizon && (
          <p className="text-text-tertiary text-xs mt-3">
            {t("pages:hints.horizonTooShort", { year: retirementYear, years: selectedHorizon.years })}
          </p>
        )}

        {/* Reference values */}
        <div className="grid grid-cols-3 gap-4 mt-4 pt-4 border-t border-border/50">
          {[
            { label: t("pages:ui.ahv_saeule_1"), value: "bis CHF 2'520/Mo × 13", desc: t("pages:ui.max_2024_bei_44_vollbeitragsjahren"), color: PILLAR_COLORS.ahv },
            { label: t("pages:ui.bvg_saeule_2"), value: t("pages:ui.bvgModelValue"), desc: t("pages:ui.umwandlungssatz_2024_im_modell"), color: PILLAR_COLORS.bvg },
            { label: t("pages:ui.saeule_3a"), value: `max. CHF 7'258/Jahr`, desc: t("pages:ui.beitragsgrenze_lohnabhaengige_2024"), color: PILLAR_COLORS["3a"] },
          ].map(({ label, value, desc, color }) => (
            <div key={label} className="card-elevated">
              <p className="text-text-tertiary text-xs">{label}</p>
              <p className="text-sm font-semibold mt-1 font-mono" style={{ color }}>{value}</p>
              <p className="text-text-tertiary text-xs mt-0.5">{desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Monte Carlo fan chart */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-text-primary font-semibold text-sm">{t("pages:misc.r33")}</h2>
            <p className="text-text-tertiary text-xs mt-0.5">
              {(10000).toLocaleString()} Monte Carlo Simulationen · Reale CHF (inflationsbereinigt)
            </p>
          </div>
          {projection && (
            <div className="text-right">
              <p className="text-text-tertiary text-xs">Median in {selectedHorizon.years} Jahren</p>
              <p className="text-text-primary font-mono font-semibold text-lg">
                {formatCHF(projection.p50?.[projection.p50.length - 1] || 0)}
              </p>
            </div>
          )}
        </div>
        {isLoading ? (
          <div className="h-80 flex items-center justify-center">
            <div className="flex items-center gap-3 text-text-tertiary">
              <Refresh className="w-5 h-5 animate-spin" />
              <span className="text-sm">{t("pages:misc.r35")}</span>
            </div>
          </div>
        ) : projection ? (
          <MonteCarloChart data={projection} height={320} />
        ) : null}
      </div>
    </div>
  );
}
