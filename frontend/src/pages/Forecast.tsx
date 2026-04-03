/**
 * Forecast page — Predictive Budgeting Engine.
 *
 * Tabs:
 *   1. Übersicht   — ForecastComparisonChart (historical + predicted overlay)
 *   2. Monatlich   — ForecastCard grid (month-by-month)
 *   3. Kategorien  — Category-level breakdown table
 *   4. Ruhestand   — RetirementPlanner component
 *
 * Zeithorizonte: 3M | 6M | 12M | 2J | 5J | Bis Rente
 */
import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Brain, RefreshCw, Save, ChevronDown, Info,
  BarChart3, CalendarDays, Table2, Landmark,
} from "lucide-react";

import { api, accountsApi, transactionsApi } from "@/lib/api";
import { formatCHF } from "@/lib/theme";
import ForecastComparisonChart, {
  type HistoricalPoint,
  type ForecastPoint,
} from "@/components/charts/ForecastComparisonChart";
import ForecastCard from "@/components/ForecastCard";
import RetirementPlanner from "@/components/RetirementPlanner";
import { useAuth } from "@/lib/auth";

// ── Types ────────────────────────────────────────────────────

interface ForecastMonthRaw {
  month: string;
  predicted_income: number;
  predicted_expense: number;
  net: number;
  confidence_low: number;
  confidence_high: number;
  peer_calibrated: boolean;
  category_breakdown: Record<string, {
    predicted: number;
    confidence_low: number;
    confidence_high: number;
  }>;
}

interface ForecastResult {
  months: string[];
  forecast: ForecastMonthRaw[];
  data_months: number;
  first_date: string | null;
  last_date: string | null;
  total_monthly_income_mean: number;
  total_monthly_expense_mean: number;
  scenario_id: number | null;
}

// ── Horizon options ──────────────────────────────────────────

const HORIZONS = [
  { key: "3m", label: "3 Monate", months: 3 },
  { key: "6m", label: "6 Monate", months: 6 },
  { key: "12m", label: "12 Monate", months: 12 },
  { key: "2y", label: "2 Jahre", months: 24 },
  { key: "5y", label: "5 Jahre", months: 60 },
  { key: "retirement", label: "Bis Rente", months: 240 },
] as const;

type HorizonKey = typeof HORIZONS[number]["key"];

// ── Tabs ─────────────────────────────────────────────────────

const TABS = [
  { key: "overview", label: "Übersicht", icon: BarChart3 },
  { key: "monthly", label: "Monatlich", icon: CalendarDays },
  { key: "categories", label: "Kategorien", icon: Table2 },
  { key: "retirement", label: "Ruhestand", icon: Landmark },
] as const;

type TabKey = typeof TABS[number]["key"];

// ── Age groups etc. for peer profile ─────────────────────────

const AGE_GROUPS = ["25-34", "35-44", "45-54", "55-64", "65+"];
const HOUSEHOLD_TYPES = [
  { value: "single", label: "Single" },
  { value: "couple", label: "Paar" },
  { value: "family", label: "Familie" },
  { value: "single-parent", label: "Alleinerziehend" },
];
const EMPLOYMENT = [
  { value: "employed", label: "Angestellt" },
  { value: "self-employed", label: "Selbständig" },
  { value: "mixed", label: "Gemischt" },
  { value: "retired", label: "Rentner/in" },
];
const INCOME_LEVELS = [
  { value: "low", label: "Gering" },
  { value: "medium", label: "Mittel" },
  { value: "high", label: "Hoch" },
];

// ── Helper ───────────────────────────────────────────────────

function formatMonthShort(m: string): string {
  const [year, month] = m.split("-");
  const names = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun",
                  "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
  return `${names[parseInt(month, 10) - 1]} ${year}`;
}

