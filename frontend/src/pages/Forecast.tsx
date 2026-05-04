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

import { api, accountsApi, transactionsApi, recurringPlanApi, categoriesApi } from "@/lib/api";
import { formatAmount } from "@/lib/theme";
import ForecastComparisonChart, {
  type HistoricalPoint,
  type ForecastPoint,
  type BudgetPlanPoint,
} from "@/components/charts/ForecastComparisonChart";
import BudgetStackedBarChart, {
  type HistoricalCategoryItem,
  type WizardSnapshot,
  CHART_SC_ORDER,
} from "@/components/charts/BudgetStackedBarChart";
import { useTaxonomySuperCategories, resolveSuperCategoryFromList } from "@/lib/categories";
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
  peer_net_monthly: number;
  empirical_net_monthly: number;
  reference_currency?: string;
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

// ── Recurring plan month helper (mirrors Budgetplan.tsx logic) ──

interface PlanEntry {
  id: number;
  amount: number;
  periodicity: string;
  start_date: string;
  end_date: string | null;
  description: string;
  category_id: number | null;
}

function getPlanApplicableMonths(entry: PlanEntry, year: number): number[] {
  const sd = new Date(entry.start_date + "T00:00:00");
  const ed = entry.end_date ? new Date(entry.end_date + "T00:00:00") : null;
  const startM = sd.getFullYear() < year ? 1 : sd.getFullYear() === year ? sd.getMonth() + 1 : null;
  if (startM === null) return [];
  const endM = ed
    ? ed.getFullYear() > year ? 12 : ed.getFullYear() === year ? ed.getMonth() + 1 : null
    : 12;
  if (endM === null) return [];
  const anchor = sd.getMonth() + 1;
  const months: number[] = [];
  for (let m = startM; m <= endM; m++) {
    switch (entry.periodicity) {
      case "weekly":
      case "monthly": months.push(m); break;
      case "quarterly": if (((m - anchor) % 3 + 3) % 3 === 0) months.push(m); break;
      case "halfyearly": if (((m - anchor) % 6 + 6) % 6 === 0) months.push(m); break;
      case "yearly": if (m === anchor) months.push(m); break;
    }
  }
  return months;
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
  const superCategories = useTaxonomySuperCategories();
  const [tab, setTab] = useState<TabKey>("overview");
  const [horizon, setHorizon] = useState<HorizonKey>("12m");
  // showBreakdown is now managed internally by ForecastComparisonChart toggles
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

  // Fetch category breakdown for the last 24 months directly from the dedicated endpoint
  const { data: categorySummary = [] } = useQuery<HistoricalCategoryItem[]>({
    queryKey: ["monthly-category-breakdown-24m"],
    queryFn: () =>
      api.get("/transactions/monthly-category-breakdown", { params: { months: 24 } })
        .then((r) => r.data),
    staleTime: 15 * 60_000,
  });

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

  const forecastCcy = forecast?.reference_currency ?? user?.currency ?? "CHF";
  const fmtFc = (n: number) => formatAmount(n, forecastCcy);

  // Fetch wizard state — used by BudgetStackedBarChart for empirical forecast
  // (flat monthly amounts from user input, no AI drift on Steuern)
  const { data: wizardState } = useQuery<WizardSnapshot | null>({
    queryKey: ["wizard-state"],
    queryFn: () =>
      api.get("/wizard/state").then((r) => r.data ?? null).catch(() => null),
    staleTime: 60 * 60_000, // wizard data is quasi-static
    retry: false,
  });

  // Fetch peer-baseline independently (not coupled to forecast cache)
  const { data: peerBaseline } = useQuery({
    queryKey: ["peer-baseline", peerProfile],
    queryFn: () =>
      api.get("/forecasting/peer-baseline", { params: peerProfile }).then((r) => r.data),
    staleTime: 30 * 60_000,
  });

  const PEER_EXPENSE_KEYS = [
    "housing", "groceries", "transport", "health_insurance", "other_insurance",
    "communication", "dining_out", "entertainment", "clothing", "travel",
    "education", "subscriptions",
  ] as const;

  const peerNetMonthly = useMemo(() => {
    if (!peerBaseline?.defaults) return 0;
    const d = peerBaseline.defaults as Record<string, number>;
    const income = d.incomeMedian ?? 0;
    const expenses = PEER_EXPENSE_KEYS.reduce((s, k) => s + (d[k] ?? 0), 0);
    const taxes = d.direct_taxes ?? 0;
    return income - expenses - taxes;
  }, [peerBaseline]);

  const empiricalNetMonthly = useMemo(() => {
    if (!peerBaseline?.defaults) return 0;
    const d = peerBaseline.defaults as Record<string, number>;
    return (d.incomeMedian ?? 0) * ((d.savings_rate ?? 0) / 100);
  }, [peerBaseline]);

  // ── Budgetplan recurring plan — fetch for current + next 2 years ──
  const currentYear = new Date().getFullYear();

  const { data: planY0 = [] } = useQuery<PlanEntry[]>({
    queryKey: ["recurring-plan", currentYear],
    queryFn: () => recurringPlanApi.list({ year: currentYear }).then((r) => r.data as PlanEntry[]),
    staleTime: 5 * 60_000,
  });
  const { data: planY1 = [] } = useQuery<PlanEntry[]>({
    queryKey: ["recurring-plan", currentYear + 1],
    queryFn: () => recurringPlanApi.list({ year: currentYear + 1 }).then((r) => r.data as PlanEntry[]),
    staleTime: 5 * 60_000,
  });
  const { data: planY2 = [] } = useQuery<PlanEntry[]>({
    queryKey: ["recurring-plan", currentYear + 2],
    queryFn: () => recurringPlanApi.list({ year: currentYear + 2 }).then((r) => r.data as PlanEntry[]),
    staleTime: 5 * 60_000,
  });

  // Compute monthly budget plan points for the full forecast horizon
  const budgetPlanPoints = useMemo((): BudgetPlanPoint[] => {
    const planByYear: Record<number, PlanEntry[]> = {
      [currentYear]:     planY0,
      [currentYear + 1]: planY1,
      [currentYear + 2]: planY2,
    };
    const today = new Date();
    const points: BudgetPlanPoint[] = [];

    for (let i = 0; i < selectedHorizon.months; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
      const year = d.getFullYear();
      const month = d.getMonth() + 1; // 1–12
      const monthKey = `${year}-${String(month).padStart(2, "0")}`;

      // For years beyond our fetched range, repeat the last available year's entries
      const entries = planByYear[year] ?? planY2;
      let income = 0;
      let expense = 0;

      for (const entry of entries) {
        if (getPlanApplicableMonths(entry, year).includes(month)) {
          if (entry.amount > 0) income += entry.amount;
          else expense += entry.amount; // already negative
        }
      }
      // Only add point if there's actual plan data
      if (income !== 0 || expense !== 0) {
        points.push({ month: monthKey, income, expense, net: income + expense });
      }
    }
    return points;
  }, [planY0, planY1, planY2, selectedHorizon, currentYear]);

  // Categories for supercategory resolution of budget plan entries
  const { data: categories = [] } = useQuery({
    queryKey: ["categories"],
    queryFn: () => categoriesApi.list().then((r) => r.data),
    staleTime: 10 * 60_000,
  });

  const catById = useMemo(() =>
    new Map((categories as Array<{ id: number; name: string; icon?: string }>).map((c) => [c.id, c])),
    [categories]
  );

  const VALID_SC_ID_SET = useMemo(() => new Set(CHART_SC_ORDER), []);

  // Per-supercategory expense breakdown for the BudgetStackedBarChart "Budgetplan" mode
  const budgetPlanByMonth = useMemo((): Record<string, Record<string, number>> => {
    const planByYear: Record<number, PlanEntry[]> = {
      [currentYear]:     planY0,
      [currentYear + 1]: planY1,
      [currentYear + 2]: planY2,
    };
    const today = new Date();
    const result: Record<string, Record<string, number>> = {};

    for (let i = 0; i < selectedHorizon.months; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
      const year = d.getFullYear();
      const month = d.getMonth() + 1;
      const monthKey = `${year}-${String(month).padStart(2, "0")}`;
      const entries = planByYear[year] ?? planY2;

      for (const entry of entries) {
        // Only expense entries (negative amount)
        if (entry.amount >= 0) continue;
        if (!getPlanApplicableMonths(entry, year).includes(month)) continue;

        const amt = Math.abs(entry.amount);
        let scId = "sonstiges";

        const cat = entry.category_id != null ? catById.get(entry.category_id) : null;
        if (cat) {
          const icon = String((cat as any).icon ?? "").trim().toLowerCase();
          if (VALID_SC_ID_SET.has(icon)) {
            scId = icon;
          } else {
            const sc = resolveSuperCategoryFromList(superCategories, (cat as any).name, false);
            if (sc && sc.id !== "sparen") scId = sc.id;
          }
        } else {
          const sc = resolveSuperCategoryFromList(superCategories, entry.description, false);
          if (sc && sc.id !== "sparen") scId = sc.id;
        }

        if (!result[monthKey]) result[monthKey] = {};
        result[monthKey][scId] = (result[monthKey][scId] ?? 0) + amt;
      }
    }
    return result;
  }, [planY0, planY1, planY2, selectedHorizon, currentYear, catById, superCategories, VALID_SC_ID_SET]);

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
            {" "}Ø Einnahmen: {fmtFc(forecast.total_monthly_income_mean)}/Mt · Ø Ausgaben: {fmtFc(forecast.total_monthly_expense_mean)}/Mt
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
                  value: fmtFc(
                    (forecast.forecast ?? []).reduce((s, f) => s + f.predicted_income, 0) /
                      Math.max(forecast.forecast?.length ?? 1, 1)
                  ),
                  color: "text-gain",
                },
                {
                  label: "Ø Prognose Ausgaben",
                  value: fmtFc(
                    (forecast.forecast ?? []).reduce((s, f) => s + f.predicted_expense, 0) /
                      Math.max(forecast.forecast?.length ?? 1, 1)
                  ),
                  color: "text-loss",
                },
                {
                  label: "Ø Netto/Monat",
                  value: fmtFc(
                    (forecast.forecast ?? []).reduce((s, f) => s + f.net, 0) /
                      Math.max(forecast.forecast?.length ?? 1, 1)
                  ),
                  color: (forecast.forecast ?? []).reduce((s, f) => s + f.net, 0) >= 0
                    ? "text-gain" : "text-loss",
                },
                {
                  label: "Ø Konfidenz-Band",
                  value: `±${fmtFc(
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
                  <p className={`text-2xl font-mono font-semibold ${color}`}>{value}</p>
                </div>
              ))}
            </div>
          )}

          {/* Main chart */}
          <div className="card">
            <h2 className="text-text-primary font-semibold text-sm mb-4">
              Historisch vs. Prognose (Netto-Cashflow)
            </h2>
            {historicalPoints.length === 0 && forecastPoints.length === 0 ? (
              <div className="h-64 flex items-center justify-center text-text-tertiary text-sm">
                Keine Daten — importiere zuerst Kontoauszüge.
              </div>
            ) : (
              <ForecastComparisonChart
                historical={historicalPoints}
                forecast={forecastPoints}
                budgetPlanPoints={budgetPlanPoints}
                peerNetMonthly={peerNetMonthly}
                empiricalNetMonthly={empiricalNetMonthly}
                height={300}
              />
            )}
          </div>

          {/* Stacked bar: Historisch = real transactions, Prognose = wizard empirical */}
          <BudgetStackedBarChart
            historicalData={categorySummary ?? []}
            forecastData={forecast?.forecast ?? []}
            historicalAxisMonths={historicalPoints.map((p) => p.month)}
            forecastAxisMonths={forecastPoints.map((p) => p.month)}
            wizardData={wizardState}
            budgetPlanByMonth={budgetPlanByMonth}
            budgetPlanMonths={budgetPlanPoints.map((p) => p.month)}
            height={320}
          />
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
                              {fmtFc(vals.predicted)}
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
                        {fmtFc(val)}
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
                    {fmtFc(f.net)}
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
