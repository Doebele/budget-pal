/**
 * Finanzplan — Übersicht des durch den Wizard erstellten Finanzplans.
 *
 * Zeigt:
 *  • Monatlichen Cashflow (Einkommen / Ausgaben / Überschuss)
 *  • Budgetplan nach Superkategorie
 *  • Vorsorge (Säule 1 / 2 / 3a)
 *  • Vermögen (Aktien, Immobilien, Krypto, Sonstiges)
 *  • Schnell-Links zum Wizard / Rentenprognose / Budget
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Wand2, TrendingUp, PiggyBank, ArrowRight,
  Landmark, ShieldCheck, Coins, Building2,
  BarChart3, AlertCircle, RefreshCw,
} from "lucide-react";
import { api } from "@/lib/api";
import { formatCHF } from "@/lib/theme";
import { useTaxonomy } from "@/lib/categories";

// ── Types mirroring backend responses ─────────────────────────

interface BudgetItem {
  id: number;
  amount: number;
  notes: string | null;
  period: string;
  year: number;
  created_at: string | null;
}

interface PensionItem {
  id: number;
  pillar: string;
  provider: string | null;
  current_balance: number;
  annual_contribution: number;
  expected_return_rate: number;
  retirement_age: number;
  contribution_years: number | null;
  average_insured_salary: number | null;
  notes: string | null;
}

interface AssetItem {
  id: number;
  asset_type: string;
  name: string;
  current_value: number;
  currency: string;
  expected_return_rate: number | null;
  notes: string | null;
}

// ── Helpers ────────────────────────────────────────────────────

function fmtCHF(v: number) {
  return formatCHF(v, false);
}

/** Latest wizard-run budgets only (max created_at batch). */
function latestWizardBudgets(budgets: BudgetItem[]): BudgetItem[] {
  const wizard = budgets.filter((b) => b.notes !== null);
  if (!wizard.length) return [];
  const maxTs = wizard.reduce((m, b) => {
    const t = b.created_at ?? "";
    return t > m ? t : m;
  }, "");
  return wizard.filter((b) => (b.created_at ?? "") === maxTs);
}

const PILLAR_LABEL: Record<string, string> = {
  pillar_1: "Säule 1 — AHV/IV",
  pillar_2: "Säule 2 — Pensionskasse (BVG)",
  pillar_3a: "Säule 3a — Privat",
};

const PILLAR_COLOR: Record<string, string> = {
  pillar_1: "#38bdf8",
  pillar_2: "#a78bfa",
  pillar_3a: "#10b981",
};

const ASSET_LABEL: Record<string, string> = {
  stock: "Aktien & ETFs",
  property: "Immobilien",
  crypto: "Kryptowährungen",
  other: "Sonstiges",
  savings: "Sparkonto",
};

const ASSET_COLOR: Record<string, string> = {
  stock: "#84cc16",
  property: "#f0b429",
  crypto: "#fb923c",
  other: "#94a3b8",
  savings: "#22d3ee",
};

// ── Component ──────────────────────────────────────────────────

