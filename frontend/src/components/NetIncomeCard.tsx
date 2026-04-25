/**
 * NetIncomeCard — berechnet das Netto-Einkommen nach Schweizer Sozialabzügen.
 *
 * Quellen:
 *   - Brutto: lohn + selbstaendig + ahvRente + dividenden + mieteinnahmen (wizard_state)
 *   - Sozialabgaben (Arbeitnehmer-Anteil, Schätzung):
 *       AHV 5.3% + IV 0.7% + EO 0.25% + ALV 1.1% = 7.35% on gross
 *   - Steuern: direkte_steuern (CHF/Mo, aus Wizard Step 4)
 *   - Netto = Brutto − Sozialabgaben − Steuern
 */
import { useQuery } from "@tanstack/react-query";
import { wizardApi } from "@/lib/api";
import { formatAmount } from "@/lib/theme";
import { Wallet, TrendingDown, Info } from "lucide-react";
import { clsx } from "clsx";
import { useState } from "react";

// Swiss employee social insurance contributions 2024
const AHV_RATE   = 0.053;   // 5.30%
const IV_RATE    = 0.007;   // 0.70%
const EO_RATE    = 0.0025;  // 0.25%
const ALV_RATE   = 0.011;   // 1.10% (capped at CHF 148,200/yr ≈ CHF 12,350/Mo)
const ALV_CAP_MONTHLY = 12_350;

interface WizardState {
  lohn?: number; lohn_enabled?: boolean;
  selbstaendig?: number; selbstaendig_enabled?: boolean;
  ahvRente?: number; ahvRenteEnabled?: boolean;
  dividenden?: number; dividendenEnabled?: boolean;
  mieteinnahmen?: number; mieteinnahmenEnabled?: boolean;
  direkte_steuern?: number;
  estimated_netto_monthly?: number;
}

function computeNetIncome(s: WizardState) {
  const brutto =
    (s.lohn_enabled !== false ? (s.lohn ?? 0) : 0) +
    (s.selbstaendig_enabled ? (s.selbstaendig ?? 0) : 0) +
    (s.ahvRenteEnabled ? (s.ahvRente ?? 0) : 0) +
    (s.dividendenEnabled ? (s.dividenden ?? 0) : 0) +
    (s.mieteinnahmenEnabled ? (s.mieteinnahmen ?? 0) : 0);

  const ahv = brutto * AHV_RATE;
  const iv  = brutto * IV_RATE;
  const eo  = brutto * EO_RATE;
  const alv = Math.min(brutto, ALV_CAP_MONTHLY) * ALV_RATE;
  const socialTotal = ahv + iv + eo + alv;
  const steuern = s.direkte_steuern ?? 0;
  const netto = brutto - socialTotal - steuern;

  return { brutto, socialTotal, ahv, iv, eo, alv, steuern, netto };
}

interface Props {
  compact?: boolean;
}