function categoryColor(name: string): string {
  const palette: Record<string, string> = {
    Wohnen: "#60a5fa", Lebensmittel: "#4ade80", Transport: "#f59e0b",
    Krankenkasse: "#f87171", Restaurant: "#fb923c", Freizeit: "#a78bfa",
    Kleider: "#34d399", Reisen: "#38bdf8", Bildung: "#c084fc",
    Abonnemente: "#facc15", Kommunikation: "#6ee7b7", Einkommen: "#86efac",
    Sparen: "#93c5fd", Sonstiges: "#94a3b8",
  };
  return palette[name] ?? "#94a3b8";
}

// ── Main component ───────────────────────────────────────────

export default function Forecast() {
  const { user } = useAuth();
  const [tab, setTab] = useState<TabKey>("overview");
  const [horizon, setHorizon] = useState<HorizonKey>("12m");
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [showPeerSettings, setShowPeerSettings] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [scenarioName, setScenarioName] = useState("");

  const [peerProfile, setPeerProfile] = useState({
    age_group: "35-44",
    canton: "ZH",
    household_type: "single",
    employment_status: "employed",
    income_level: "medium",
  });

  const selectedHorizon = HORIZONS.find((h) => h.key === horizon)!;

  // Fetch accounts for net worth
  const { data: accounts } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => accountsApi.list().then((r) => r.data),
  });
  const totalBalance: number = (accounts ?? []).reduce(
    (s: number, a: { balance: number }) => s + a.balance,
    0
  );

  // Fetch historical monthly summary (for overlay chart) — last 2 years
  const { data: historicalSummary } = useQuery({
    queryKey: ["monthly-summary-forecast"],
    queryFn: async () => {
      const thisYear = new Date().getFullYear();
      const [r1, r2] = await Promise.all([
        transactionsApi.monthlySummary({ year: thisYear - 1 }),
        transactionsApi.monthlySummary({ year: thisYear }),
      ]);
      return [...(r1.data as Array<{
        year: number; month: number;
        income: number; expenses: number; net: number;
      }>), ...(r2.data as Array<{
        year: number; month: number;
        income: number; expenses: number; net: number;
      }>)];
    },
    staleTime: 5 * 60_000,
  });

  // Build forecast request
  const forecastPayload = {
    horizon_months: selectedHorizon.months,
    time_horizon: horizon,
    include_peer_baseline: true,
    peer_profile: peerProfile,
    lookback_months: 24,
  };

  const {
    data: forecast,
    isLoading,
    refetch,
    isFetching,
  } = useQuery<ForecastResult>({
    queryKey: ["forecast", forecastPayload],
    queryFn: () =>
      api.post("/forecasting/scenario", forecastPayload).then((r) => r.data),
    staleTime: 10 * 60_000,
  });

  // Save scenario mutation
  const saveMutation = useMutation({
    mutationFn: (name: string) =>
      api.post("/forecasting/scenario", { ...forecastPayload, save_as: name }).then((r) => r.data),
    onSuccess: () => setScenarioName(""),
  });

  // Historical data for chart (API returns `expenses` as positive number)
  const historicalPoints: HistoricalPoint[] = useMemo(() => {
    return (historicalSummary ?? []).map((row) => ({
      month: `${row.year}-${String(row.month).padStart(2, "0")}`,
      income: row.income,
      expense: row.expenses ?? 0,
      net: row.net,
    }));
  }, [historicalSummary]);

  // Forecast data for chart
  const forecastPoints: ForecastPoint[] = useMemo(() => {
    return (forecast?.forecast ?? []).map((f) => ({
      month: f.month,
      predicted_income: f.predicted_income,
      predicted_expense: f.predicted_expense,
      net: f.net,
      confidence_low: f.confidence_low,
      confidence_high: f.confidence_high,
      peer_calibrated: f.peer_calibrated,
    }));
  }, [forecast]);

  // Categories for the table tab
  const categoryNames = useMemo(() => {
    const cats = new Set<string>();
    forecast?.forecast?.forEach((f) =>
      Object.keys(f.category_breakdown).forEach((c) => cats.add(c))
    );
    return [...cats].sort();
  }, [forecast]);

  const isRunning = isLoading || isFetching;

  return (
    <div className="space-y-5 animate-fade-in">

      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-display text-text-primary flex items-center gap-2">
            <Brain className="w-6 h-6 text-accent" />
            Budgetprognose
          </h1>
          <p className="text-text-tertiary text-sm mt-0.5">
            KI-gestützte Vorhersage · Historische Analyse · Peer-Gruppe Schweiz
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Save scenario */}
          <div className="flex gap-1">
            <input
              type="text"
              placeholder="Szenario speichern…"
              value={scenarioName}
              onChange={(e) => setScenarioName(e.target.value)}
              className="input-field text-sm w-44"
            />
            <button
              onClick={() => scenarioName && saveMutation.mutate(scenarioName)}
              disabled={!scenarioName || saveMutation.isPending}
              className="btn-secondary flex items-center gap-1.5 text-sm"
            >
              <Save className="w-3.5 h-3.5" />
            </button>
          </div>
          <button
            onClick={() => refetch()}
            disabled={isRunning}
            className="btn-secondary flex items-center gap-2 text-sm"
          >
            <RefreshCw className={`w-4 h-4 ${isRunning ? "animate-spin" : ""}`} />
            Neu
          </button>
        </div>
      </div>

      {/* ── Horizon selector ── */}
      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-text-tertiary text-xs font-medium mr-1">Zeithorizont:</span>
        {HORIZONS.map((h) => (
          <button
            key={h.key}
            onClick={() => setHorizon(h.key)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              horizon === h.key
                ? "bg-accent text-white"
                : "bg-bg-surface2 text-text-secondary border border-border hover:text-text-primary"
            }`}
          >
            {h.label}
          </button>
        ))}
      </div>

      {/* ── Data quality banner ── */}
      {forecast && (
        <div className={`flex items-start gap-2 px-4 py-2.5 rounded-lg text-xs ${
          (forecast.data_months ?? 0) < 3
            ? "bg-amber-500/10 border border-amber-500/30 text-amber-300"
            : "bg-green-500/10 border border-green-500/20 text-green-300"
        }`}>
          <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>
            {(forecast.data_months ?? 0) < 3
              ? `Nur ${forecast.data_months} Monate Transaktionsdaten — Peer-Gruppe-Werte werden stärker gewichtet.`
              : `${forecast.data_months} Monate Transaktionshistorie analysiert (${forecast.first_date} – ${forecast.last_date}).`
            }
            {" "}Ø Einnahmen: {formatCHF(forecast.total_monthly_income_mean)}/Mt · Ø Ausgaben: {formatCHF(forecast.total_monthly_expense_mean)}/Mt
          </span>
        </div>
      )}

      {/* ── Peer-group settings (collapsible) ── */}
      <div className="card py-3">
        <button
          className="flex items-center justify-between w-full text-sm text-text-secondary hover:text-text-primary"
          onClick={() => setShowPeerSettings(!showPeerSettings)}
        >
          <span className="font-medium">Peer-Gruppe Kalibrierung</span>
          <ChevronDown className={`w-4 h-4 transition-transform ${showPeerSettings ? "rotate-180" : ""}`} />
        </button>
        {showPeerSettings && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mt-4">
            <div>
              <label className="text-text-tertiary text-[11px] mb-1 block">Altersgruppe</label>
              <select
                value={peerProfile.age_group}
                onChange={(e) => setPeerProfile((p) => ({ ...p, age_group: e.target.value }))}
                className="input-field text-sm w-full"
              >
                {AGE_GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
            <div>
              <label className="text-text-tertiary text-[11px] mb-1 block">Haushalt</label>
              <select
                value={peerProfile.household_type}
                onChange={(e) => setPeerProfile((p) => ({ ...p, household_type: e.target.value }))}
                className="input-field text-sm w-full"
              >
                {HOUSEHOLD_TYPES.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-text-tertiary text-[11px] mb-1 block">Beschäftigung</label>
              <select
                value={peerProfile.employment_status}
                onChange={(e) => setPeerProfile((p) => ({ ...p, employment_status: e.target.value }))}
                className="input-field text-sm w-full"
              >
                {EMPLOYMENT.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-text-tertiary text-[11px] mb-1 block">Einkommen</label>
              <select
                value={peerProfile.income_level}
                onChange={(e) => setPeerProfile((p) => ({ ...p, income_level: e.target.value }))}
                className="input-field text-sm w-full"
              >
                {INCOME_LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-text-tertiary text-[11px] mb-1 block">Kanton</label>
              <input
                type="text"
                maxLength={2}
                value={peerProfile.canton}
                onChange={(e) => setPeerProfile((p) => ({ ...p, canton: e.target.value.toUpperCase() }))}
                className="input-field text-sm w-full uppercase"
                placeholder="ZH"
              />
            </div>
          </div>
        )}
      </div>

      {/* ── Tabs ── */}
      <div className="flex gap-1 border-b border-border">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
              tab === key
                ? "border-accent text-accent"
                : "border-transparent text-text-secondary hover:text-text-primary"
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* ── Loading skeleton ── */}
      {isRunning && (
        <div className="card h-72 flex items-center justify-center animate-pulse">
          <div className="text-center space-y-2">
            <Brain className="w-8 h-8 text-accent mx-auto animate-pulse" />
            <p className="text-text-secondary text-sm">Prognose wird berechnet…</p>
            <p className="text-text-tertiary text-xs">
              Zeitreihen-Analyse · Saisonalität · Peer-Kalibrierung
            </p>
          </div>
        </div>
      )}

      {/* ── Tab: Übersicht ── */}
      {!isRunning && tab === "overview" && (
        <div className="space-y-4">
          {/* KPI row */}
          {forecast && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                {
                  label: "Ø Prognose Einnahmen",
                  value: formatCHF(
                    (forecast.forecast ?? []).reduce((s, f) => s + f.predicted_income, 0) /
                      Math.max(forecast.forecast?.length ?? 1, 1)
                  ),
                  color: "text-gain",
                },
                {
                  label: "Ø Prognose Ausgaben",
                  value: formatCHF(
                    (forecast.forecast ?? []).reduce((s, f) => s + f.predicted_expense, 0) /
                      Math.max(forecast.forecast?.length ?? 1, 1)
                  ),
                  color: "text-loss",
                },
                {
                  label: "Ø Netto/Monat",
                  value: formatCHF(
                    (forecast.forecast ?? []).reduce((s, f) => s + f.net, 0) /
                      Math.max(forecast.forecast?.length ?? 1, 1)
                  ),
                  color: (forecast.forecast ?? []).reduce((s, f) => s + f.net, 0) >= 0
                    ? "text-gain" : "text-loss",
                },
                {
                  label: "Ø Konfidenz-Band",
                  value: `±${formatCHF(
                    (forecast.forecast ?? []).reduce(
                      (s, f) => s + (f.confidence_high - f.confidence_low) / 2,
                      0
                    ) / Math.max(forecast.forecast?.length ?? 1, 1)
                  )}`,
                  color: "text-text-secondary",
                },
              ].map(({ label, value, color }) => (
                <div key={label} className="card py-3">
                  <p className="text-text-tertiary text-[11px] mb-1">{label}</p>
                  <p className={`text-lg font-display font-bold ${color}`}>{value}</p>
                </div>
              ))}
            </div>
          )}

          {/* Main chart */}
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-text-primary font-semibold text-sm">
                Historisch vs. Prognose (Netto-Cashflow)
              </h2>
              <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={showBreakdown}
                  onChange={(e) => setShowBreakdown(e.target.checked)}
                  className="accent-accent"
                />
                Einnahmen/Ausgaben
              </label>
            </div>
            {historicalPoints.length === 0 && forecastPoints.length === 0 ? (
              <div className="h-64 flex items-center justify-center text-text-tertiary text-sm">
                Keine Daten — importiere zuerst Kontoauszüge.
              </div>
            ) : (
              <ForecastComparisonChart
                historical={historicalPoints}
                forecast={forecastPoints}
                showBreakdown={showBreakdown}
                height={300}
              />
            )}
          </div>
        </div>
      )}

      {/* ── Tab: Monatlich ── */}
      {!isRunning && tab === "monthly" && (
        <div className="space-y-4">
          {(forecast?.forecast ?? []).length === 0 ? (
            <div className="card text-center py-12 text-text-tertiary text-sm">
              Keine Prognosedaten
            </div>
          ) : (
            <>
              {selectedMonth && (() => {
                const detail = forecast?.forecast?.find((f) => f.month === selectedMonth);
                if (!detail) return null;
                return (
                  <div className="card">
                    <h3 className="text-text-primary font-semibold text-sm mb-3">
                      Detailansicht: {formatMonthShort(selectedMonth)}
                    </h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {Object.entries(detail.category_breakdown)
                        .sort((a, b) => Math.abs(b[1].predicted) - Math.abs(a[1].predicted))
                        .map(([cat, vals]) => (
                          <div
                            key={cat}
                            className="flex items-center justify-between p-2 bg-bg-surface2 rounded-lg text-xs"
                          >
                            <div className="flex items-center gap-1.5">
                              <div
                                className="w-2 h-2 rounded-full flex-shrink-0"
                                style={{ background: categoryColor(cat) }}
                              />
                              <span className="text-text-secondary">{cat}</span>
                            </div>
                            <span className={vals.predicted >= 0 ? "text-gain font-mono" : "text-loss font-mono"}>
                              {formatCHF(vals.predicted)}
                            </span>
                          </div>
                        ))}
                    </div>
                  </div>
                );
              })()}

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {forecast!.forecast.map((f) => (
                  <ForecastCard
                    key={f.month}
                    data={f}
                    isSelected={selectedMonth === f.month}
                    onClick={() =>
                      setSelectedMonth(selectedMonth === f.month ? null : f.month)
                    }
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Tab: Kategorien ── */}
      {!isRunning && tab === "categories" && (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 pr-4 text-text-tertiary font-medium">Kategorie</th>
                {(forecast?.forecast ?? []).slice(0, 12).map((f) => (
                  <th key={f.month} className="text-right py-2 px-2 text-text-tertiary font-medium whitespace-nowrap">
                    {formatMonthShort(f.month)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {categoryNames.map((cat) => (
                <tr key={cat} className="border-b border-border/30 hover:bg-bg-surface2">
                  <td className="py-2 pr-4">
                    <div className="flex items-center gap-1.5">
                      <div
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ background: categoryColor(cat) }}
                      />
                      <span className="text-text-primary font-medium">{cat}</span>
                    </div>
                  </td>
                  {(forecast?.forecast ?? []).slice(0, 12).map((f) => {
                    const val = f.category_breakdown[cat]?.predicted ?? 0;
                    return (
                      <td
                        key={f.month}
                        className={`text-right py-2 px-2 font-mono whitespace-nowrap ${
                          val >= 0 ? "text-gain/90" : "text-loss/90"
                        }`}
                      >
                        {formatCHF(val)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border">
                <td className="py-2 pr-4 text-text-tertiary font-medium">Netto</td>
                {(forecast?.forecast ?? []).slice(0, 12).map((f) => (
                  <td
                    key={f.month}
                    className={`text-right py-2 px-2 font-mono font-semibold ${
                      f.net >= 0 ? "text-gain" : "text-loss"
                    }`}
                  >
                    {formatCHF(f.net)}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
          {(forecast?.forecast?.length ?? 0) > 12 && (
            <p className="text-text-tertiary text-[11px] mt-3">
              Zeigt die ersten 12 Monate. Wechsle zu «Monatlich» für alle {forecast!.forecast.length} Monate.
            </p>
          )}
        </div>
      )}

      {/* ── Tab: Ruhestand ── */}
      {!isRunning && tab === "retirement" && (
        <RetirementPlanner
          currentNetWorth={totalBalance}
          monthlyNetMean={
            forecast
              ? (forecast.total_monthly_income_mean - forecast.total_monthly_expense_mean)
              : 0
          }
          dateOfBirth={user?.date_of_birth ?? null}
        />
      )}
    </div>
  );
}