export default function Finanzplan() {
  const { resolveSuperCategory } = useTaxonomy();
  const { data: budgets = [], isLoading: budgetsLoading, error: budgetsError } = useQuery<BudgetItem[]>({
    queryKey: ["finanzplan-budgets"],
    queryFn: () => api.get("/budgets").then((r) => r.data),
    staleTime: 60_000,
  });

  const { data: pension = [], isLoading: pensionLoading } = useQuery<PensionItem[]>({
    queryKey: ["finanzplan-pension"],
    queryFn: () => api.get("/pension").then((r) => r.data),
    staleTime: 60_000,
  });

  const { data: assets = [], isLoading: assetsLoading } = useQuery<AssetItem[]>({
    queryKey: ["finanzplan-assets"],
    queryFn: () => api.get("/assets").then((r) => r.data),
    staleTime: 60_000,
  });

  const isLoading = budgetsLoading || pensionLoading || assetsLoading;

  // ── Derive wizard budgets + totals ──────────────────────────
  const wizardBudgets = useMemo(() => latestWizardBudgets(budgets), [budgets]);

  const totalExpenses = useMemo(
    () => wizardBudgets.reduce((s, b) => s + b.amount, 0),
    [wizardBudgets],
  );

  // ── Group by supercategory ──────────────────────────────────
  const categoryGroups = useMemo(() => {
    const map = new Map<string, { color: string; label: string; icon: React.ElementType; total: number; items: BudgetItem[] }>();
    for (const b of wizardBudgets) {
      const sc = resolveSuperCategory(b.notes ?? "", true);
      if (!map.has(sc.id)) {
        map.set(sc.id, { color: sc.color, label: sc.label, icon: sc.icon, total: 0, items: [] });
      }
      const g = map.get(sc.id)!;
      g.total += b.amount;
      g.items.push(b);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [wizardBudgets, resolveSuperCategory]);

  // ── Pension totals ──────────────────────────────────────────
  const pensionByPillar = useMemo(() => {
    const map = new Map<string, PensionItem[]>();
    for (const p of pension) {
      const arr = map.get(p.pillar) ?? [];
      arr.push(p);
      map.set(p.pillar, arr);
    }
    return map;
  }, [pension]);

  const totalPension = useMemo(
    () => pension.reduce((s, p) => s + p.current_balance, 0),
    [pension],
  );

  // ── Asset totals ────────────────────────────────────────────
  const totalAssets = useMemo(
    () => assets.reduce((s, a) => s + a.current_value, 0),
    [assets],
  );

  const assetsByType = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of assets) {
      map.set(a.asset_type, (map.get(a.asset_type) ?? 0) + a.current_value);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [assets]);

  // ── Empty state (no wizard run yet) ────────────────────────
  const hasData = wizardBudgets.length > 0 || pension.length > 0 || assets.length > 0;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-5 h-5 text-accent animate-spin" />
      </div>
    );
  }

  if (budgetsError) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <AlertCircle className="w-8 h-8 text-loss" />
        <p className="text-text-secondary text-sm">Finanzplan konnte nicht geladen werden.</p>
      </div>
    );
  }

  if (!hasData) {
    return (
      <div className="max-w-xl mx-auto py-20 flex flex-col items-center gap-6 text-center">
        <div className="w-16 h-16 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center">
          <BarChart3 className="w-8 h-8 text-accent" />
        </div>
        <div>
          <h1 className="text-text-primary font-display font-bold text-2xl mb-2">Kein Finanzplan vorhanden</h1>
          <p className="text-text-secondary text-sm leading-relaxed">
            Erstelle deinen persönlichen Finanzplan mit dem Wizard — basierend auf echten BFS-Daten für deine Peer-Gruppe.
          </p>
        </div>
        <Link
          to="/wizard"
          className="btn-primary flex items-center gap-2 text-sm"
        >
          <Wand2 className="w-4 h-4" />
          Finanzplan erstellen
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">

      {/* ── Header ───────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-text-primary font-display font-bold text-2xl mb-1">Finanzplan</h1>
          <p className="text-text-secondary text-sm">
            Empirische Angaben — Monatliche Übersicht
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            to="/wizard"
            className="btn-secondary flex items-center gap-1.5 text-xs py-1.5 px-3"
          >
            <Wand2 className="w-3.5 h-3.5" />
            Wizard
          </Link>
          <Link
            to="/budget"
            className="btn-secondary flex items-center gap-1.5 text-xs py-1.5 px-3"
          >
            <PiggyBank className="w-3.5 h-3.5" />
            Budgetanalyse
          </Link>
          <Link
            to="/projections"
            className="btn-primary flex items-center gap-1.5 text-xs py-1.5 px-3"
          >
            <TrendingUp className="w-3.5 h-3.5" />
            Rentenprognose
          </Link>
        </div>
      </div>

      {/* ── Cashflow-Karten ───────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-bg-surface2 rounded-xl border border-border/40 px-5 py-4">
          <p className="text-text-tertiary text-[11px] uppercase tracking-widest font-semibold mb-1">Ausgaben/Mo</p>
          <p className="text-text-primary font-mono font-bold text-2xl">{fmtCHF(totalExpenses)}</p>
          <p className="text-text-tertiary text-xs mt-1">{wizardBudgets.length} Budgetposten</p>
        </div>
        <div className="bg-bg-surface2 rounded-xl border border-border/40 px-5 py-4">
          <p className="text-text-tertiary text-[11px] uppercase tracking-widest font-semibold mb-1">Gesamtvermögen</p>
          <p className="font-mono font-bold text-2xl" style={{ color: "#10b981" }}>{fmtCHF(totalAssets)}</p>
          <p className="text-text-tertiary text-xs mt-1">{assets.length} Positionen</p>
        </div>
        <div className="bg-bg-surface2 rounded-xl border border-border/40 px-5 py-4">
          <p className="text-text-tertiary text-[11px] uppercase tracking-widest font-semibold mb-1">Vorsorgekapital</p>
          <p className="font-mono font-bold text-2xl" style={{ color: "#a78bfa" }}>{fmtCHF(totalPension)}</p>
          <p className="text-text-tertiary text-xs mt-1">{pension.length} Einträge</p>
        </div>
      </div>

      {/* ── Budgetplan ────────────────────────────────────────── */}
      {wizardBudgets.length > 0 && (
        <section className="bg-bg-surface2 rounded-xl border border-border/40 overflow-hidden">
          <div className="px-5 py-4 border-b border-border/40 flex items-center justify-between">
            <h2 className="text-text-primary font-semibold text-sm">Monatlicher Budgetplan</h2>
            <span className="text-text-tertiary text-xs font-mono">{fmtCHF(totalExpenses)} / Mo</span>
          </div>
          <div className="divide-y divide-border/30">
            {categoryGroups.map((group) => {
              const pct = totalExpenses > 0 ? (group.total / totalExpenses) * 100 : 0;
              const Icon = group.icon;
              return (
                <div key={group.label} className="px-5 py-3">
                  <div className="flex items-center gap-3 mb-2">
                    <span
                      className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0"
                      style={{ backgroundColor: group.color + "22" }}
                    >
                      <Icon className="w-3.5 h-3.5" style={{ color: group.color }} />
                    </span>
                    <span className="text-text-primary text-sm font-medium flex-1">{group.label}</span>
                    <span className="text-text-secondary font-mono text-sm font-semibold">{fmtCHF(group.total)}</span>
                    <span className="text-text-tertiary text-xs w-10 text-right">{pct.toFixed(0)}%</span>
                  </div>
                  {/* Progress bar */}
                  <div className="h-1.5 rounded-full bg-bg-elevated overflow-hidden ml-9">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${pct}%`, backgroundColor: group.color }}
                    />
                  </div>
                  {/* Sub-items */}
                  {group.items.length > 1 && (
                    <div className="mt-2 ml-9 space-y-0.5">
                      {group.items.map((item) => (
                        <div key={item.id} className="flex items-center justify-between">
                          <span className="text-text-tertiary text-[11px]">{item.notes}</span>
                          <span className="text-text-tertiary font-mono text-[11px]">{fmtCHF(item.amount)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Vorsorge ──────────────────────────────────────────── */}
      {pension.length > 0 && (
        <section className="bg-bg-surface2 rounded-xl border border-border/40 overflow-hidden">
          <div className="px-5 py-4 border-b border-border/40 flex items-center justify-between">
            <h2 className="text-text-primary font-semibold text-sm">Vorsorge</h2>
            <span className="text-text-tertiary text-xs font-mono">{fmtCHF(totalPension)} Kapital</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-border/30">
            {(["pillar_1", "pillar_2", "pillar_3a"] as const).map((pillar) => {
              const entries = pensionByPillar.get(pillar) ?? [];
              const totalBalance = entries.reduce((s, p) => s + p.current_balance, 0);
              const totalContrib = entries.reduce((s, p) => s + p.annual_contribution, 0);
              const color = PILLAR_COLOR[pillar];
              return (
                <div key={pillar} className="px-5 py-4">
                  <div className="flex items-center gap-2 mb-3">
                    <ShieldCheck className="w-4 h-4 flex-shrink-0" style={{ color }} />
                    <span className="text-text-secondary text-xs font-medium">{PILLAR_LABEL[pillar]}</span>
                  </div>
                  {entries.length === 0 ? (
                    <p className="text-text-tertiary text-xs">Nicht erfasst</p>
                  ) : (
                    <div className="space-y-1">
                      <div className="flex justify-between">
                        <span className="text-text-tertiary text-xs">Kapital</span>
                        <span className="font-mono text-xs text-text-primary">{fmtCHF(totalBalance)}</span>
                      </div>
                      {totalContrib > 0 && (
                        <div className="flex justify-between">
                          <span className="text-text-tertiary text-xs">Jahresbeitrag</span>
                          <span className="font-mono text-xs text-text-secondary">{fmtCHF(totalContrib)}</span>
                        </div>
                      )}
                      {entries.map((e) => e.contribution_years != null && (
                        <div key={e.id} className="flex justify-between">
                          <span className="text-text-tertiary text-xs">Beitragsjahre</span>
                          <span className="font-mono text-xs text-text-secondary">{e.contribution_years}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Vermögen ──────────────────────────────────────────── */}
      {assets.length > 0 && (
        <section className="bg-bg-surface2 rounded-xl border border-border/40 overflow-hidden">
          <div className="px-5 py-4 border-b border-border/40 flex items-center justify-between">
            <h2 className="text-text-primary font-semibold text-sm">Vermögen</h2>
            <span className="text-text-tertiary text-xs font-mono">{fmtCHF(totalAssets)}</span>
          </div>
          <div className="divide-y divide-border/30">
            {assetsByType.map(([type, value]) => {
              const pct = totalAssets > 0 ? (value / totalAssets) * 100 : 0;
              const color = ASSET_COLOR[type] ?? "#94a3b8";
              const label = ASSET_LABEL[type] ?? type;
              return (
                <div key={type} className="px-5 py-3">
                  <div className="flex items-center gap-3 mb-1.5">
                    <Coins className="w-4 h-4 flex-shrink-0" style={{ color }} />
                    <span className="text-text-primary text-sm flex-1">{label}</span>
                    <span className="text-text-secondary font-mono text-sm">{fmtCHF(value)}</span>
                    <span className="text-text-tertiary text-xs w-10 text-right">{pct.toFixed(0)}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-bg-elevated overflow-hidden ml-7">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${pct}%`, backgroundColor: color }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── CTA ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pb-6">
        <Link
          to="/projections"
          className="flex items-center justify-between gap-3 bg-bg-surface2 hover:bg-bg-elevated border border-border/40 hover:border-accent/30 rounded-xl px-5 py-4 transition-all group"
        >
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center">
              <TrendingUp className="w-4.5 h-4.5 text-accent" />
            </div>
            <div>
              <p className="text-text-primary text-sm font-medium">Rentenprognose</p>
              <p className="text-text-tertiary text-xs">Monte-Carlo-Simulation</p>
            </div>
          </div>
          <ArrowRight className="w-4 h-4 text-text-tertiary group-hover:text-accent transition-colors" />
        </Link>

        <Link
          to="/budget"
          className="flex items-center justify-between gap-3 bg-bg-surface2 hover:bg-bg-elevated border border-border/40 hover:border-accent/30 rounded-xl px-5 py-4 transition-all group"
        >
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gain/10 flex items-center justify-center">
              <PiggyBank className="w-4.5 h-4.5 text-gain" />
            </div>
            <div>
              <p className="text-text-primary text-sm font-medium">Budgetanalyse</p>
              <p className="text-text-tertiary text-xs">Ist vs. Soll Vergleich</p>
            </div>
          </div>
          <ArrowRight className="w-4 h-4 text-text-tertiary group-hover:text-accent transition-colors" />
        </Link>
      </div>
    </div>
  );
}
