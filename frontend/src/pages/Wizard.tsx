/**
 * Onboarding Wizard — 8-step Swiss financial profile builder.
 *
 * Steps:
 *  1. Demografie (Profil)
 *  2. Einkommen
 *  3. Peer-Group-Analyse (animated reveal)
 *  4. Wohnkosten & Versicherungen
 *  5. Alltag & Abonnements
 *  6. Vermögen & Anlagen
 *  7. Vorsorge (3 Säulen)
 *  8. Finanzplan-Ziele
 *  → Review & Submit
 */

import { useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  BarChart3, ChevronRight, ChevronLeft,
  Home, Heart, Car, Train, Banknote,
  TrendingUp, Building2, Bitcoin, BookOpen,
  ShieldCheck, Plane, ArrowRight, Check,
} from "lucide-react";
import { clsx } from "clsx";
import { api } from "@/lib/api";
import {
  getPeerGroupDefaults,
  COMMON_SUBSCRIPTIONS,
  SWISS_CANTONS,
  formatCHF,
} from "@/services/peerGroupAnalyzer";
import type { PeerGroupDefaults, PeerGroupProfile } from "@/services/peerGroupAnalyzer";
import StepIndicator from "@/components/wizard/StepIndicator";
import PeerGroupCard from "@/components/wizard/PeerGroupCard";
import Step5AccordionExpenses from "@/components/wizard/Step5AccordionExpenses";
import type { SelectedExpenseEntry, CustomExpenseEntry } from "@/components/wizard/Step5AccordionExpenses";

// ── Wizard data shape ──────────────────────────────────────────

interface Pillar3aAccount {
  provider: string;
  balance: number;
  annualContribution: number;
  strategy: "interest" | "funds";
}

interface WizardData {
  // Step 1
  vorname: string;
  geburtsjahr: number;
  kanton: string;
  haushalt: "single" | "couple" | "family" | "single-parent";
  beschaeftigung: "employed" | "self-employed" | "mixed" | "retired";

  // Step 2 — income sources
  lohn: number;
  lohnEnabled: boolean;
  selbstaendig: number;
  selbstaendigEnabled: boolean;
  dividenden: number;
  dividendenEnabled: boolean;
  mieteinnahmen: number;
  mieteinnahmenEnabled: boolean;
  auslandeinkommen: number;
  auslandeinkommenEnabled: boolean;
  ahvRente: number;
  ahvRenteEnabled: boolean;

  // Step 3 — peer group overrides
  peerGroupDefaults: PeerGroupDefaults | null;
  peerGroupAccepted: boolean;

  // Step 4 — housing
  housingMode: "miete" | "hypothek";
  monthlyRent: number;
  nebenkosten: number;
  propertyValue: number;
  outstandingDebt: number;
  monthlyAmortization: number;
  healthInsurancePerPerson: number;
  franchise: 300 | 500 | 1000 | 1500 | 2000 | 2500;
  zusatzversicherung: number;
  hausrat: number;
  autoversicherung: number;
  hasAutoInsurance: boolean;

  // Step 5 — daily life
  groceries: number;
  transportMode: "ov" | "car" | "both";
  hasSbbHalbtax: boolean;
  hasSbbGa: boolean;
  monthlyFuel: number;
  parking: number;
  carAmortization: number;
  selectedSubscriptions: string[];
  expenseEntries: SelectedExpenseEntry[];
  customExpenseEntries: CustomExpenseEntry[];
  freizeit: number;

  // Step 6 — assets
  bankBalance: number;
  bankEnabled: boolean;
  stocksValue: number;
  stocksEnabled: boolean;
  propertyAssetValue: number;
  propertyAssetDebt: number;
  propertyAssetEnabled: boolean;
  cryptoValue: number;
  cryptoEnabled: boolean;
  otherAssetsValue: number;
  otherAssetsEnabled: boolean;

  // Step 7 — pension
  ahvBeitragsjahre: number;
  ahvDurchschnittsLohn: number;
  bvgGuthaben: number;
  bvgJahresbeitrag: number;
  bvgRentenalter: number;
  pillar3aAccounts: Pillar3aAccount[];
  hasLifeInsurance: boolean;
  lifeInsuranceType: "kapital" | "risiko" | "gemischt";
  lifeInsuranceAblauf: string;
  lifeInsuranceLeistung: number;

  // Step 8 — goals
  zielRentenalter: number;
  lebenserwartung: number;
  lifestylePercent: number;
  scenarioMortgage: boolean;
  scenarioSavings: boolean;
  scenarioEarlyRetirement: boolean;
  scenarioCare: boolean;
  inflation: number;
}

const DEFAULT_WIZARD_DATA: WizardData = {
  vorname: "",
  geburtsjahr: 1985,
  kanton: "ZH",
  haushalt: "single",
  beschaeftigung: "employed",

  lohn: 0,
  lohnEnabled: true,
  selbstaendig: 0,
  selbstaendigEnabled: false,
  dividenden: 0,
  dividendenEnabled: false,
  mieteinnahmen: 0,
  mieteinnahmenEnabled: false,
  auslandeinkommen: 0,
  auslandeinkommenEnabled: false,
  ahvRente: 0,
  ahvRenteEnabled: false,

  peerGroupDefaults: null,
  peerGroupAccepted: false,

  housingMode: "miete",
  monthlyRent: 1500,
  nebenkosten: 200,
  propertyValue: 800_000,
  outstandingDebt: 600_000,
  monthlyAmortization: 1_000,
  healthInsurancePerPerson: 420,
  franchise: 300,
  zusatzversicherung: 0,
  hausrat: 70,
  autoversicherung: 0,
  hasAutoInsurance: false,

  groceries: 500,
  transportMode: "ov",
  hasSbbHalbtax: false,
  hasSbbGa: false,
  monthlyFuel: 0,
  parking: 0,
  carAmortization: 0,
  selectedSubscriptions: ["Netflix", "Spotify", "ADSL/Fiber (Swisscom)", "Mobile Abo (Sunrise)"],
  expenseEntries: [],
  customExpenseEntries: [],
  freizeit: 250,

  bankBalance: 0,
  bankEnabled: false,
  stocksValue: 0,
  stocksEnabled: false,
  propertyAssetValue: 0,
  propertyAssetDebt: 0,
  propertyAssetEnabled: false,
  cryptoValue: 0,
  cryptoEnabled: false,
  otherAssetsValue: 0,
  otherAssetsEnabled: false,

  ahvBeitragsjahre: 10,
  ahvDurchschnittsLohn: 80_000,
  bvgGuthaben: 50_000,
  bvgJahresbeitrag: 8_000,
  bvgRentenalter: 65,
  pillar3aAccounts: [{ provider: "VIAC", balance: 20_000, annualContribution: 7_056, strategy: "funds" }],
  hasLifeInsurance: false,
  lifeInsuranceType: "kapital",
  lifeInsuranceAblauf: "",
  lifeInsuranceLeistung: 0,

  zielRentenalter: 65,
  lebenserwartung: 90,
  lifestylePercent: 80,
  scenarioMortgage: false,
  scenarioSavings: false,
  scenarioEarlyRetirement: false,
  scenarioCare: true,
  inflation: 1.5,
};

// ── Helpers ────────────────────────────────────────────────────

function chf(n: number) {
  return formatCHF(n);
}

