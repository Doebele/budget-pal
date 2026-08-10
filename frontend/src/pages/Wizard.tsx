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
import { Airplane, ArrowRight, Bank, BitcoinCircle, Building, Car, Cash, Check, Coins, Community, Globe, GraphDown, GraphUp, Group, Heart, Home, Laptop, NavArrowLeft, NavArrowRight, OpenBook, PiggyBank, Reports, ShieldCheck, Shuffle, Sofa, StatsReport, Suitcase, Train, Trash, User, UserXmark, Wallet } from "@/lib/icons";
import { clsx } from "clsx";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { DEFAULT_SARON_REFERENCE_ANNUAL_PCT } from "@/lib/saron";
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
import { useTranslation } from "react-i18next";

// ── Wizard data shape ──────────────────────────────────────────

interface Pillar3aAccount {
  provider: string;
  balance: number;
  annualContribution: number;
  strategy: "interest" | "funds";
}

interface MortgageEntry {
  debtValue: number;
  mortgageType: "fix" | "saron";
  mortgageRate: number;
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
  healthInsuranceMode: "person" | "total";
  /** Eine Prämie je versicherter Person (nur im Modus "person"). */
  healthInsurancePremiums: number[];
  franchise: 300 | 500 | 1000 | 1500 | 2000 | 2500;
  zusatzversicherung: number;
  hausrat: number;
  autoversicherung: number;
  autoversicherungPeriod: "monat" | "jahr";
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
  mortgageEntries: MortgageEntry[];
  mortgageType: "fix" | "saron";
  mortgageRate: number;
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
  healthInsuranceMode: "person",
  healthInsurancePremiums: [],
  franchise: 300,
  zusatzversicherung: 0,
  hausrat: 70,
  autoversicherung: 0,
  autoversicherungPeriod: "monat",
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
  mortgageEntries: [{ debtValue: 0, mortgageType: "fix", mortgageRate: 1.8 }],
  mortgageType: "fix",
  mortgageRate: 1.8,
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

/** Hypothekarzins pro Monat aus den Tranchen (Schritt 6) — ohne Amortisation. */
function mortgageInterestMonthly(data: WizardData): number {
  const tranches = (data.mortgageEntries ?? []).filter((m) => (m.debtValue || 0) > 0);
  const annual = tranches.length
    ? tranches.reduce((sum, m) => sum + m.debtValue * (m.mortgageRate || 0) / 100, 0)
    : (data.outstandingDebt || 0) * (data.mortgageRate || 0) / 100;
  return annual / 12;
}

/** Prämien je Person — leere Liste fällt auf den Einzelbetrag zurück (Altdaten). */
function healthPremiums(data: WizardData): number[] {
  const list = data.healthInsurancePremiums ?? [];
  return list.length ? list : [data.healthInsurancePerPerson || 0];
}

/** Krankenkassenprämie des Haushalts pro Monat. */
function healthInsuranceMonthly(data: WizardData): number {
  if (data.healthInsuranceMode === "total") return data.healthInsurancePerPerson;
  return healthPremiums(data).reduce((sum, p) => sum + (p || 0), 0);
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

// ── Segmented switch ───────────────────────────────────────────

/** Toggle-Leiste im Stil der Rail-Umschalter (Sprache/Dichte). */
function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string; Icon?: React.ComponentType<{ className?: string }> }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg-row">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.label}
          className={clsx("seg-btn", value === o.value && "active")}
          onClick={() => onChange(o.value)}
        >
          {o.Icon && <o.Icon className="w-4 h-4 shrink-0" />}
          <span>{o.label}</span>
        </button>
      ))}
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
  icon: React.ReactNode;
  label: string;
  sublabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={clsx(
      "rounded-md border transition-all duration-200 overflow-hidden",
      enabled ? "border-accent/40 bg-accent/5" : "border-white/8 bg-white/2"
    )}>
      <button
        type="button"
        className="w-full flex items-center gap-3 p-4 text-left"
        onClick={onToggle}
      >
        <div className="w-8 h-8 rounded-sm bg-white/5 flex items-center justify-center shrink-0">
          {icon}
        </div>
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
  const { t } = useTranslation();
  const HAUSHALT_OPTIONS: { value: WizardData["haushalt"]; label: string; Icon: React.ComponentType<{ className?: string }> }[] = [
    { value: "single",        label: t("pages:wizard.w300"),   Icon: User },
    { value: "couple",        label: t("pages:wizard.w301"),            Icon: Group },
    { value: "family",        label: t("pages:wizard.w302"),         Icon: Community },
    { value: "single-parent", label: t("pages:wizard.w303"), Icon: UserXmark },
  ];
  const BESCHAEFTIGUNG_OPTIONS: { value: WizardData["beschaeftigung"]; label: string; Icon: React.ComponentType<{ className?: string }> }[] = [
    { value: "employed",      label: t("pages:wizard.w304"),  Icon: Suitcase },
    { value: "self-employed", label: t("pages:wizard.w17"), Icon: Laptop },
    { value: "mixed",         label: t("pages:wizard.w305"),      Icon: Shuffle },
    { value: "retired",       label: t("pages:wizard.w306"), Icon: Sofa },
  ];

  return (
    <div className="space-y-8">
      <div className="text-center space-y-3">
        <div className="w-16 h-16 rounded-lg bg-gradient-to-br from-accent/30 to-accent/10 border border-accent/30 flex items-center justify-center mx-auto">
          <Reports className="w-8 h-8 text-accent" />
        </div>
        <div>
          <h1 className="text-2xl font-display font-semibold text-text-primary">
            {t("pages:wizard.w183")}<span className="text-accent">Pal</span>
          </h1>
          <p className="text-text-secondary text-sm mt-1.5 max-w-sm mx-auto leading-relaxed">
            {t("pages:wizard.w184")}
          </p>
        </div>
      </div>

      <Section title={t("pages:wizard.w18")}>
        <Field label={t("pages:wizard.w166")}>
          <input
            type="text"
            className="input"
            placeholder={t("pages:wizard.w173")}
            value={data.vorname}
            onChange={(e) => update({ vorname: e.target.value })}
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label={t("pages:wizard.w126")}>
            <input
              type="number"
              className="input"
              min={1940}
              max={2010}
              value={data.geburtsjahr}
              onChange={(e) => update({ geburtsjahr: parseInt(e.target.value) || 1985 })}
            />
          </Field>
          <Field label={t("pages:wizard.w139")}>
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

      <Section title={t("pages:wizard.w131")}>
        <div className="seg-row">
          {HAUSHALT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              title={opt.label}
              className={clsx("seg-btn", data.haushalt === opt.value && "active")}
              onClick={() => update({ haushalt: opt.value })}
            >
              <opt.Icon className="w-4 h-4 shrink-0" />
              <span>{opt.label}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section title={t("pages:wizard.w19")}>
        <div className="seg-row">
          {BESCHAEFTIGUNG_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              title={opt.label}
              className={clsx("seg-btn", data.beschaeftigung === opt.value && "active")}
              onClick={() => update({ beschaeftigung: opt.value })}
            >
              <opt.Icon className="w-4 h-4 shrink-0" />
              <span>{opt.label}</span>
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}

// ── Step 2: Einkommen ──────────────────────────────────────────

function Step2({ data, update }: { data: WizardData; update: (p: Partial<WizardData>) => void }) {
  const { t } = useTranslation();
  const netto = computeNettoEinkommen(data);

  const INCOME_SOURCES = [
    {
      icon: <Suitcase className="w-4 h-4 text-text-tertiary" />, label: "Lohn / Gehalt (brutto)", sublabel: "Monatlich",
      enabledKey: "lohnEnabled" as const, valueKey: "lohn" as const,
      show: true,
    },
    {
      icon: <Building className="w-4 h-4 text-text-tertiary" />, label: t("pages:wizard.w20"), sublabel: t("pages:wizard.w21"),
      enabledKey: "selbstaendigEnabled" as const, valueKey: "selbstaendig" as const,
      show: true,
    },
    {
      icon: <GraphUp className="w-4 h-4 text-text-tertiary" />, label: t("pages:wizard.w22"), sublabel: t("pages:wizard.w21"),
      enabledKey: "dividendenEnabled" as const, valueKey: "dividenden" as const,
      show: true,
    },
    {
      icon: <Home className="w-4 h-4 text-text-tertiary" />, label: "Mieteinnahmen", sublabel: "Monatlich netto",
      enabledKey: "mieteinnahmenEnabled" as const, valueKey: "mieteinnahmen" as const,
      show: true,
    },
    {
      icon: <Globe className="w-4 h-4 text-text-tertiary" />, label: "Auslandeinkommen", sublabel: t("pages:wizard.w23"),
      enabledKey: "auslandeinkommenEnabled" as const, valueKey: "auslandeinkommen" as const,
      show: true,
    },
    {
      icon: <PiggyBank className="w-4 h-4 text-text-tertiary" />, label: "AHV / Rente", sublabel: t("pages:wizard.w24"),
      enabledKey: "ahvRenteEnabled" as const, valueKey: "ahvRente" as const,
      show: data.beschaeftigung === "retired",
    },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-text-primary font-semibold text-lg">{t("pages:wizard.w119")}</h2>
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
              <p className="text-text-tertiary text-xs uppercase tracking-wide">{t("pages:wizard.w00")}</p>
              <p className="text-gain font-mono font-semibold text-2xl mt-0.5">{chf(netto)}</p>
              <p className="text-text-tertiary text-xs mt-1">
                pro Monat — nach AHV/ALV-Abzügen und Steuerschätzung
              </p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-gain/15 flex items-center justify-center">
              <Cash className="w-5 h-5 text-gain" />
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
  const { t } = useTranslation();
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
    const applied = data.peerGroupDefaults ?? defaults;
    update({
      peerGroupDefaults: applied,
      peerGroupAccepted: true,
      monthlyRent: applied.housing,
      groceries: applied.groceries,
      freizeit: applied.dining_out + applied.entertainment,
    });
  }

  function handleAdjust(key: keyof PeerGroupDefaults, value: number) {
    const base = data.peerGroupDefaults ?? defaults;
    update({
      peerGroupDefaults: { ...base, [key]: value },
    });
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-text-primary font-semibold text-lg">{t("pages:wizard.w01")}</h2>
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
  const { t } = useTranslation();
  const FRANCHISE_OPTIONS = [300, 500, 1000, 1500, 2000, 2500] as const;

  return (
    <div className="space-y-7">
      <div>
        <h2 className="text-text-primary font-semibold text-lg">{t("pages:wizard.w168")}</h2>
        <p className="text-text-secondary text-sm mt-1">
          Gib deine monatlichen Wohn- und Versicherungskosten an.
        </p>
      </div>

      <Section title={t("pages:wizard.w169")}>
        <Segmented
          value={data.housingMode}
          options={[
            { value: "miete", label: "Miete", Icon: Home },
            { value: "hypothek", label: "Wohneigentum", Icon: Building },
          ] as const}
          onChange={(v) => update({ housingMode: v })}
        />

        {data.housingMode === "miete" ? (
          <div className="space-y-3">
            <Field label={t("pages:wizard.w25")}>
              <ChfInput value={data.monthlyRent} onChange={(v) => update({ monthlyRent: v })} />
            </Field>
            <Field label={t("pages:wizard.w147")}>
              <ChfInput value={data.nebenkosten} onChange={(v) => update({ nebenkosten: v })} />
            </Field>
          </div>
        ) : (
          <div className="space-y-3">
            <Field
              label={t("pages:wizard.w111")}
              hint={t("pages:wizard.w26")}
            >
              <ChfInput value={data.monthlyAmortization} onChange={(v) => update({ monthlyAmortization: v })} />
            </Field>
            <Field label={t("pages:wizard.w147")}>
              <ChfInput value={data.nebenkosten} onChange={(v) => update({ nebenkosten: v })} />
            </Field>
            <div className="rounded border border-white/8 px-3 py-2 text-xs text-text-secondary">
              Hypothekarzins:{" "}
              <span className="text-text-primary font-medium">
                {chf(Math.round(mortgageInterestMonthly(data)))}/Mo
              </span>{" "}
              — automatisch aus den Hypotheken in Schritt 6.
            </div>
          </div>
        )}
      </Section>

      <Section title={t("pages:wizard.w141")}>
        <Field label={t("pages:wizard.w120")}>
          <Segmented
            value={data.healthInsuranceMode}
            options={[
              { value: "person", label: "Pro Person" },
              { value: "total", label: "Total Haushalt" },
            ] as const}
            onChange={(v) => update({ healthInsuranceMode: v })}
          />
        </Field>

        {data.healthInsuranceMode === "total" ? (
          <Field label={t("pages:wizard.w152")} hint={t("pages:wizard.w130")}>
            <ChfInput
              value={data.healthInsurancePerPerson}
              onChange={(v) => update({ healthInsurancePerPerson: v })}
            />
          </Field>
        ) : (
          <Field
            label={t("pages:wizard.w153")}
            hint={`Grundversicherung Krankenkasse — Total: ${chf(
              Math.round(healthInsuranceMonthly(data))
            )}/Mo`}
          >
            <div className="space-y-2">
              {healthPremiums(data).map((premium, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-text-tertiary text-xs w-16 shrink-0">Person {i + 1}</span>
                  <ChfInput
                    className="flex-1"
                    value={premium}
                    onChange={(v) => {
                      const next = [...healthPremiums(data)];
                      next[i] = v;
                      update({ healthInsurancePremiums: next });
                    }}
                  />
                  <button
                    type="button"
                    className="text-text-tertiary hover:text-loss disabled:opacity-30 disabled:hover:text-text-tertiary p-1.5"
                    title={t("pages:wizard.w151")}
                    disabled={healthPremiums(data).length <= 1}
                    onClick={() =>
                      update({
                        healthInsurancePremiums: healthPremiums(data).filter((_, j) => j !== i),
                      })
                    }
                  >
                    <Trash className="w-4 h-4" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="text-accent text-xs font-medium hover:underline"
                onClick={() =>
                  update({ healthInsurancePremiums: [...healthPremiums(data), 0] })
                }
              >
                + Person hinzufügen
              </button>
            </div>
          </Field>
        )}

        <Field label={t("pages:wizard.w124")}>
          <Segmented
            value={data.franchise}
            options={FRANCHISE_OPTIONS.map((f) => ({ value: f, label: chf(f) }))}
            onChange={(v) => update({ franchise: v })}
          />
        </Field>

        <Field label={t("pages:wizard.w172")}>
          <ChfInput
            value={data.zusatzversicherung}
            onChange={(v) => update({ zusatzversicherung: v })}
            placeholder="0"
          />
        </Field>
      </Section>

      <Section title={t("pages:wizard.w167")}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t("pages:wizard.w132")}>
            <ChfInput value={data.hausrat} onChange={(v) => update({ hausrat: v })} />
          </Field>
          <div className="space-y-1.5">
            <label className="label">{t("pages:wizard.w116")}</label>
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
              <div className="space-y-1.5">
                <Segmented
                  value={data.autoversicherungPeriod}
                  options={[
                    { value: "monat", label: t("pages:wizard.w27") },
                    { value: "jahr", label: t("pages:wizard.w28") },
                  ] as const}
                  onChange={(v) => update({ autoversicherungPeriod: v })}
                />
                <ChfInput value={data.autoversicherung} onChange={(v) => update({ autoversicherung: v })} />
                {data.autoversicherungPeriod === "jahr" && data.autoversicherung > 0 && (
                  <p className="text-text-tertiary text-xs">
                    Entspricht {chf(Math.round(data.autoversicherung / 12))}/Mo im Budget.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </Section>
    </div>
  );
}

// ── Step 5: Alltag & Abonnements ──────────────────────────────

function Step5({ data, update }: { data: WizardData; update: (p: Partial<WizardData>) => void }) {
  const { t } = useTranslation();
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
        <h2 className="text-text-primary font-semibold text-lg">{t("pages:wizard.w110")}</h2>
        <p className="text-text-secondary text-sm mt-1">
          Konfiguriere deine monatlichen Alltagsausgaben.
        </p>
      </div>

      <Section title={t("pages:wizard.w142")}>
        <Field label={t("pages:wizard.w146")}>
          <ChfInput value={data.groceries} onChange={(v) => update({ groceries: v })} />
        </Field>
      </Section>

      <Section title={t("pages:wizard.w29")}>
        <div className="grid grid-cols-3 gap-2">
          {([
            { value: "ov", label: "Nur ÖV", icon: <Train className="w-4 h-4" /> },
            { value: "car", label: "Nur Auto", icon: <Car className="w-4 h-4" /> },
            { value: "both", label: t("pages:wizard.w305"), icon: null },
          ] as const).map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={clsx(
                "rounded border py-2.5 text-xs font-medium transition-all flex items-center justify-center gap-1.5",
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
            <p className="text-text-tertiary text-xs font-medium uppercase tracking-wide mt-3">{t("pages:wizard.w02")}</p>
            <div className="flex gap-2 flex-wrap">
              {[
                { key: "hasSbbHalbtax" as const, label: "SBB Halbtax", price: 19 },
                { key: "hasSbbGa" as const, label: "SBB GA 2. Kl.", price: 345 },
              ].map((abo) => (
                <button
                  key={abo.key}
                  type="button"
                  className={clsx(
                    "rounded border px-3 py-2 text-sm transition-all",
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
            <Field label={t("pages:wizard.w117")}>
              <ChfInput value={data.monthlyFuel} onChange={(v) => update({ monthlyFuel: v })} />
            </Field>
            <Field label={t("pages:wizard.w150")}>
              <ChfInput value={data.parking} onChange={(v) => update({ parking: v })} />
            </Field>
            <Field label={t("pages:wizard.w112")}>
              <ChfInput value={data.carAmortization} onChange={(v) => update({ carAmortization: v })} />
            </Field>
          </div>
        )}
      </Section>

      <Section title={t("pages:wizard.w104")}>
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
                        "w-full flex items-center justify-between rounded px-3 py-2 text-sm transition-all",
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
            <span className="text-text-secondary text-sm">{t("pages:wizard.w162")}</span>
            <span className="font-mono font-semibold text-text-primary">{chf(subscriptionTotal)}/Mo</span>
          </div>
        </div>
      </Section>

      <Section title={t("pages:wizard.w125")}>
        <Field label={t("pages:wizard.w155")}>
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
  const { t } = useTranslation();
  const { user } = useAuth();
  const saronRefPct = user?.saron_reference_annual_pct ?? DEFAULT_SARON_REFERENCE_ANNUAL_PCT;

  const totalAssets =
    (data.bankEnabled ? data.bankBalance : 0) +
    (data.stocksEnabled ? data.stocksValue : 0) +
    (data.propertyAssetEnabled ? data.propertyAssetValue : 0) +
    (data.cryptoEnabled ? data.cryptoValue : 0) +
    (data.otherAssetsEnabled ? data.otherAssetsValue : 0);

  const mortgageEntries = data.mortgageEntries.length > 0
    ? data.mortgageEntries
    : [{ debtValue: data.propertyAssetDebt, mortgageType: data.mortgageType, mortgageRate: data.mortgageRate }];

  function setMortgageEntries(next: MortgageEntry[]) {
    const cleaned: MortgageEntry[] = next.map((m) => ({
      debtValue: Math.max(0, Number(m.debtValue) || 0),
      mortgageType: m.mortgageType === "saron" ? "saron" : "fix",
      mortgageRate: Math.max(0, Number(m.mortgageRate) || 0),
    }));
    const totalDebt = cleaned.reduce((sum, m) => sum + m.debtValue, 0);
    update({
      mortgageEntries: cleaned,
      propertyAssetDebt: totalDebt,
      mortgageType: cleaned[0]?.mortgageType ?? data.mortgageType,
      mortgageRate: cleaned[0]?.mortgageRate ?? data.mortgageRate,
    });
  }

  function updateMortgageEntry(index: number, partial: Partial<MortgageEntry>) {
    const next = mortgageEntries.map((m, i) => (i === index ? { ...m, ...partial } : m));
    setMortgageEntries(next);
  }

  function addMortgageEntry() {
    setMortgageEntries([
      ...mortgageEntries,
      { debtValue: 0, mortgageType: "fix", mortgageRate: data.mortgageRate || 0 },
    ]);
  }

  function removeMortgageEntry(index: number) {
    const next = mortgageEntries.filter((_, i) => i !== index);
    setMortgageEntries(next.length > 0 ? next : [{ debtValue: 0, mortgageType: "fix", mortgageRate: data.mortgageRate || 0 }]);
  }

  const ASSETS = [
    {
      icon: <Bank className="w-4 h-4 text-text-tertiary" />,
      label: "Bankkonto / Sparkonto",
      sublabel: t("pages:wizard.w30"),
      enabledKey: "bankEnabled" as const,
      children: (
        <Field label={t("pages:wizard.w129")}>
          <ChfInput value={data.bankBalance} onChange={(v) => update({ bankBalance: v })} />
        </Field>
      ),
    },
    {
      icon: <StatsReport className="w-4 h-4 text-text-tertiary" />,
      label: "Aktien & ETFs",
      sublabel: "Aktueller Depotwert",
      enabledKey: "stocksEnabled" as const,
      children: (
        <>
          <Field label={t("pages:wizard.w106")}>
            <ChfInput value={data.stocksValue} onChange={(v) => update({ stocksValue: v })} />
          </Field>
          <p className="text-text-tertiary text-xs flex items-center gap-1.5 mt-1">
            <GraphUp className="w-3.5 h-3.5 text-accent" />
            Tipp: Du kannst später Daten aus Portfolio-Tracker importieren.
          </p>
        </>
      ),
    },
    {
      icon: <Building className="w-4 h-4 text-text-tertiary" />,
      label: "Immobilien",
      sublabel: t("pages:wizard.w31"),
      enabledKey: "propertyAssetEnabled" as const,
      children: (
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label={t("pages:wizard.w145")}>
              <ChfInput value={data.propertyAssetValue} onChange={(v) => update({ propertyAssetValue: v })} />
            </Field>
            <Field label={t("pages:wizard.w163")}>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary text-sm pointer-events-none">
                  CHF
                </span>
                <input
                  type="text"
                  readOnly
                  tabIndex={-1}
                  aria-readonly="true"
                  className="input pl-12 font-mono text-sm bg-white/5 text-text-primary cursor-default pointer-events-none"
                  value={chf(data.propertyAssetDebt)}
                />
              </div>
            </Field>
          </div>

          <div className="space-y-2">
            <p className="label">{t("pages:wizard.w135")}</p>

            <div className="space-y-2">
              {mortgageEntries.map((entry, idx) => (
                <div
                  key={idx}
                  className="rounded-md border border-white/10 bg-white/3 px-2 py-2 flex flex-wrap sm:flex-nowrap items-end gap-2"
                >
                  <span
                    className="text-text-tertiary text-[11px] tabular-nums shrink-0 pb-2 w-5 text-center sm:text-left"
                    title={`Hypothek ${idx + 1}`}
                  >
                    {idx + 1}
                  </span>

                  <div className="shrink-0 w-full sm:w-auto sm:min-w-[9.5rem]">
                    <label className="label text-[10px] leading-tight">{t("pages:wizard.w114")}</label>
                    <div className="flex rounded border border-white/10 overflow-hidden">
                      {(["fix", "saron"] as const).map((kind) => (
                        <button
                          key={kind}
                          type="button"
                          className={clsx(
                            "flex-1 py-1.5 px-2 text-xs font-medium transition-all",
                            entry.mortgageType === kind
                              ? "bg-accent/15 text-accent"
                              : "text-text-secondary hover:bg-white/5",
                          )}
                          onClick={() => {
                            if (kind === "saron") {
                              updateMortgageEntry(idx, {
                                mortgageType: "saron",
                                mortgageRate: saronRefPct,
                              });
                            } else {
                              updateMortgageEntry(idx, {
                                mortgageType: "fix",
                                mortgageRate:
                                  entry.mortgageType === "fix"
                                    ? entry.mortgageRate
                                    : data.mortgageRate || 1.8,
                              });
                            }
                          }}
                        >
                          {kind === "fix" ? "Fix" : "SARON"}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="shrink-0 w-full sm:w-24">
                    <label className="label text-[10px] leading-tight whitespace-nowrap">
                      Zinssatz % p.a.
                      {entry.mortgageType === "saron" && (
                        <span className="text-text-tertiary font-normal normal-case"> (SARON)</span>
                      )}
                    </label>
                    <div className="relative">
                      {entry.mortgageType === "fix" ? (
                        <>
                          <input
                            type="number"
                            min={0}
                            step={0.01}
                            className="input py-1.5 pr-7 text-sm"
                            value={entry.mortgageRate || ""}
                            onChange={(e) =>
                              updateMortgageEntry(idx, { mortgageRate: parseFloat(e.target.value) || 0 })
                            }
                            placeholder="1.8"
                          />
                          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary text-xs">%</span>
                        </>
                      ) : (
                        <>
                          <input
                            type="text"
                            readOnly
                            tabIndex={-1}
                            aria-readonly="true"
                            className="input py-1.5 pr-7 text-sm font-mono bg-white/5 text-text-primary cursor-default pointer-events-none"
                            value={saronRefPct.toFixed(2)}
                          />
                          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary text-xs">%</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex-1 min-w-[10rem]">
                    <label className="label text-[10px] leading-tight">{t("pages:wizard.w136")}</label>
                    <ChfInput
                      className="[&_input]:py-1.5 [&_input]:text-sm"
                      value={entry.debtValue}
                      onChange={(v) => updateMortgageEntry(idx, { debtValue: v })}
                    />
                  </div>

                  {mortgageEntries.length > 1 && (
                    <div className="flex justify-end sm:justify-start shrink-0 pb-0.5">
                      <button
                        type="button"
                        title={t("pages:wizard.w134")}
                        onClick={() => removeMortgageEntry(idx)}
                        className="p-2 rounded-md text-text-tertiary hover:text-loss hover:bg-loss/10 transition-colors"
                      >
                        <Trash className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={addMortgageEntry}
                className="text-xs rounded border border-accent/30 text-accent px-2 py-1 hover:bg-accent/10 transition-colors"
              >
                + Hypothek hinzufügen
              </button>
            </div>
          </div>
        </div>
      ),
    },
    {
      icon: <Coins className="w-4 h-4 text-text-tertiary" />,
      label: t("pages:wizard.w32"),
      sublabel: "Aktueller Marktwert (CHF)",
      enabledKey: "cryptoEnabled" as const,
      children: (
        <Field label={t("pages:wizard.w107")}>
          <ChfInput value={data.cryptoValue} onChange={(v) => update({ cryptoValue: v })} />
        </Field>
      ),
    },
    {
      icon: <Wallet className="w-4 h-4 text-text-tertiary" />,
      label: "Sonstige Anlagen",
      sublabel: "Obligationen, Fonds, Private Equity, etc.",
      enabledKey: "otherAssetsEnabled" as const,
      children: (
        <Field label={t("pages:wizard.w33")}>
          <ChfInput value={data.otherAssetsValue} onChange={(v) => update({ otherAssetsValue: v })} />
        </Field>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-text-primary font-semibold text-lg">{t("pages:wizard.w03")}</h2>
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
          <p className="text-text-tertiary text-xs uppercase tracking-wide">{t("pages:wizard.w04")}</p>
          <p className="text-text-primary font-mono font-bold text-2xl mt-1">{chf(totalAssets)}</p>
        </div>
      )}
    </div>
  );
}

// ── Step 7: Vorsorge ───────────────────────────────────────────

function Step7({ data, update }: { data: WizardData; update: (p: Partial<WizardData>) => void }) {
  const { t } = useTranslation();
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
        <h2 className="text-text-primary font-semibold text-lg">{t("pages:wizard.w05")}</h2>
        <p className="text-text-secondary text-sm mt-1">
          Erfasse deine Vorsorgesituation für eine vollständige Rentenprojektion.
        </p>
      </div>

      {/* ── Säule 1: AHV ─── */}
      <div className="card">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-7 h-7 rounded-sm bg-red-500/15 flex items-center justify-center shrink-0">
            <ShieldCheck className="w-4 h-4 text-red-400" />
          </div>
          <h3 className="text-text-primary font-medium text-sm">{t("pages:wizard.w06")}</h3>
        </div>

        <div className="space-y-4">
          <Field label={t("pages:wizard.w101")}>
            <Slider
              value={data.ahvBeitragsjahre}
              min={0}
              max={44}
              onChange={(v) => update({ ahvBeitragsjahre: v })}
              format={(v) => `${v} Jahre`}
            />
          </Field>

          <Field
            label={t("pages:wizard.w34")}
            hint={t("pages:wizard.w35")}
          >
            <ChfInput
              value={data.ahvDurchschnittsLohn}
              onChange={(v) => update({ ahvDurchschnittsLohn: v })}
            />
          </Field>

          <div className="bg-white/3 rounded-md p-3 flex items-center justify-between">
            <div>
              <p className="text-text-tertiary text-xs">{t("pages:wizard.w07")}</p>
              <p className="text-text-primary font-mono font-semibold text-xl mt-0.5">{chf(ahvRente)}</p>
              <p className="text-text-tertiary text-xs mt-0.5">{t("pages:wizard.w08")}</p>
            </div>
            <div className="text-right">
              <p className="text-text-tertiary text-xs">{t("pages:wizard.w09")}</p>
              <p className="text-text-secondary text-sm font-medium">44 Beitragsjahren</p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Säule 2: BVG ─── */}
      <div className="card">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-7 h-7 rounded-sm bg-blue-500/15 flex items-center justify-center shrink-0">
            <Building className="w-4 h-4 text-blue-400" />
          </div>
          <h3 className="text-text-primary font-medium text-sm">{t("pages:wizard.w10")}</h3>
        </div>

        <div className="space-y-4">
          <Field label={t("pages:wizard.w108")} hint={t("pages:wizard.w115")}>
            <ChfInput value={data.bvgGuthaben} onChange={(v) => update({ bvgGuthaben: v })} />
          </Field>

          <Field label={t("pages:wizard.w36")}>
            <ChfInput value={data.bvgJahresbeitrag} onChange={(v) => update({ bvgJahresbeitrag: v })} />
          </Field>

          <Field label={t("pages:wizard.w128")}>
            <Slider
              value={data.bvgRentenalter}
              min={63}
              max={70}
              onChange={(v) => update({ bvgRentenalter: v })}
              format={(v) => `${v} Jahre`}
            />
          </Field>

          <div className="bg-white/3 rounded-md p-3 grid grid-cols-2 gap-4">
            <div>
              <p className="text-text-tertiary text-xs">Kapital bei {data.bvgRentenalter}</p>
              <p className="text-accent font-mono font-semibold text-lg mt-0.5">{chf(bvgKapital)}</p>
            </div>
            <div>
              <p className="text-text-tertiary text-xs">{t("pages:wizard.w11")}</p>
              <p className="text-text-primary font-mono font-semibold text-lg mt-0.5">{chf(bvgRente)}/Mo</p>
              <p className="text-text-tertiary text-xs">{t("pages:wizard.w165")}</p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Säule 3a ─── */}
      <div className="card">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-7 h-7 rounded-sm bg-green-500/15 flex items-center justify-center shrink-0">
            <Cash className="w-4 h-4 text-green-400" />
          </div>
          <h3 className="text-text-primary font-medium text-sm">{t("pages:wizard.w12")}</h3>
        </div>

        <div className="space-y-3">
          {data.pillar3aAccounts.map((acc, idx) => (
            <div key={idx} className="border border-white/8 rounded-md p-4 space-y-3">
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
                <Field label={t("pages:wizard.w113")}>
                  <input
                    type="text"
                    className="input"
                    placeholder={t("pages:wizard.w174")}
                    value={acc.provider}
                    onChange={(e) => updateAccount(idx, { provider: e.target.value })}
                  />
                </Field>
                <Field label={t("pages:wizard.w109")}>
                  <ChfInput value={acc.balance} onChange={(v) => updateAccount(idx, { balance: v })} />
                </Field>
                <Field label={t("pages:wizard.w138")}>
                  <ChfInput
                    value={acc.annualContribution}
                    onChange={(v) => updateAccount(idx, { annualContribution: v })}
                  />
                </Field>
                <Field label={t("pages:wizard.w159")}>
                  <select
                    className="input"
                    value={acc.strategy}
                    onChange={(e) => updateAccount(idx, { strategy: e.target.value as "interest" | "funds" })}
                  >
                    <option value="interest">{t("pages:wizard.w171")}</option>
                    <option value="funds">{t("pages:wizard.w123")}</option>
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
              {t("pages:wizard.w401")}
            </button>
          )}

          <div className="flex items-start gap-2 p-3 rounded-md bg-gain/5 border border-gain/15">
            <ShieldCheck className="w-4 h-4 text-gain shrink-0 mt-0.5" />
            <p className="text-text-secondary text-xs leading-relaxed">
              <strong className="text-gain">{t("pages:wizard.w158")}</strong> Gestaffelte Bezüge auf mehrere 3a-Konten
              empfohlen — spart erhebliche Kapitalleistungssteuer. Verteile auf 3–5 Konten.
            </p>
          </div>

          {pillar3aTotal > 0 && (
            <div className="flex items-center justify-between text-sm pt-1">
              <span className="text-text-secondary">{t("pages:wizard.w161")}</span>
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
        label={t("pages:wizard.w144")}
        sublabel={t("pages:wizard.w37")}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 mt-2">
          <Field label={t("pages:wizard.w164")}>
            <select
              className="input"
              value={data.lifeInsuranceType}
              onChange={(e) => update({ lifeInsuranceType: e.target.value as "kapital" | "risiko" | "gemischt" })}
            >
              <option value="kapital">{t("pages:wizard.w140")}</option>
              <option value="risiko">{t("pages:wizard.w156")}</option>
              <option value="gemischt">{t("pages:wizard.w127")}</option>
            </select>
          </Field>
          <Field label={t("pages:wizard.w102")}>
            <input
              type="date"
              className="input"
              value={data.lifeInsuranceAblauf}
              onChange={(e) => update({ lifeInsuranceAblauf: e.target.value })}
            />
          </Field>
          <Field label={t("pages:wizard.w103")}>
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
  const { t } = useTranslation();
  const SCENARIOS: { key: "scenarioMortgage" | "scenarioSavings" | "scenarioEarlyRetirement" | "scenarioCare"; icon: React.ReactNode; label: string; sub: string }[] = [
    { key: "scenarioMortgage",      icon: <GraphDown className="w-4 h-4" />, label: "Hypothek amortisieren",        sub: t("pages:wizard.w38") },
    { key: "scenarioSavings",       icon: <PiggyBank className="w-4 h-4" />,    label: t("pages:wizard.w13"),             sub: t("pages:wizard.w39") },
    { key: "scenarioEarlyRetirement", icon: <Airplane className="w-4 h-4" />,      label: t("pages:wizard.w40"),   sub: t("pages:wizard.w41") },
    { key: "scenarioCare",          icon: <Heart className="w-4 h-4" />,        label: "Pflegekosten einplanen (ab 80)", sub: t("pages:wizard.w42") },
  ];

  return (
    <div className="space-y-7">
      <div>
        <h2 className="text-text-primary font-semibold text-lg">{t("pages:wizard.w121")}</h2>
        <p className="text-text-secondary text-sm mt-1">
          Definiere deine Ziele für die Finanzplanung und Rentenprojektion.
        </p>
      </div>

      <Section title={t("pages:wizard.w154")}>
        <Field label={t("pages:wizard.w170")}>
          <Slider
            value={data.zielRentenalter}
            min={60}
            max={70}
            onChange={(v) => update({ zielRentenalter: v })}
            format={(v) => `${v} Jahre`}
          />
        </Field>

        <Field label={t("pages:wizard.w43")} hint={t("pages:wizard.w44")}>
          <Slider
            value={data.lebenserwartung}
            min={70}
            max={100}
            onChange={(v) => update({ lebenserwartung: v })}
            format={(v) => `${v} Jahre`}
          />
        </Field>

        <Field label={t("pages:wizard.w143")}>
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

      <Section title={t("pages:wizard.w160")}>
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
                <div className={clsx("w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5", data[sc.key] ? "bg-accent/15 text-accent" : "bg-white/5 text-text-tertiary")}>
                  {sc.icon}
                </div>
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

      <Section title={t("pages:wizard.w137")}>
        <Field
          label={t("pages:wizard.w45")}
          hint={t("pages:wizard.w133")}
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

function ReviewScreen({ data }: { data: WizardData }) {
  const { t } = useTranslation();
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
    (data.housingMode === "miete"
      ? data.monthlyRent + data.nebenkosten
      : data.monthlyAmortization + data.nebenkosten + mortgageInterestMonthly(data)) +
    data.groceries +
    data.freizeit +
    subscriptionTotal +
    healthInsuranceMonthly(data) +
    (data.hasAutoInsurance
      ? data.autoversicherungPeriod === "jahr"
        ? data.autoversicherung / 12
        : data.autoversicherung
      : 0);

  const totalAssets =
    (data.bankEnabled ? data.bankBalance : 0) +
    (data.stocksEnabled ? data.stocksValue : 0) +
    (data.propertyAssetEnabled ? data.propertyAssetValue - data.propertyAssetDebt : 0) +
    (data.cryptoEnabled ? data.cryptoValue : 0) +
    (data.otherAssetsEnabled ? data.otherAssetsValue : 0);

  return (
    <div className="space-y-7">
      <div className="text-center space-y-2">
        <div className="w-14 h-14 rounded-lg bg-gain/15 border border-gain/30 flex items-center justify-center mx-auto">
          <Check className="w-7 h-7 text-gain" />
        </div>
        <h2 className="text-text-primary font-semibold text-xl">
          {data.vorname ? `Fast fertig, ${data.vorname}!` : "Zusammenfassung"}
        </h2>
        <p className="text-text-secondary text-sm max-w-sm mx-auto">
          {t("pages:wizard.w309")}
          bleibt bei jedem Schritt gespeichert.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <SummaryCard label={t("pages:wizard.w149")} value={`${chf(netto)}/Mo`} sub={t("pages:wizard.w46")} />
        <SummaryCard label={t("pages:wizard.w47")} value={chf(monthlyExpenses)} sub={t("pages:wizard.w122")} />
        <SummaryCard
          label={t("pages:wizard.w157")}
          value={netto > 0 ? `${Math.round(((netto - monthlyExpenses) / netto) * 100)}%` : "—"}
          sub={t("pages:wizard.w148")}
        />
        <SummaryCard label={t("pages:wizard.w48")} value={chf(totalAssets)} sub={t("pages:wizard.w118")} />
        <SummaryCard label={t("pages:wizard.w100")} value={chf(pillar3aTotal)} sub={t("pages:wizard.w49")} />
        <SummaryCard
          label="Rente bei {age}"
          value={chf(ahvRente + bvgRente)}
          sub={`AHV ${chf(ahvRente)} + BVG ${chf(bvgRente)}`}
        />
      </div>

      <div className="card border-accent/20 bg-accent/5">
        <h4 className="text-text-primary font-medium text-sm mb-3">{t("pages:wizard.w105")}</h4>
        <div className="flex flex-wrap gap-2">
          {data.scenarioMortgage && (
            <span className="badge bg-accent/15 text-accent flex items-center gap-1"><GraphDown className="w-3 h-3" /> Hypothek amortisieren</span>
          )}
          {data.scenarioSavings && (
            <span className="badge bg-accent/15 text-accent flex items-center gap-1"><PiggyBank className="w-3 h-3" /> Sparplan erhöhen</span>
          )}
          {data.scenarioEarlyRetirement && (
            <span className="badge bg-accent/15 text-accent flex items-center gap-1"><Airplane className="w-3 h-3" /> Frühpensionierung</span>
          )}
          {data.scenarioCare && (
            <span className="badge bg-accent/15 text-accent flex items-center gap-1"><Heart className="w-3 h-3" /> Pflegekosten</span>
          )}
          {!data.scenarioMortgage && !data.scenarioSavings && !data.scenarioEarlyRetirement && !data.scenarioCare && (
            <span className="text-text-tertiary text-xs">{t("pages:wizard.w15")}</span>
          )}
        </div>
      </div>

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
const STORAGE_KEY = "budgetpal_wizard_draft";

function normalizeWizardData(raw: Partial<WizardData> | null | undefined): WizardData {
  const rawObj = raw as Record<string, unknown> | null | undefined;
  const pillar3aFromServer = rawObj?.pillar3aAccounts ?? rawObj?.pillar3AAccounts;
  const merged = {
    ...DEFAULT_WIZARD_DATA,
    ...(raw ?? {}),
    ...(Array.isArray(pillar3aFromServer)
      ? { pillar3aAccounts: pillar3aFromServer as WizardData["pillar3aAccounts"] }
      : {}),
  } as WizardData;

  const incoming = (raw as { mortgageEntries?: unknown } | null)?.mortgageEntries;
  const parsedEntries = Array.isArray(incoming)
    ? incoming
        .map((entry) => {
          const e = entry as Partial<MortgageEntry>;
          const mortgageType = e.mortgageType === "saron" ? "saron" : "fix";
          let mortgageRate = Number(e.mortgageRate) || 0;
          if (mortgageType === "saron" && mortgageRate <= 0) {
            mortgageRate = DEFAULT_SARON_REFERENCE_ANNUAL_PCT;
          }
          return {
            debtValue: Number(e.debtValue) || 0,
            mortgageType,
            mortgageRate,
          } as MortgageEntry;
        })
        .filter((e) => e.debtValue > 0 || e.mortgageRate > 0 || e.mortgageType === "saron")
    : [];

  const fallbackEntry: MortgageEntry = {
    debtValue: Number(merged.propertyAssetDebt) || 0,
    mortgageType: merged.mortgageType === "saron" ? "saron" : "fix",
    mortgageRate: Number(merged.mortgageRate) || 0,
  };

  const mortgageEntries = parsedEntries.length > 0
    ? parsedEntries
    : [fallbackEntry];

  const propertyAssetDebt = mortgageEntries.reduce((sum, e) => sum + (e.debtValue || 0), 0);

  return {
    ...merged,
    mortgageEntries,
    propertyAssetDebt,
    mortgageType: mortgageEntries[0]?.mortgageType ?? merged.mortgageType,
    mortgageRate: mortgageEntries[0]?.mortgageRate ?? merged.mortgageRate,
  };
}

function loadDraft(): WizardData {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return normalizeWizardData(JSON.parse(saved));
  } catch {}
  return normalizeWizardData(undefined);
}

/** Persist full wizard state (called on every „Weiter“ / before submit). */
function persistWizardDraft(data: WizardData) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn("Wizard draft could not be saved:", e);
  }
}

export default function Wizard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState(1);
  const [wizardData, setWizardData] = useState<WizardData>(loadDraft);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [animating, setAnimating] = useState(false);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [isReview, setIsReview] = useState(false);
  const [serverStateLoaded, setServerStateLoaded] = useState(false);

  // Auto-save to localStorage on every change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(wizardData));
    } catch {}
  }, [wizardData]);

  // On mount: restore from server first (DB is source of truth),
  // then keep localStorage as an offline draft cache.
  useEffect(() => {
    api.get("/wizard/state").then((res) => {
      if (res.data) {
        setWizardData(normalizeWizardData(res.data));
      }
    }).catch(() => {}).finally(() => setServerStateLoaded(true));
  }, []);

  // Debounced DB autosave so wizard progress survives browser/storage resets.
  useEffect(() => {
    if (!serverStateLoaded) return;
    const t = window.setTimeout(() => {
      api.put("/wizard/state", wizardData).catch(() => {});
    }, 800);
    return () => window.clearTimeout(t);
  }, [wizardData, serverStateLoaded]);

  // Prefill from user profile on mount (name + birthdate) — only if still at defaults
  useEffect(() => {
    api.get("/auth/me").then((res) => {
      const user = res.data;
      setWizardData((prev) => {
        const patch: Partial<WizardData> = {};
        if (!prev.vorname && user.name) {
          patch.vorname = user.name.split(" ")[0];
        }
        if (prev.geburtsjahr === 1985 && user.birthdate) {
          const year = new Date(user.birthdate).getFullYear();
          if (year > 1930 && year < 2010) patch.geburtsjahr = year;
        }
        return Object.keys(patch).length ? { ...prev, ...patch } : prev;
      });
    }).catch(() => {});
  }, []);

  const update = useCallback((partial: Partial<WizardData>) => {
    setWizardData((prev) => ({ ...prev, ...partial }));
  }, []);

  function canGoNext(): boolean {
    if (currentStep === 1) return wizardData.vorname.trim().length > 0;
    return true;
  }

  async function goNext() {
    if (!canGoNext()) return;
    persistWizardDraft(wizardData);
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
    persistWizardDraft(wizardData);
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

  async function goToStep(targetStep: number) {
    if (targetStep === currentStep || animating) return;
    // Persist state immediately before jumping
    persistWizardDraft(wizardData);
    api.put("/wizard/state", wizardData).catch(() => {});
    setDirection(targetStep > currentStep ? "forward" : "back");
    setAnimating(true);
    await new Promise((r) => setTimeout(r, 180));
    setCurrentStep(targetStep);
    if (isReview) setIsReview(false);
    setAnimating(false);
  }

  async function handleSubmit() {
    persistWizardDraft(wizardData);
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const subscriptionTotal = COMMON_SUBSCRIPTIONS
        .filter((s) => wizardData.selectedSubscriptions.includes(s.name))
        .reduce((sum, s) => sum + s.price, 0);
      const syncedPropertyDebt = wizardData.propertyAssetEnabled
        ? (wizardData.mortgageEntries ?? []).reduce((sum, e) => sum + (e.debtValue || 0), 0)
        : 0;
      const syncedPropertyValue = wizardData.propertyAssetEnabled ? wizardData.propertyAssetValue : 0;
      const syncedOutstandingDebt = syncedPropertyDebt;

      await api.post("/wizard/complete", {
        ...wizardData,
        propertyAssetDebt: syncedPropertyDebt,
        propertyValue: syncedPropertyValue,
        outstandingDebt: syncedOutstandingDebt,
        estimated_netto_monthly: computeNettoEinkommen(wizardData),
        subscription_total: subscriptionTotal,
      });
      localStorage.removeItem(STORAGE_KEY);
      navigate("/finanzplan");
    } catch (err) {
      console.error("Wizard submit failed:", err);
      setSubmitError(t("pages:wizard.w50"));
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
              <Reports className="w-4 h-4 text-accent" />
            </div>
            <span className="font-display font-semibold text-text-primary text-sm">
              Budget<span className="text-accent">Pal</span>
            </span>
            <span className="ml-auto text-text-tertiary text-xs">{t("pages:wizard.w16")}</span>
          </div>

          {isReview ? (
            <p className="text-text-tertiary text-xs text-center md:text-left">
              Zusammenfassung — alle Schritte ausgefüllt
            </p>
          ) : (
            <StepIndicator currentStep={currentStep} totalSteps={TOTAL_STEPS} onStepClick={goToStep} />
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
      <main className="flex-1 px-4 py-8 pb-28">
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
              <ReviewScreen data={wizardData} />
            ) : (
              stepComponents[currentStep]
            )}
          </div>
        </div>
      </main>

      {/* ── Navigation (always visible) ────────── */}
      <nav className="sticky bottom-0 z-10 bg-bg/95 backdrop-blur border-t border-border/50 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {submitError && (
          <div className="max-w-2xl mx-auto mb-2 flex items-center gap-2 rounded-lg border border-loss/40 bg-loss/10 px-3 py-2 text-xs text-loss">
            <span className="flex-1">{submitError}</span>
            <button type="button" onClick={() => setSubmitError(null)} className="shrink-0 hover:opacity-70">✕</button>
          </div>
        )}
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          {(isReview || currentStep > 1) && (
            <button
              type="button"
              className="btn-secondary flex items-center gap-1.5 shrink-0"
              onClick={goBack}
              disabled={animating || isSubmitting}
            >
              <NavArrowLeft className="w-4 h-4" />
              {isReview ? t("pages:wizard.w51") : t("pages:wizard.w52")}
            </button>
          )}
          {!(isReview || currentStep > 1) && <div />}

          <div className="flex-1 min-w-0" />

          {!isReview && (currentStep === 3 || currentStep === 6 || currentStep === 7) && (
            <button
              type="button"
              className="btn-ghost text-sm shrink-0"
              onClick={goNext}
              disabled={animating}
            >
              Überspringen
            </button>
          )}

          {!isReview ? (
            <button
              type="button"
              className={clsx(
                "btn-primary flex items-center gap-1.5 shrink-0",
                !canGoNext() && "opacity-50 cursor-not-allowed"
              )}
              onClick={goNext}
              disabled={animating || !canGoNext()}
            >
              {currentStep === TOTAL_STEPS ? (
                <>
                  {t("pages:wizard.w400")} <ArrowRight className="w-4 h-4" />
                </>
              ) : (
                <>
                  {t("pages:wizard.w308")} <NavArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary flex items-center gap-1.5 shrink-0"
              onClick={handleSubmit}
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Wird erstellt…
                </>
              ) : (
                <>
                  {t("pages:wizard.w307")} <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          )}
        </div>
      </nav>

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