export default function NetIncomeCard({ compact = false }: Props) {
  const [showBreakdown, setShowBreakdown] = useState(false);

  const { data: wizardState, isLoading } = useQuery({
    queryKey: ["wizard-state-net-income"],
    queryFn: () => wizardApi.getState().then((r) => r.data as WizardState),
    staleTime: 300_000,
  });

  if (isLoading) {
    return (
      <div className="card animate-pulse">
        <div className="skeleton h-4 w-32 rounded mb-2" />
        <div className="skeleton h-6 w-24 rounded" />
      </div>
    );
  }

  if (!wizardState || (!wizardState.lohn && !wizardState.estimated_netto_monthly)) {
    return null; // Hide if wizard not filled in
  }

  // If user provided a direct net override, show that simply
  if (wizardState.estimated_netto_monthly && !wizardState.lohn) {
    const netto = wizardState.estimated_netto_monthly;
    return (
      <div className="card">
        <div className="flex items-center gap-2 text-text-tertiary text-xs uppercase tracking-widest mb-2">
          <Wallet className="w-3.5 h-3.5" />
          Netto-Einkommen (Ist)
        </div>
        <p className="text-2xl font-mono font-bold text-gain">
          {formatAmount(netto, "CHF")}
          <span className="text-text-tertiary text-sm font-normal ml-1">/Mt.</span>
        </p>
      </div>
    );
  }

  const { brutto, socialTotal, steuern, netto } = computeNetIncome(wizardState);
  const savingsRate = netto > 0 ? Math.max(0, (netto - (wizardState as WizardState & { total_expenses?: number }).total_expenses!) / netto * 100) : 0;

  if (compact) {
    return (
      <div className="card">
        <div className="flex items-center gap-2 text-text-tertiary text-[10px] uppercase tracking-widest mb-2">
          <Wallet className="w-3.5 h-3.5" />
          Netto-Einkommen / Mt.
        </div>
        <p className="text-xl font-mono font-bold text-gain">{formatAmount(netto, "CHF")}</p>
        <p className="text-text-tertiary text-[11px] mt-1">
          Brutto {formatAmount(brutto, "CHF")} − Abzüge {formatAmount(socialTotal + steuern, "CHF")}
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-text-tertiary text-xs uppercase tracking-widest">
          <Wallet className="w-3.5 h-3.5" />
          Netto-Einkommen / Monat
        </div>
        <button
          onClick={() => setShowBreakdown((v) => !v)}
          className="text-text-tertiary hover:text-text-primary transition-colors"
          title="Berechnung anzeigen"
        >
          <Info className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Main number */}
      <p className="text-2xl font-mono font-bold text-gain mb-3">
        {formatAmount(netto, "CHF")}
        <span className="text-text-tertiary text-sm font-normal ml-1">/Mt.</span>
      </p>

      {/* Summary bar */}
      <div className="flex h-2 rounded-full overflow-hidden mb-2 bg-bg-surface2">
        <div className="bg-gain h-full" style={{ width: `${Math.max(5, (netto / brutto) * 100)}%` }} title="Netto" />
        <div className="bg-warning/70 h-full" style={{ width: `${(socialTotal / brutto) * 100}%` }} title="Sozialabgaben" />
        <div className="bg-loss/70 h-full" style={{ width: `${(steuern / brutto) * 100}%` }} title="Steuern" />
      </div>
      <div className="flex gap-3 text-[10px] text-text-tertiary mb-3">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-gain" />Netto {(netto / brutto * 100).toFixed(0)}%</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-warning/70" />Sozial {(socialTotal / brutto * 100).toFixed(0)}%</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-loss/70" />Steuern {(steuern / brutto * 100).toFixed(0)}%</span>
      </div>

      {/* Breakdown */}
      {showBreakdown && (
        <div className="border-t border-border/50 pt-3 space-y-1.5 animate-fade-in">
          <Row label="Brutto" value={brutto} sign="+" />
          <Row label="AHV (5.3%)" value={computeNetIncome(wizardState).ahv} sign="-" />
          <Row label="IV/EO/ALV (2.05%)" value={computeNetIncome(wizardState).iv + computeNetIncome(wizardState).eo + computeNetIncome(wizardState).alv} sign="-" />
          <Row label="Direkte Steuern" value={steuern} sign="-" />
          <div className="flex justify-between items-center pt-1.5 border-t border-border/40">
            <span className="text-xs font-semibold text-text-primary">Netto</span>
            <span className="text-xs font-mono font-bold text-gain">{formatAmount(netto, "CHF")}</span>
          </div>
          <p className="text-[10px] text-text-tertiary pt-1">
            *Schätzung: AHV/IV/EO/ALV Arbeitnehmer-Anteil 2024. PKK (BVG) nicht eingerechnet.
          </p>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, sign }: { label: string; value: number; sign: "+" | "-" }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-xs text-text-tertiary">{label}</span>
      <span className={clsx("text-xs font-mono", sign === "-" ? "text-loss/80" : "text-gain/80")}>
        {sign}{formatAmount(value, "CHF")}
      </span>
    </div>
  );
}