function computeNettoEinkommen(data: WizardData): number {
  const gross =
    (data.lohnEnabled ? data.lohn : 0) +
    (data.selbstaendigEnabled ? data.selbstaendig : 0) +
    (data.dividendenEnabled ? data.dividenden : 0) +
    (data.mieteinnahmenEnabled ? data.mieteinnahmen : 0) +
    (data.auslandeinkommenEnabled ? data.auslandeinkommen : 0) +
    (data.ahvRenteEnabled ? data.ahvRente : 0);
  // Very rough Swiss deduction estimate (AHV/ALV ~12%, taxes ~20% for employed)
  const isRetired = data.beschaeftigung === "retired";
  const deductionRate = isRetired ? 0.05 : 0.28;
  return Math.round(gross * (1 - deductionRate));
}

function computeAhvRente(beitragsjahre: number, avgLohn: number): number {
  // BFS AHV formula approximation (2023 scale):
  // Min 1_225 CHF/Mo (44 years), Max 2_450 CHF/Mo
  const fullYears = 44;
  const minRente = 1_225;
  const maxRente = 2_450;
  const completionFactor = Math.min(beitragsjahre / fullYears, 1);
  const lohnFactor = Math.min(avgLohn / 86_040, 1); // OASI max insured salary
  const base = minRente + (maxRente - minRente) * lohnFactor;
  return Math.round(base * completionFactor);
}

function computeBvgKapital(guthaben: number, jahresbeitrag: number, yearsToRetirement: number): number {
  const rate = 0.015; // BVG Mindestzins 2023
  let capital = guthaben;
  for (let i = 0; i < yearsToRetirement; i++) {
    capital = (capital + jahresbeitrag) * (1 + rate);
  }
  return Math.round(capital);
}

// ── Section wrapper ────────────────────────────────────────────

function Section({ title, children, className }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={clsx("space-y-4", className)}>
      {title && (
        <h3 className="text-text-secondary text-xs font-semibold uppercase tracking-widest">{title}</h3>
      )}
      {children}
    </div>
  );
}

// ── Field ──────────────────────────────────────────────────────

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="label">{label}</label>
      {children}
      {hint && <p className="text-text-tertiary text-xs">{hint}</p>}
    </div>
  );
}

// ── CHF input ──────────────────────────────────────────────────

function ChfInput({
  value,
  onChange,
  placeholder = "0",
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={clsx("relative", className)}>
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary text-sm">CHF</span>
      <input
        type="number"
        className="input pl-12"
        value={value || ""}
        placeholder={placeholder}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      />
    </div>
  );
}

// ── Toggle card ────────────────────────────────────────────────

function ToggleCard({
  enabled,
  onToggle,
  icon,
  label,
  sublabel,
  children,
}: {
  enabled: boolean;
  onToggle: () => void;
  icon: string;
  label: string;
  sublabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={clsx(
      "rounded-xl border transition-all duration-200 overflow-hidden",
      enabled ? "border-accent/40 bg-accent/5" : "border-white/8 bg-white/2"
    )}>
      <button
        type="button"
        className="w-full flex items-center gap-3 p-4 text-left"
        onClick={onToggle}
      >
        <span className="text-xl shrink-0">{icon}</span>
        <div className="flex-1 min-w-0">
          <p className={clsx("text-sm font-medium", enabled ? "text-text-primary" : "text-text-secondary")}>
            {label}
          </p>
          {sublabel && <p className="text-text-tertiary text-xs">{sublabel}</p>}
        </div>
        <div className={clsx(
          "w-5 h-5 rounded-full border-2 shrink-0 flex items-center justify-center transition-all",
          enabled ? "bg-accent border-accent" : "border-white/25"
        )}>
          {enabled && <Check className="w-3 h-3 text-white" />}
        </div>
      </button>
      {enabled && children && (
        <div className="px-4 pb-4 pt-0 border-t border-accent/15 space-y-3">
          {children}
        </div>
      )}
    </div>
  );
}

// ── Slider ─────────────────────────────────────────────────────

function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  format: fmt = (v) => String(v),
  className,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  className?: string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className={clsx("space-y-2", className)}>
      <div className="flex justify-between text-xs text-text-tertiary">
        <span>{fmt(min)}</span>
        <span className="text-text-primary font-mono font-semibold">{fmt(value)}</span>
        <span>{fmt(max)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
        style={{
          background: `linear-gradient(to right, var(--accent) ${pct}%, rgba(255,255,255,0.1) ${pct}%)`,
        }}
      />
    </div>
  );
}

// ── Summary card ───────────────────────────────────────────────

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card-elevated flex flex-col gap-1">
      <p className="text-text-tertiary text-xs uppercase tracking-wide">{label}</p>
      <p className="text-text-primary font-mono font-semibold text-lg">{value}</p>
      {sub && <p className="text-text-tertiary text-xs">{sub}</p>}
    </div>
  );
}

// ── Step 1: Demografie ─────────────────────────────────────────

function Step1({ data, update }: { data: WizardData; update: (p: Partial<WizardData>) => void }) {
  const HAUSHALT_OPTIONS: { value: WizardData["haushalt"]; label: string; icon: string }[] = [
    { value: "single",       label: "Einzelperson",   icon: "🧑" },
    { value: "couple",       label: "Paar",            icon: "👫" },
    { value: "family",       label: "Familie",         icon: "👨‍👩‍👧" },
    { value: "single-parent", label: "Alleinerziehend", icon: "👤" },
  ];
  const BESCHAEFTIGUNG_OPTIONS: { value: WizardData["beschaeftigung"]; label: string }[] = [
    { value: "employed",      label: "Angestellt" },
    { value: "self-employed", label: "Selbständig" },
    { value: "mixed",         label: "Beides" },
    { value: "retired",       label: "Pensioniert" },
  ];

  return (
    <div className="space-y-8">
      <div className="text-center space-y-3">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-accent/30 to-accent/10 border border-accent/30 flex items-center justify-center mx-auto">
          <BarChart3 className="w-8 h-8 text-accent" />
        </div>
        <div>
          <h1 className="text-2xl font-display font-semibold text-text-primary">
            Willkommen bei Budget<span className="text-accent">Pal</span>
          </h1>
          <p className="text-text-secondary text-sm mt-1.5 max-w-sm mx-auto leading-relaxed">
            Dein persönlicher Schweizer Finanzplan — basierend auf echten BFS-Daten für deine Peer-Gruppe.
          </p>
        </div>
      </div>

      <Section title="Persönliche Angaben">
        <Field label="Vorname">
          <input
            type="text"
            className="input"
            placeholder="z.B. Maria"
            value={data.vorname}
            onChange={(e) => update({ vorname: e.target.value })}
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Geburtsjahr">
            <input
              type="number"
              className="input"
              min={1940}
              max={2010}
              value={data.geburtsjahr}
              onChange={(e) => update({ geburtsjahr: parseInt(e.target.value) || 1985 })}
            />
          </Field>
          <Field label="Kanton">
            <select
              className="input"
              value={data.kanton}
              onChange={(e) => update({ kanton: e.target.value })}
            >
              {SWISS_CANTONS.map((c) => (
                <option key={c.code} value={c.code}>{c.name} ({c.code})</option>
              ))}
            </select>
          </Field>
        </div>
      </Section>

      <Section title="Haushalt">
        <div className="grid grid-cols-2 gap-2.5">
          {HAUSHALT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={clsx(
                "rounded-xl border p-3.5 text-left transition-all duration-150",
                data.haushalt === opt.value
                  ? "border-accent/50 bg-accent/10"
                  : "border-white/8 bg-white/2 hover:border-white/20 hover:bg-white/5"
              )}
              onClick={() => update({ haushalt: opt.value })}
            >
              <span className="text-2xl block mb-1.5">{opt.icon}</span>
              <span className={clsx(
                "text-sm font-medium",
                data.haushalt === opt.value ? "text-accent" : "text-text-secondary"
              )}>{opt.label}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Beschäftigungsstatus">
        <div className="grid grid-cols-2 gap-2">
          {BESCHAEFTIGUNG_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={clsx(
                "rounded-lg border py-2.5 px-3 text-sm font-medium transition-all duration-150",
                data.beschaeftigung === opt.value
                  ? "border-accent/50 bg-accent/10 text-accent"
                  : "border-white/8 bg-white/2 text-text-secondary hover:border-white/20"
              )}
              onClick={() => update({ beschaeftigung: opt.value })}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}

// ── Step 2: Einkommen ──────────────────────────────────────────

function Step2({ data, update }: { data: WizardData; update: (p: Partial<WizardData>) => void }) {
  const netto = computeNettoEinkommen(data);

  const INCOME_SOURCES = [
    {
      icon: "💼", label: "Lohn / Gehalt (brutto)", sublabel: "Monatlich",
      enabledKey: "lohnEnabled" as const, valueKey: "lohn" as const,
      show: true,
    },
    {
      icon: "🏢", label: "Selbständiges Einkommen", sublabel: "Monatlicher Durchschnitt",
      enabledKey: "selbstaendigEnabled" as const, valueKey: "selbstaendig" as const,
      show: true,
    },
    {
      icon: "📈", label: "Dividenden & Kapitalerträge", sublabel: "Monatlicher Durchschnitt",
      enabledKey: "dividendenEnabled" as const, valueKey: "dividenden" as const,
      show: true,
    },
    {
      icon: "🏠", label: "Mieteinnahmen", sublabel: "Monatlich netto",
      enabledKey: "mieteinnahmenEnabled" as const, valueKey: "mieteinnahmen" as const,
      show: true,
    },
    {
      icon: "🌍", label: "Auslandeinkommen", sublabel: "Monatlicher Durchschnitt (CHF-Equivalent)",
      enabledKey: "auslandeinkommenEnabled" as const, valueKey: "auslandeinkommen" as const,
      show: true,
    },
    {
      icon: "🏦", label: "AHV / Rente", sublabel: "Monatliche Rentenzahlung",
      enabledKey: "ahvRenteEnabled" as const, valueKey: "ahvRente" as const,
      show: data.beschaeftigung === "retired",
    },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-text-primary font-semibold text-lg">Einkommensquellen</h2>
        <p className="text-text-secondary text-sm mt-1">
          Aktiviere alle zutreffenden Quellen und gib die monatlichen Beträge an.
        </p>
      </div>

      <div className="space-y-3">
        {INCOME_SOURCES.filter((s) => s.show).map((src) => (
          <ToggleCard
            key={src.enabledKey}
            enabled={data[src.enabledKey]}
            onToggle={() => update({ [src.enabledKey]: !data[src.enabledKey] })}
            icon={src.icon}
            label={src.label}
            sublabel={src.sublabel}
          >
            <Field label={`Betrag (CHF/Monat)`}>
              <ChfInput
                value={data[src.valueKey]}
                onChange={(v) => update({ [src.valueKey]: v })}
              />
            </Field>
          </ToggleCard>
        ))}
      </div>

      {netto > 0 && (
        <div className="card border-gain/20 bg-gain/5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-text-tertiary text-xs uppercase tracking-wide">Geschätztes Nettoeinkommen</p>
              <p className="text-gain font-mono font-semibold text-2xl mt-0.5">{chf(netto)}</p>
              <p className="text-text-tertiary text-xs mt-1">
                pro Monat — nach AHV/ALV-Abzügen und Steuerschätzung
              </p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-gain/15 flex items-center justify-center">
              <Banknote className="w-5 h-5 text-gain" />
            </div>
          </div>
          <p className="text-text-tertiary text-xs mt-3 pt-3 border-t border-gain/15">
            Nettoeinkommen wird automatisch geschätzt — basierend auf typischen Abzügen in {data.kanton}.
            Die genaue Steuerberechnung erfolgt im Finanzplan.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Step 3: Peer-Group-Analyse ─────────────────────────────────

function Step3({
  data,
  update,
}: {
  data: WizardData;
  update: (p: Partial<WizardData>) => void;
}) {
  const profile: PeerGroupProfile = {
    ageGroup: (() => {
      const age = new Date().getFullYear() - data.geburtsjahr;
      if (age < 35) return "25-34";
      if (age < 45) return "35-44";
      if (age < 55) return "45-54";
      if (age < 65) return "55-64";
      return "65+";
    })(),
    canton: data.kanton,
    householdType: data.haushalt,
    employmentStatus: data.beschaeftigung,
    incomeLevel: (() => {
      const annualBrutto =
        ((data.lohnEnabled ? data.lohn : 0) +
         (data.selbstaendigEnabled ? data.selbstaendig : 0)) * 12;
      if (annualBrutto < 80_000) return "low";
      if (annualBrutto < 150_000) return "medium";
      return "high";
    })(),
  };

  const defaults = getPeerGroupDefaults(profile);
  const userNetto = computeNettoEinkommen(data);

  function handleAccept() {
    update({
      peerGroupDefaults: defaults,
      peerGroupAccepted: true,
      monthlyRent: defaults.housing,
      groceries: defaults.groceries,
      freizeit: defaults.dining_out + defaults.entertainment,
    });
  }

  function handleAdjust(key: keyof PeerGroupDefaults, value: number) {
    update({
      peerGroupDefaults: { ...defaults, [key]: value },
    });
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-text-primary font-semibold text-lg">Deine Peer-Gruppe</h2>
        <p className="text-text-secondary text-sm mt-1">
          Basierend auf deinem Profil haben wir passende BFS-Vergleichswerte gefunden.
        </p>
      </div>

      <PeerGroupCard
        profile={profile}
        defaults={data.peerGroupDefaults ?? defaults}
        userIncomeMonthly={userNetto}
        onAccept={handleAccept}
        onAdjust={handleAdjust}
      />
    </div>
  );
}

// ── Step 4: Wohnkosten & Versicherungen ───────────────────────

function Step4({ data, update }: { data: WizardData; update: (p: Partial<WizardData>) => void }) {
  const FRANCHISE_OPTIONS = [300, 500, 1000, 1500, 2000, 2500] as const;

  return (
    <div className="space-y-7">
      <div>
        <h2 className="text-text-primary font-semibold text-lg">Wohnkosten & Versicherungen</h2>
        <p className="text-text-secondary text-sm mt-1">
          Gib deine monatlichen Wohn- und Versicherungskosten an.
        </p>
      </div>

      <Section title="Wohnsituation">
        <div className="flex gap-2">
          {(["miete", "hypothek"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={clsx(
                "flex-1 rounded-lg border py-2.5 text-sm font-medium transition-all",
                data.housingMode === mode
                  ? "border-accent/50 bg-accent/10 text-accent"
                  : "border-white/8 text-text-secondary hover:border-white/20"
              )}
              onClick={() => update({ housingMode: mode })}
            >
              {mode === "miete" ? (
                <><Home className="w-4 h-4 inline mr-1.5" />Miete</>
              ) : (
                <><Building2 className="w-4 h-4 inline mr-1.5" />Hypothek</>
              )}
            </button>
          ))}
        </div>

        {data.housingMode === "miete" ? (
          <div className="space-y-3">
            <Field label="Monatliche Miete">
              <ChfInput value={data.monthlyRent} onChange={(v) => update({ monthlyRent: v })} />
            </Field>
            <Field label="Nebenkosten (Strom, Heizung, etc.)">
              <ChfInput value={data.nebenkosten} onChange={(v) => update({ nebenkosten: v })} />
            </Field>
          </div>
        ) : (
          <div className="space-y-3">
            <Field label="Marktwert der Immobilie">
              <ChfInput value={data.propertyValue} onChange={(v) => update({ propertyValue: v })} />
            </Field>
            <Field label="Ausstehende Hypothek">
              <ChfInput value={data.outstandingDebt} onChange={(v) => update({ outstandingDebt: v })} />
            </Field>
            <Field label="Monatliche Amortisation">
              <ChfInput value={data.monthlyAmortization} onChange={(v) => update({ monthlyAmortization: v })} />
            </Field>
          </div>
        )}
      </Section>

      <Section title="Krankenversicherung">
        <Field label="Prämie pro Person (CHF/Monat)" hint="Grundversicherung Krankenkasse">
          <ChfInput
            value={data.healthInsurancePerPerson}
            onChange={(v) => update({ healthInsurancePerPerson: v })}
          />
        </Field>

        <Field label="Franchise">
          <div className="grid grid-cols-3 gap-2">
            {FRANCHISE_OPTIONS.map((f) => (
              <button
                key={f}
                type="button"
                className={clsx(
                  "rounded-lg border py-2 text-sm font-medium transition-all",
                  data.franchise === f
                    ? "border-accent/50 bg-accent/10 text-accent"
                    : "border-white/8 text-text-secondary hover:border-white/15"
                )}
                onClick={() => update({ franchise: f })}
              >
                {chf(f)}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Zusatzversicherung (falls vorhanden)">
          <ChfInput
            value={data.zusatzversicherung}
            onChange={(v) => update({ zusatzversicherung: v })}
            placeholder="0"
          />
        </Field>
      </Section>

      <Section title="Weitere Versicherungen">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Hausrat & Haftpflicht">
            <ChfInput value={data.hausrat} onChange={(v) => update({ hausrat: v })} />
          </Field>
          <div className="space-y-1.5">
            <label className="label">Autoversicherung</label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                className={clsx(
                  "w-8 h-5 rounded-full transition-colors duration-200 shrink-0",
                  data.hasAutoInsurance ? "bg-accent" : "bg-white/15"
                )}
                onClick={() => update({ hasAutoInsurance: !data.hasAutoInsurance })}
              >
                <div className={clsx(
                  "w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ml-0.5",
                  data.hasAutoInsurance ? "translate-x-3" : "translate-x-0"
                )} />
              </button>
              <span className="text-text-secondary text-sm">{data.hasAutoInsurance ? "Ja" : "Nein"}</span>
            </div>
            {data.hasAutoInsurance && (
              <ChfInput value={data.autoversicherung} onChange={(v) => update({ autoversicherung: v })} />
            )}
          </div>
        </div>
      </Section>
    </div>
  );
}

// ── Step 5: Alltag & Abonnements ──────────────────────────────

function Step5({ data, update }: { data: WizardData; update: (p: Partial<WizardData>) => void }) {
  const selectedSet = new Set(data.selectedSubscriptions);
  const subscriptionTotal = COMMON_SUBSCRIPTIONS
    .filter((s) => selectedSet.has(s.name))
    .reduce((sum, s) => sum + s.price, 0);

  function toggleSubscription(name: string) {
    const next = new Set(selectedSet);
    next.has(name) ? next.delete(name) : next.add(name);
    update({ selectedSubscriptions: Array.from(next) });
  }

  const CATEGORY_LABELS: Record<string, string> = {
    streaming: "Streaming", music: "Musik", news: "News", cloud: "Cloud",
    software: "Software", loyalty: "Kundenprogramme", internet: "Internet",
    mobile: "Mobile", transport: "Transport", fitness: "Fitness",
    professional: "Business", shopping: "Shopping",
  };

  const byCategory = COMMON_SUBSCRIPTIONS.reduce<Record<string, typeof COMMON_SUBSCRIPTIONS>>((acc, s) => {
    (acc[s.category] = acc[s.category] || []).push(s);
    return acc;
  }, {});

  return (
    <div className="space-y-7">
      <div>
        <h2 className="text-text-primary font-semibold text-lg">Alltag & Abonnements</h2>
        <p className="text-text-secondary text-sm mt-1">
          Konfiguriere deine monatlichen Alltagsausgaben.
        </p>
      </div>

      <Section title="Lebensmittel">
        <Field label="Monatliches Budget Lebensmittel (Supermarkt)">
          <ChfInput value={data.groceries} onChange={(v) => update({ groceries: v })} />
        </Field>
      </Section>

      <Section title="Mobilität">
        <div className="grid grid-cols-3 gap-2">
          {([
            { value: "ov", label: "Nur ÖV", icon: <Train className="w-4 h-4" /> },
            { value: "car", label: "Nur Auto", icon: <Car className="w-4 h-4" /> },
            { value: "both", label: "Beides", icon: null },
          ] as const).map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={clsx(
                "rounded-lg border py-2.5 text-xs font-medium transition-all flex items-center justify-center gap-1.5",
                data.transportMode === opt.value
                  ? "border-accent/50 bg-accent/10 text-accent"
                  : "border-white/8 text-text-secondary hover:border-white/15"
              )}
              onClick={() => update({ transportMode: opt.value })}
            >
              {opt.icon}{opt.label}
            </button>
          ))}
        </div>

        {(data.transportMode === "ov" || data.transportMode === "both") && (
          <div className="space-y-2">
            <p className="text-text-tertiary text-xs font-medium uppercase tracking-wide mt-3">ÖV-Abonnement</p>
            <div className="flex gap-2 flex-wrap">
              {[
                { key: "hasSbbHalbtax" as const, label: "SBB Halbtax", price: 19 },
                { key: "hasSbbGa" as const, label: "SBB GA 2. Kl.", price: 345 },
              ].map((abo) => (
                <button
                  key={abo.key}
                  type="button"
                  className={clsx(
                    "rounded-lg border px-3 py-2 text-sm transition-all",
                    data[abo.key]
                      ? "border-accent/50 bg-accent/10 text-accent"
                      : "border-white/8 text-text-secondary hover:border-white/15"
                  )}
                  onClick={() => update({ [abo.key]: !data[abo.key] })}
                >
                  {abo.label} — {chf(abo.price)}/Mo
                </button>
              ))}
            </div>
          </div>
        )}

        {(data.transportMode === "car" || data.transportMode === "both") && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 mt-3">
            <Field label="Benzin/Strom">
              <ChfInput value={data.monthlyFuel} onChange={(v) => update({ monthlyFuel: v })} />
            </Field>
            <Field label="Parkplatz">
              <ChfInput value={data.parking} onChange={(v) => update({ parking: v })} />
            </Field>
            <Field label="Amortisation Auto">
              <ChfInput value={data.carAmortization} onChange={(v) => update({ carAmortization: v })} />
            </Field>
          </div>
        )}
      </Section>

      <Section title="Abonnements & Services">
        <div className="card-elevated space-y-4">
          {Object.entries(byCategory).map(([category, subs]) => (
            <div key={category}>
              <p className="text-text-tertiary text-[10px] font-semibold uppercase tracking-widest mb-2">
                {CATEGORY_LABELS[category] ?? category}
              </p>
              <div className="space-y-1.5">
                {subs.map((sub) => {
                  const isSelected = selectedSet.has(sub.name);
                  return (
                    <button
                      key={sub.name}
                      type="button"
                      className={clsx(
                        "w-full flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-all",
                        isSelected
                          ? "bg-accent/10 text-text-primary"
                          : "hover:bg-white/5 text-text-secondary"
                      )}
                      onClick={() => toggleSubscription(sub.name)}
                    >
                      <div className="flex items-center gap-2">
                        <div className={clsx(
                          "w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-all",
                          isSelected ? "bg-accent border-accent" : "border-white/25"
                        )}>
                          {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
                        </div>
                        <span>{sub.name}</span>
                      </div>
                      <span className={clsx("font-mono text-xs", isSelected ? "text-accent" : "text-text-tertiary")}>
                        {sub.price > 0 ? `${chf(sub.price)}/Mo` : "Gratis"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="pt-3 border-t border-white/8 flex items-center justify-between">
            <span className="text-text-secondary text-sm">Total Abonnements</span>
            <span className="font-mono font-semibold text-text-primary">{chf(subscriptionTotal)}/Mo</span>
          </div>
        </div>
      </Section>

      <Section title="Freizeit & Gastronomie">
        <Field label="Restaurant, Takeaway & Freizeit (CHF/Monat)">
          <ChfInput value={data.freizeit} onChange={(v) => update({ freizeit: v })} />
        </Field>
        <Slider
          value={data.freizeit}
          min={0}
          max={2000}
          step={50}
          onChange={(v) => update({ freizeit: v })}
          format={(v) => chf(v)}
        />
      </Section>
    </div>
  );
}

// ── Step 6: Vermögen & Anlagen ─────────────────────────────────

function Step6({ data, update }: { data: WizardData; update: (p: Partial<WizardData>) => void }) {
  const totalAssets =
    (data.bankEnabled ? data.bankBalance : 0) +
    (data.stocksEnabled ? data.stocksValue : 0) +
    (data.propertyAssetEnabled ? data.propertyAssetValue : 0) +
    (data.cryptoEnabled ? data.cryptoValue : 0) +
    (data.otherAssetsEnabled ? data.otherAssetsValue : 0);

  const ASSETS = [
    {
      icon: "🏦",
      label: "Bankkonto / Sparkonto",
      sublabel: "Gesamtsaldo aller Konten",
      enabledKey: "bankEnabled" as const,
      children: (
        <Field label="Gesamtsaldo">
          <ChfInput value={data.bankBalance} onChange={(v) => update({ bankBalance: v })} />
        </Field>
      ),
    },
    {
      icon: "📊",
      label: "Aktien & ETFs",
      sublabel: "Aktueller Depotwert",
      enabledKey: "stocksEnabled" as const,
      children: (
        <>
          <Field label="Aktueller Depotwert">
            <ChfInput value={data.stocksValue} onChange={(v) => update({ stocksValue: v })} />
          </Field>
          <p className="text-text-tertiary text-xs flex items-center gap-1.5 mt-1">
            <TrendingUp className="w-3.5 h-3.5 text-accent" />
            Tipp: Du kannst später Daten aus Portfolio-Tracker importieren.
          </p>
        </>
      ),
    },
    {
      icon: "🏠",
      label: "Immobilien",
      sublabel: "Marktwert abzüglich Hypothek",
      enabledKey: "propertyAssetEnabled" as const,
      children: (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Marktwert">
            <ChfInput value={data.propertyAssetValue} onChange={(v) => update({ propertyAssetValue: v })} />
          </Field>
          <Field label="Ausstehende Hypothek">
            <ChfInput value={data.propertyAssetDebt} onChange={(v) => update({ propertyAssetDebt: v })} />
          </Field>
        </div>
      ),
    },
    {
      icon: "🪙",
      label: "Kryptowährungen",
      sublabel: "Aktueller Marktwert (CHF)",
      enabledKey: "cryptoEnabled" as const,
      children: (
        <Field label="Aktueller Wert">
          <ChfInput value={data.cryptoValue} onChange={(v) => update({ cryptoValue: v })} />
        </Field>
      ),
    },
    {
      icon: "💰",
      label: "Sonstige Anlagen",
      sublabel: "Obligationen, Fonds, Private Equity, etc.",
      enabledKey: "otherAssetsEnabled" as const,
      children: (
        <Field label="Geschätzter Wert">
          <ChfInput value={data.otherAssetsValue} onChange={(v) => update({ otherAssetsValue: v })} />
        </Field>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-text-primary font-semibold text-lg">Vermögen & Anlagen</h2>
        <p className="text-text-secondary text-sm mt-1">
          Erfasse dein aktuelles Vermögen für die Finanzplan-Berechnung.
        </p>
      </div>

      <div className="space-y-3">
        {ASSETS.map((asset) => (
          <ToggleCard
            key={asset.enabledKey}
            enabled={data[asset.enabledKey]}
            onToggle={() => update({ [asset.enabledKey]: !data[asset.enabledKey] })}
            icon={asset.icon}
            label={asset.label}
            sublabel={asset.sublabel}
          >
            {asset.children}
          </ToggleCard>
        ))}
      </div>

      {totalAssets > 0 && (
        <div className="card border-accent/15">
          <p className="text-text-tertiary text-xs uppercase tracking-wide">Gesamtvermögen (geschätzt)</p>
          <p className="text-text-primary font-mono font-bold text-2xl mt-1">{chf(totalAssets)}</p>
        </div>
      )}
    </div>
  );
}

// ── Step 7: Vorsorge ───────────────────────────────────────────

function Step7({ data, update }: { data: WizardData; update: (p: Partial<WizardData>) => void }) {
  const currentYear = new Date().getFullYear();
  const age = currentYear - data.geburtsjahr;
  const yearsToRetirement = Math.max(data.bvgRentenalter - age, 0);

  const ahvRente = computeAhvRente(data.ahvBeitragsjahre, data.ahvDurchschnittsLohn);
  const bvgKapital = computeBvgKapital(data.bvgGuthaben, data.bvgJahresbeitrag, yearsToRetirement);
  const bvgRente = Math.round((bvgKapital * 0.068) / 12); // BVG Umwandlungssatz 6.8%

  const pillar3aTotal = data.pillar3aAccounts.reduce((sum, a) => sum + a.balance, 0);

  function updateAccount(idx: number, partial: Partial<Pillar3aAccount>) {
    const next = data.pillar3aAccounts.map((a, i) => (i === idx ? { ...a, ...partial } : a));
    update({ pillar3aAccounts: next });
  }

  function addAccount() {
    update({
      pillar3aAccounts: [
        ...data.pillar3aAccounts,
        { provider: "", balance: 0, annualContribution: 7_056, strategy: "funds" },
      ],
    });
  }

  function removeAccount(idx: number) {
    update({ pillar3aAccounts: data.pillar3aAccounts.filter((_, i) => i !== idx) });
  }

  return (
    <div className="space-y-7">
      <div>
        <h2 className="text-text-primary font-semibold text-lg">Vorsorge — 3 Säulen</h2>
        <p className="text-text-secondary text-sm mt-1">
          Erfasse deine Vorsorgesituation für eine vollständige Rentenprojektion.
        </p>
      </div>

      {/* ── Säule 1: AHV ─── */}
      <div className="card">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-7 h-7 rounded-lg bg-red-500/15 flex items-center justify-center shrink-0">
            <ShieldCheck className="w-4 h-4 text-red-400" />
          </div>
          <h3 className="text-text-primary font-medium text-sm">Säule 1 — AHV / IV</h3>
        </div>

        <div className="space-y-4">
          <Field label="AHV-Beitragsjahre bisher">
            <Slider
              value={data.ahvBeitragsjahre}
              min={0}
              max={44}
              onChange={(v) => update({ ahvBeitragsjahre: v })}
              format={(v) => `${v} Jahre`}
            />
          </Field>

          <Field
            label="Durchschnittlicher Jahreslohn (für AHV-Berechnung)"
            hint="Massgebend für die Rentenhöhe — aus dem AHV-Auszug"
          >
            <ChfInput
              value={data.ahvDurchschnittsLohn}
              onChange={(v) => update({ ahvDurchschnittsLohn: v })}
            />
          </Field>

          <div className="bg-white/3 rounded-xl p-3 flex items-center justify-between">
            <div>
              <p className="text-text-tertiary text-xs">Geschätzte AHV-Rente</p>
              <p className="text-text-primary font-mono font-semibold text-xl mt-0.5">{chf(ahvRente)}</p>
              <p className="text-text-tertiary text-xs mt-0.5">pro Monat bei Rentenalter 65</p>
            </div>
            <div className="text-right">
              <p className="text-text-tertiary text-xs">Vollständig bei</p>
              <p className="text-text-secondary text-sm font-medium">44 Beitragsjahren</p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Säule 2: BVG ─── */}
      <div className="card">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-7 h-7 rounded-lg bg-blue-500/15 flex items-center justify-center shrink-0">
            <Building2 className="w-4 h-4 text-blue-400" />
          </div>
          <h3 className="text-text-primary font-medium text-sm">Säule 2 — BVG / Pensionskasse</h3>
        </div>

        <div className="space-y-4">
          <Field label="Aktuelles BVG-Guthaben" hint="Aus dem letzten Pensionskassen-Ausweis">
            <ChfInput value={data.bvgGuthaben} onChange={(v) => update({ bvgGuthaben: v })} />
          </Field>

          <Field label="Jährlicher Sparbeitrag (Arbeitnehmer + Arbeitgeber)">
            <ChfInput value={data.bvgJahresbeitrag} onChange={(v) => update({ bvgJahresbeitrag: v })} />
          </Field>

          <Field label="Geplantes Rentenalter">
            <Slider
              value={data.bvgRentenalter}
              min={63}
              max={70}
              onChange={(v) => update({ bvgRentenalter: v })}
              format={(v) => `${v} Jahre`}
            />
          </Field>

          <div className="bg-white/3 rounded-xl p-3 grid grid-cols-2 gap-4">
            <div>
              <p className="text-text-tertiary text-xs">Kapital bei {data.bvgRentenalter}</p>
              <p className="text-accent font-mono font-semibold text-lg mt-0.5">{chf(bvgKapital)}</p>
            </div>
            <div>
              <p className="text-text-tertiary text-xs">Geschätzte BVG-Rente</p>
              <p className="text-text-primary font-mono font-semibold text-lg mt-0.5">{chf(bvgRente)}/Mo</p>
              <p className="text-text-tertiary text-xs">Umwandlungssatz 6.8%</p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Säule 3a ─── */}
      <div className="card">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-7 h-7 rounded-lg bg-green-500/15 flex items-center justify-center shrink-0">
            <Banknote className="w-4 h-4 text-green-400" />
          </div>
          <h3 className="text-text-primary font-medium text-sm">Säule 3a — Gebundene Vorsorge</h3>
        </div>

        <div className="space-y-3">
          {data.pillar3aAccounts.map((acc, idx) => (
            <div key={idx} className="border border-white/8 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-text-primary text-sm font-medium">Konto {idx + 1}</p>
                {idx > 0 && (
                  <button
                    type="button"
                    className="text-loss text-xs hover:text-loss/80"
                    onClick={() => removeAccount(idx)}
                  >
                    Entfernen
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Anbieter">
                  <input
                    type="text"
                    className="input"
                    placeholder="z.B. VIAC, Frankly, PostFinance"
                    value={acc.provider}
                    onChange={(e) => updateAccount(idx, { provider: e.target.value })}
                  />
                </Field>
                <Field label="Aktuelles Guthaben">
                  <ChfInput value={acc.balance} onChange={(v) => updateAccount(idx, { balance: v })} />
                </Field>
                <Field label="Jahresbeitrag">
                  <ChfInput
                    value={acc.annualContribution}
                    onChange={(v) => updateAccount(idx, { annualContribution: v })}
                  />
                </Field>
                <Field label="Strategie">
                  <select
                    className="input"
                    value={acc.strategy}
                    onChange={(e) => updateAccount(idx, { strategy: e.target.value as "interest" | "funds" })}
                  >
                    <option value="interest">Zinssparen (konservativ)</option>
                    <option value="funds">Fondssparen (Aktien)</option>
                  </select>
                </Field>
              </div>
            </div>
          ))}

          {data.pillar3aAccounts.length < 5 && (
            <button
              type="button"
              className="btn-secondary w-full py-2 text-sm"
              onClick={addAccount}
            >
              + Weiteres 3a-Konto hinzufügen
            </button>
          )}

          <div className="flex items-start gap-2 p-3 rounded-lg bg-gain/5 border border-gain/15">
            <ShieldCheck className="w-4 h-4 text-gain shrink-0 mt-0.5" />
            <p className="text-text-secondary text-xs leading-relaxed">
              <strong className="text-gain">Steueroptimierung:</strong> Gestaffelte Bezüge auf mehrere 3a-Konten
              empfohlen — spart erhebliche Kapitalleistungssteuer. Verteile auf 3–5 Konten.
            </p>
          </div>

          {pillar3aTotal > 0 && (
            <div className="flex items-center justify-between text-sm pt-1">
              <span className="text-text-secondary">Total 3a-Guthaben</span>
              <span className="font-mono font-semibold text-text-primary">{chf(pillar3aTotal)}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Lebensversicherung ─── */}
      <ToggleCard
        enabled={data.hasLifeInsurance}
        onToggle={() => update({ hasLifeInsurance: !data.hasLifeInsurance })}
        icon="🛡️"
        label="Lebensversicherung"
        sublabel="Kapital-, Risiko- oder gemischte Police"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 mt-2">
          <Field label="Typ">
            <select
              className="input"
              value={data.lifeInsuranceType}
              onChange={(e) => update({ lifeInsuranceType: e.target.value as "kapital" | "risiko" | "gemischt" })}
            >
              <option value="kapital">Kapitalversicherung</option>
              <option value="risiko">Risikoversicherung</option>
              <option value="gemischt">Gemischte Police</option>
            </select>
          </Field>
          <Field label="Ablaufdatum">
            <input
              type="date"
              className="input"
              value={data.lifeInsuranceAblauf}
              onChange={(e) => update({ lifeInsuranceAblauf: e.target.value })}
            />
          </Field>
          <Field label="Ablaufleistung / Versicherungssumme">
            <ChfInput
              value={data.lifeInsuranceLeistung}
              onChange={(v) => update({ lifeInsuranceLeistung: v })}
            />
          </Field>
        </div>
      </ToggleCard>
    </div>
  );
}

// ── Step 8: Finanzplan-Ziele ───────────────────────────────────

function Step8({ data, update }: { data: WizardData; update: (p: Partial<WizardData>) => void }) {
  const SCENARIOS = [
    { key: "scenarioMortgage" as const, icon: "📉", label: "Hypothek amortisieren", sub: "Planmässige Schuldenreduktion bis zur Pensionierung" },
    { key: "scenarioSavings" as const, icon: "💰", label: "Sparplan erhöhen", sub: "Optimierung der monatlichen Sparquote" },
    { key: "scenarioEarlyRetirement" as const, icon: "✈️", label: "Frühpensionierung (vor 65)", sub: "Analyse der Finanzierbarkeit einer Frühpensionierung" },
    { key: "scenarioCare" as const, icon: "🏥", label: "Pflegekosten einplanen (ab 80)", sub: "Szenario für Pflegebedarf im hohen Alter" },
  ];

  return (
    <div className="space-y-7">
      <div>
        <h2 className="text-text-primary font-semibold text-lg">Finanzplan-Ziele</h2>
        <p className="text-text-secondary text-sm mt-1">
          Definiere deine Ziele für die Finanzplanung und Rentenprojektion.
        </p>
      </div>

      <Section title="Rentenplanung">
        <Field label="Ziel-Rentenalter">
          <Slider
            value={data.zielRentenalter}
            min={60}
            max={70}
            onChange={(v) => update({ zielRentenalter: v })}
            format={(v) => `${v} Jahre`}
          />
        </Field>

        <Field label="Lebenserwartung für Planung" hint="Konservativ: höher ansetzen vermindert Langlebigkeitsrisiko">
          <Slider
            value={data.lebenserwartung}
            min={70}
            max={100}
            onChange={(v) => update({ lebenserwartung: v })}
            format={(v) => `${v} Jahre`}
          />
        </Field>

        <Field label="Lebensstil im Alter (% des jetzigen Nettoeinkommens)">
          <Slider
            value={data.lifestylePercent}
            min={50}
            max={120}
            step={5}
            onChange={(v) => update({ lifestylePercent: v })}
            format={(v) => `${v}%`}
          />
        </Field>
      </Section>

      <Section title="Szenarien aktivieren">
        <div className="space-y-2.5">
          {SCENARIOS.map((sc) => (
            <button
              key={sc.key}
              type="button"
              className={clsx(
                "w-full rounded-xl border p-4 text-left transition-all duration-150",
                data[sc.key]
                  ? "border-accent/40 bg-accent/8"
                  : "border-white/8 hover:border-white/15"
              )}
              onClick={() => update({ [sc.key]: !data[sc.key] })}
            >
              <div className="flex items-start gap-3">
                <span className="text-xl shrink-0">{sc.icon}</span>
                <div className="flex-1">
                  <p className={clsx("text-sm font-medium", data[sc.key] ? "text-accent" : "text-text-primary")}>
                    {sc.label}
                  </p>
                  <p className="text-text-tertiary text-xs mt-0.5">{sc.sub}</p>
                </div>
                <div className={clsx(
                  "w-5 h-5 rounded border-2 shrink-0 flex items-center justify-center mt-0.5",
                  data[sc.key] ? "bg-accent border-accent" : "border-white/25"
                )}>
                  {data[sc.key] && <Check className="w-3 h-3 text-white" />}
                </div>
              </div>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Inflationsannahme">
        <Field
          label="Jährliche Inflation"
          hint="Historischer CH-Durchschnitt: ~1.0–2.0%. SNB-Ziel: <2%"
        >
          <Slider
            value={data.inflation}
            min={0.5}
            max={5}
            step={0.1}
            onChange={(v) => update({ inflation: v })}
            format={(v) => `${v.toFixed(1)}%`}
          />
        </Field>
      </Section>
    </div>
  );
}

// ── Review Screen ──────────────────────────────────────────────

function ReviewScreen({
  data,
  onSubmit,
  isSubmitting,
}: {
  data: WizardData;
  onSubmit: () => void;
  isSubmitting: boolean;
}) {
  const netto = computeNettoEinkommen(data);
  const age = new Date().getFullYear() - data.geburtsjahr;
  const yearsToRetirement = Math.max(data.zielRentenalter - age, 0);
  const ahvRente = computeAhvRente(data.ahvBeitragsjahre, data.ahvDurchschnittsLohn);
  const bvgKapital = computeBvgKapital(data.bvgGuthaben, data.bvgJahresbeitrag, yearsToRetirement);
  const bvgRente = Math.round((bvgKapital * 0.068) / 12);
  const pillar3aTotal = data.pillar3aAccounts.reduce((sum, a) => sum + a.balance, 0);

  const subscriptionTotal = COMMON_SUBSCRIPTIONS
    .filter((s) => data.selectedSubscriptions.includes(s.name))
    .reduce((sum, s) => sum + s.price, 0);

  const monthlyExpenses =
    (data.housingMode === "miete" ? data.monthlyRent + data.nebenkosten : data.monthlyAmortization) +
    data.groceries +
    data.freizeit +
    subscriptionTotal +
    data.healthInsurancePerPerson;

  const totalAssets =
    (data.bankEnabled ? data.bankBalance : 0) +
    (data.stocksEnabled ? data.stocksValue : 0) +
    (data.propertyAssetEnabled ? data.propertyAssetValue - data.propertyAssetDebt : 0) +
    (data.cryptoEnabled ? data.cryptoValue : 0) +
    (data.otherAssetsEnabled ? data.otherAssetsValue : 0);

  return (
    <div className="space-y-7">
      <div className="text-center space-y-2">
        <div className="w-14 h-14 rounded-2xl bg-gain/15 border border-gain/30 flex items-center justify-center mx-auto">
          <Check className="w-7 h-7 text-gain" />
        </div>
        <h2 className="text-text-primary font-semibold text-xl">
          {data.vorname ? `Fast fertig, ${data.vorname}!` : "Zusammenfassung"}
        </h2>
        <p className="text-text-secondary text-sm max-w-sm mx-auto">
          Überprüfe deine Angaben und erstelle deinen persönlichen Finanzplan.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <SummaryCard label="Nettoeinkommen" value={`${chf(netto)}/Mo`} sub="Geschätzt nach Abzügen" />
        <SummaryCard label="Monatl. Ausgaben" value={chf(monthlyExpenses)} sub="Fixe + variable Kosten" />
        <SummaryCard
          label="Sparquote"
          value={netto > 0 ? `${Math.round(((netto - monthlyExpenses) / netto) * 100)}%` : "—"}
          sub="Netto-Sparrate"
        />
        <SummaryCard label="Gesamtvermögen" value={chf(totalAssets)} sub="Eigenkapital (Net Worth)" />
        <SummaryCard label="3a-Guthaben" value={chf(pillar3aTotal)} sub="Säule 3a total" />
        <SummaryCard
          label="Rente bei {age}"
          value={chf(ahvRente + bvgRente)}
          sub={`AHV ${chf(ahvRente)} + BVG ${chf(bvgRente)}`}
        />
      </div>

      <div className="card border-accent/20 bg-accent/5">
        <h4 className="text-text-primary font-medium text-sm mb-3">Aktivierte Szenarien</h4>
        <div className="flex flex-wrap gap-2">
          {data.scenarioMortgage && (
            <span className="badge bg-accent/15 text-accent">📉 Hypothek amortisieren</span>
          )}
          {data.scenarioSavings && (
            <span className="badge bg-accent/15 text-accent">💰 Sparplan erhöhen</span>
          )}
          {data.scenarioEarlyRetirement && (
            <span className="badge bg-accent/15 text-accent">✈️ Frühpensionierung</span>
          )}
          {data.scenarioCare && (
            <span className="badge bg-accent/15 text-accent">🏥 Pflegekosten</span>
          )}
          {!data.scenarioMortgage && !data.scenarioSavings && !data.scenarioEarlyRetirement && !data.scenarioCare && (
            <span className="text-text-tertiary text-xs">Keine Szenarien ausgewählt</span>
          )}
        </div>
      </div>

      <button
        type="button"
        className="btn-primary w-full py-4 text-base font-semibold flex items-center justify-center gap-2"
        onClick={onSubmit}
        disabled={isSubmitting}
      >
        {isSubmitting ? (
          <>
            <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
            Finanzplan wird erstellt…
          </>
        ) : (
          <>
            <ArrowRight className="w-5 h-5" />
            Finanzplan erstellen
          </>
        )}
      </button>

      <p className="text-text-tertiary text-xs text-center leading-relaxed px-4">
        Deine Daten werden verschlüsselt gespeichert und nur zur Berechnung deines persönlichen
        Finanzplans verwendet. BudgetPal gibt keine Daten an Dritte weiter.
        Diese Angaben ersetzen keine professionelle Finanzberatung.
      </p>
    </div>
  );
}

// ── Main Wizard ────────────────────────────────────────────────

const TOTAL_STEPS = 8;

export default function Wizard() {
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState(1);
  const [wizardData, setWizardData] = useState<WizardData>(DEFAULT_WIZARD_DATA);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [animating, setAnimating] = useState(false);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [isReview, setIsReview] = useState(false);

  const update = useCallback((partial: Partial<WizardData>) => {
    setWizardData((prev) => ({ ...prev, ...partial }));
  }, []);

  function canGoNext(): boolean {
    if (currentStep === 1) return wizardData.vorname.trim().length > 0;
    return true;
  }

  async function goNext() {
    if (!canGoNext()) return;
    setDirection("forward");
    setAnimating(true);
    await new Promise((r) => setTimeout(r, 180));
    if (currentStep === TOTAL_STEPS) {
      setIsReview(true);
    } else {
      setCurrentStep((s) => s + 1);
    }
    setAnimating(false);
  }

  async function goBack() {
    setDirection("back");
    setAnimating(true);
    await new Promise((r) => setTimeout(r, 180));
    if (isReview) {
      setIsReview(false);
    } else {
      setCurrentStep((s) => Math.max(1, s - 1));
    }
    setAnimating(false);
  }

  async function handleSubmit() {
    setIsSubmitting(true);
    try {
      const subscriptionTotal = COMMON_SUBSCRIPTIONS
        .filter((s) => wizardData.selectedSubscriptions.includes(s.name))
        .reduce((sum, s) => sum + s.price, 0);

      await api.post("/wizard/complete", {
        ...wizardData,
        estimated_netto_monthly: computeNettoEinkommen(wizardData),
        subscription_total: subscriptionTotal,
      });
      navigate("/");
    } catch (err) {
      console.error("Wizard submit failed:", err);
      setIsSubmitting(false);
    }
  }

  const stepComponents: Record<number, React.ReactNode> = {
    1: <Step1 data={wizardData} update={update} />,
    2: <Step2 data={wizardData} update={update} />,
    3: <Step3 data={wizardData} update={update} />,
    4: <Step4 data={wizardData} update={update} />,
    5: <Step5AccordionExpenses data={wizardData} update={update} />,
    6: <Step6 data={wizardData} update={update} />,
    7: <Step7 data={wizardData} update={update} />,
    8: <Step8 data={wizardData} update={update} />,
  };

  return (
    <div className="min-h-screen bg-bg flex flex-col">
      {/* ── Top bar ────────────────────────────── */}
      <header className="sticky top-0 z-10 bg-bg/95 backdrop-blur border-b border-border/50 px-4 py-3">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-accent/40 to-accent/15 flex items-center justify-center">
              <BarChart3 className="w-4 h-4 text-accent" />
            </div>
            <span className="font-display font-semibold text-text-primary text-sm">
              Budget<span className="text-accent">Pal</span>
            </span>
            {!isReview && (
              <span className="ml-auto text-text-tertiary text-xs">Setup-Assistent</span>
            )}
          </div>

          {!isReview && (
            <StepIndicator currentStep={currentStep} totalSteps={TOTAL_STEPS} />
          )}

          {/* Progress bar */}
          <div className="h-1 bg-white/5 rounded-full mt-3 overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-all duration-500 ease-out"
              style={{
                width: isReview
                  ? "100%"
                  : `${((currentStep - 1) / TOTAL_STEPS) * 100}%`,
              }}
            />
          </div>
        </div>
      </header>

      {/* ── Content ────────────────────────────── */}
      <main className="flex-1 px-4 py-8">
        <div className="max-w-2xl mx-auto">
          <div
            className={clsx(
              "transition-all duration-200",
              animating
                ? direction === "forward"
                  ? "opacity-0 translate-x-4"
                  : "opacity-0 -translate-x-4"
                : "opacity-100 translate-x-0"
            )}
          >
            {isReview ? (
              <ReviewScreen
                data={wizardData}
                onSubmit={handleSubmit}
                isSubmitting={isSubmitting}
              />
            ) : (
              stepComponents[currentStep]
            )}
          </div>
        </div>
      </main>

      {/* ── Navigation ─────────────────────────── */}
      {!isReview && (
        <nav className="sticky bottom-0 bg-bg/95 backdrop-blur border-t border-border/50 px-4 py-3">
          <div className="max-w-2xl mx-auto flex items-center gap-3">
            {currentStep > 1 ? (
              <button
                type="button"
                className="btn-secondary flex items-center gap-1.5"
                onClick={goBack}
                disabled={animating}
              >
                <ChevronLeft className="w-4 h-4" />
                Zurück
              </button>
            ) : (
              <div />
            )}

            <div className="flex-1" />

            {/* Optional skip for steps 3, 6, 7 */}
            {(currentStep === 3 || currentStep === 6 || currentStep === 7) && (
              <button
                type="button"
                className="btn-ghost text-sm"
                onClick={goNext}
                disabled={animating}
              >
                Überspringen
              </button>
            )}

            <button
              type="button"
              className={clsx(
                "btn-primary flex items-center gap-1.5",
                !canGoNext() && "opacity-50 cursor-not-allowed"
              )}
              onClick={goNext}
              disabled={animating || !canGoNext()}
            >
              {currentStep === TOTAL_STEPS ? (
                <>Weiter zur Übersicht <ArrowRight className="w-4 h-4" /></>
              ) : (
                <>Weiter <ChevronRight className="w-4 h-4" /></>
              )}
            </button>
          </div>
        </nav>
      )}

      {isReview && !isSubmitting && (
        <nav className="sticky bottom-0 bg-bg/95 backdrop-blur border-t border-border/50 px-4 py-3">
          <div className="max-w-2xl mx-auto">
            <button
              type="button"
              className="btn-ghost flex items-center gap-1.5 text-sm"
              onClick={goBack}
            >
              <ChevronLeft className="w-4 h-4" />
              Zurück zu den Zielen
            </button>
          </div>
        </nav>
      )}

      {/* Slider thumb styling */}
      <style>{`
        input[type=range]::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: var(--accent);
          border: 2px solid var(--bg);
          cursor: pointer;
          box-shadow: 0 0 0 1px var(--accent);
        }
        input[type=range]::-moz-range-thumb {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: var(--accent);
          border: 2px solid var(--bg);
          cursor: pointer;
        }
      `}</style>
    </div>
  );
}
