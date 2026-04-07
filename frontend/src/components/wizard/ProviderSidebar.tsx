/**
 * ProviderSidebar — Sticky right-side panel for provider configuration.
 *
 * Modes:
 *  simple     – Pick a plan variant, optional price override + note
 *  individual – Enter own amount, frequency, currency, first-payment date
 */
import { useState, useRef } from "react";
import {
  X, Settings2, ChevronLeft, ExternalLink, Trash2,
  Check, Users, Calendar, RefreshCw, PencilLine,
} from "lucide-react";
import { clsx } from "clsx";
import ProviderBrandIcon from "./ProviderBrandIcon";
import {
  toMonthlyCHF, FREQUENCY_LABELS, FREQUENCIES,
  SUPPORTED_CURRENCIES, CURRENCY_SYMBOLS,
  type Frequency, type SupportedCurrency,
} from "@/services/faviconService";
import type { ExpenseProvider, ExpenseCategory, SelectedExpenseEntry, ProviderVariant } from "./Step5AccordionExpenses";

// ── helpers ────────────────────────────────────────────────────

function fchf(n: number) {
  if (n === 0) return "Gratis";
  return `CHF ${n % 1 === 0 ? n : n.toFixed(2)}`;
}

function getEffectiveMonthly(entry: SelectedExpenseEntry, variants: ProviderVariant[]): number {
  if (entry.viewMode === "individual" && entry.individualAmount != null) {
    return toMonthlyCHF(
      entry.individualAmount,
      entry.frequency ?? "monthly",
      entry.currency ?? "CHF"
    );
  }
  if (entry.customPrice != null) return entry.customPrice;
  return variants.find(v => v.id === entry.variantId)?.price ?? 0;
}

// ── props ──────────────────────────────────────────────────────

interface Props {
  provider: ExpenseProvider;
  category: ExpenseCategory;
  entry: SelectedExpenseEntry | null;
  onClose: () => void;
  onSelect: () => void;
  onDeselect: () => void;
  onUpdate: (patch: Partial<SelectedExpenseEntry>) => void;
}

// ── component ─────────────────────────────────────────────────

export default function ProviderSidebar({
  provider, category, entry, onClose, onSelect, onDeselect, onUpdate,
}: Props) {
  const [viewMode, setViewMode] = useState<"simple" | "individual">(
    entry?.viewMode ?? "simple"
  );
  const customInputRef = useRef<HTMLInputElement>(null);

  function switchMode(mode: "simple" | "individual") {
    setViewMode(mode);
    if (entry) onUpdate({ viewMode: mode });
  }

  const effectiveMonthly = entry ? getEffectiveMonthly(entry, provider.variants) : null;

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-bg-surface border border-border/50 rounded-lg overflow-hidden shadow-2xl">

      {/* ── Fixed Header ──────────────────────────────────── */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-border/50 bg-bg-surface2 flex-shrink-0">
        <ProviderBrandIcon providerId={provider.id} size={24} />
        <div className="flex-1 min-w-0">
          <div className="text-text-primary font-semibold text-sm truncate">{provider.name}</div>
          <div className="text-text-tertiary text-[11px] truncate">{category.label}</div>
        </div>

        {/* View toggle */}
        {entry && (
          <button
            type="button"
            title={viewMode === "simple" ? "Individuelle Eingabe" : "Einfache Ansicht"}
            onClick={() => switchMode(viewMode === "simple" ? "individual" : "simple")}
            className={clsx(
              "p-1.5 rounded-md transition-all flex-shrink-0",
              viewMode === "individual"
                ? "bg-accent/20 text-accent"
                : "text-text-tertiary hover:text-text-primary hover:bg-white/[0.05]"
            )}
          >
            {viewMode === "simple"
              ? <Settings2 className="w-3.5 h-3.5" />
              : <ChevronLeft className="w-3.5 h-3.5" />}
          </button>
        )}

        {/* Close */}
        <button
          type="button"
          onClick={onClose}
          className="text-text-tertiary hover:text-text-primary transition-colors flex-shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      {/* ── Scrollable Body ───────────────────────────────── */}
      <div className="flex-1 overflow-y-auto scrollbar-hide p-4 space-y-4 min-h-0">

        {/* Tagline */}
        <p className="text-text-secondary text-xs leading-relaxed">{provider.tagline}</p>

        {/* Peer popularity */}
        {(provider.peerPopularity ?? 0) > 0 && (
          <div className="flex items-start gap-2 bg-accent/8 border border-accent/15 rounded-lg px-3 py-2">
            <Users className="w-3.5 h-3.5 text-accent flex-shrink-0 mt-0.5" />
            <p className="text-text-secondary text-xs leading-relaxed">
              <strong className="text-accent">{provider.peerPopularity}%</strong> deiner Peer-Gruppe nutzen diesen Dienst
            </p>
          </div>
        )}

        {/* ── SIMPLE VIEW ─────────────────────────────── */}
        {viewMode === "simple" && (
          <>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary mb-2">Tarif / Plan</p>
              <div className="space-y-1.5">
                {provider.variants.map(variant => {
                  const isActive = entry?.variantId === variant.id && entry?.customPrice == null;
                  return (
                    <button
                      key={variant.id}
                      type="button"
                      disabled={!entry}
                      onClick={() => entry && onUpdate({ variantId: variant.id, customPrice: undefined })}
                      className={clsx(
                        "w-full flex items-start justify-between rounded-md px-3 py-2.5 text-left text-xs transition-all border",
                        isActive
                          ? "border-accent/60 bg-accent/12 text-text-primary"
                          : "border-border/50 hover:border-border text-text-secondary hover:bg-white/[0.03]",
                        !entry && "opacity-40 cursor-not-allowed"
                      )}
                    >
                      <div className="flex items-start gap-2">
                        <div className={clsx(
                          "w-3.5 h-3.5 rounded-full border mt-0.5 flex-shrink-0 flex items-center justify-center transition-all",
                          isActive ? "border-accent bg-accent" : "border-white/25"
                        )}>
                          {isActive && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                        </div>
                        <div className="min-w-0">
                          <div className="font-medium flex items-center gap-1 flex-wrap">
                            {variant.label}
                            {variant.popular && (
                              <span className="text-[9px] bg-gain/15 text-gain px-1.5 py-px rounded-full font-semibold">BELIEBT</span>
                            )}
                          </div>
                          {variant.description && (
                            <div className="text-text-tertiary text-[10px] mt-0.5">{variant.description}</div>
                          )}
                        </div>
                      </div>
                      <span className={clsx("font-mono flex-shrink-0 ml-2 mt-0.5 text-xs", isActive ? "text-accent font-semibold" : "text-text-tertiary")}>
                        {fchf(variant.price)}
                      </span>
                    </button>
                  );
                })}

                {/* Custom price — integrated as last radio option */}
                {entry && (() => {
                  const isCustomActive = entry.customPrice != null;
                  return (
                    <button
                      type="button"
                      onClick={() => {
                        if (!isCustomActive) {
                          onUpdate({ customPrice: 0 });
                          setTimeout(() => customInputRef.current?.focus(), 50);
                        }
                      }}
                      className={clsx(
                        "w-full flex items-start justify-between rounded-md px-3 py-2.5 text-left text-xs transition-all border",
                        isCustomActive
                          ? "border-accent/60 bg-accent/12 text-text-primary"
                          : "border-border/50 hover:border-border text-text-secondary hover:bg-white/[0.03]"
                      )}
                    >
                      <div className="flex items-start gap-2 flex-1 min-w-0">
                        <div className={clsx(
                          "w-3.5 h-3.5 rounded-full border mt-0.5 flex-shrink-0 flex items-center justify-center transition-all",
                          isCustomActive ? "border-accent bg-accent" : "border-white/25"
                        )}>
                          {isCustomActive && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium flex items-center gap-1">
                            <PencilLine className="w-3 h-3" />
                            Eigener Preis
                          </div>
                          {isCustomActive && (
                            <div className="flex items-center gap-1.5 mt-1.5" onClick={e => e.stopPropagation()}>
                              <div className="relative">
                                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary text-xs pointer-events-none">CHF</span>
                                <input
                                  ref={customInputRef}
                                  type="number"
                                  className="input pl-9 text-sm w-28"
                                  placeholder="0.00"
                                  value={entry.customPrice === 0 ? "" : (entry.customPrice ?? "")}
                                  onChange={e => onUpdate({ customPrice: e.target.value ? parseFloat(e.target.value) : 0 })}
                                  min={0}
                                  step={0.01}
                                />
                              </div>
                              <span className="text-text-tertiary text-xs">/Mo</span>
                              <button
                                type="button"
                                onClick={() => onUpdate({ customPrice: undefined })}
                                className="text-text-tertiary hover:text-loss transition-colors ml-1"
                                title="Zurücksetzen"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                      {!isCustomActive && (
                        <span className="font-mono flex-shrink-0 ml-2 mt-0.5 text-xs text-text-tertiary">—</span>
                      )}
                    </button>
                  );
                })()}
              </div>
              {!entry && (
                <p className="text-text-tertiary text-[10px] mt-2 text-center">Wähle diesen Anbieter zuerst aus</p>
              )}
            </div>

            {/* Note */}
            {entry && (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary mb-1.5">Notiz</p>
                <input
                  type="text"
                  className="input text-sm w-full"
                  placeholder="z.B. Family-Plan, geteilt mit Partner…"
                  value={entry.note ?? ""}
                  onChange={e => onUpdate({ note: e.target.value || undefined })}
                />
              </div>
            )}
          </>
        )}

        {/* ── INDIVIDUAL VIEW ──────────────────────────── */}
        {viewMode === "individual" && entry && (
          <>
            {/* Amount + Currency */}
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary mb-1.5">Betrag</p>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    type="number"
                    className="input text-sm w-full pr-2"
                    placeholder="0.00"
                    value={entry.individualAmount ?? ""}
                    onChange={e => onUpdate({ individualAmount: e.target.value ? parseFloat(e.target.value) : undefined })}
                    min={0}
                    step={0.01}
                  />
                </div>
                <select
                  className="input text-sm w-24 cursor-pointer"
                  value={entry.currency ?? "CHF"}
                  onChange={e => onUpdate({ currency: e.target.value as SupportedCurrency })}
                >
                  {SUPPORTED_CURRENCIES.map(c => (
                    <option key={c} value={c}>{CURRENCY_SYMBOLS[c]} {c}</option>
                  ))}
                </select>
              </div>
              {entry.currency && entry.currency !== "CHF" && entry.individualAmount && (
                <p className="text-text-tertiary text-[10px] mt-1 flex items-center gap-1">
                  <RefreshCw className="w-2.5 h-2.5" />
                  Indikativer Kurs · Angaben ohne Gewähr
                </p>
              )}
            </div>

            {/* Frequency */}
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary mb-1.5">Zahlungsrhythmus</p>
              <div className="grid grid-cols-2 gap-1.5">
                {FREQUENCIES.map(freq => (
                  <button
                    key={freq}
                    type="button"
                    onClick={() => onUpdate({ frequency: freq })}
                    className={clsx(
                      "rounded-md border px-2 py-2 text-[11px] font-medium transition-all text-left",
                      (entry.frequency ?? "monthly") === freq
                        ? "border-accent/50 bg-accent/10 text-accent"
                        : "border-border/50 text-text-secondary hover:border-border"
                    )}
                  >
                    {FREQUENCY_LABELS[freq]}
                  </button>
                ))}
              </div>
            </div>

            {/* First payment date */}
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary mb-1.5">
                <Calendar className="w-3 h-3 inline mr-1 mb-0.5" />
                Erste Zahlung
              </p>
              <input
                type="date"
                className="input text-sm w-full"
                value={entry.firstPaymentDate ?? ""}
                onChange={e => onUpdate({ firstPaymentDate: e.target.value || undefined })}
                max="2030-12-31"
              />
            </div>

            {/* Note */}
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary mb-1.5">Notiz</p>
              <input
                type="text"
                className="input text-sm w-full"
                placeholder="z.B. Jahresabo, shared account…"
                value={entry.note ?? ""}
                onChange={e => onUpdate({ note: e.target.value || undefined })}
              />
            </div>
          </>
        )}

        {/* Website link */}
        {provider.website && (
          <a
            href={provider.website}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-accent hover:text-accent-light text-xs transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
            Webseite besuchen
          </a>
        )}

        {/* Action */}
        <div className="pt-2 border-t border-border/50">
          {entry ? (
            <button
              type="button"
              onClick={onDeselect}
              className="w-full flex items-center justify-center gap-1.5 rounded-md border border-loss/30 bg-loss/8 text-loss hover:bg-loss/15 px-3 py-2 text-xs font-medium transition-all"
            >
              <Trash2 className="w-3 h-3" />
              Entfernen
            </button>
          ) : (
            <button
              type="button"
              onClick={onSelect}
              className="w-full btn-primary text-xs py-2 flex items-center justify-center gap-1"
            >
              <Check className="w-3 h-3" />
              Hinzufügen
            </button>
          )}
        </div>
      </div>

      {/* ── Fixed Footer ──────────────────────────────────── */}
      {entry && (
        <footer className="flex-shrink-0 border-t border-border/50 bg-bg-surface2 px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-text-tertiary text-[10px] uppercase tracking-wide font-semibold">Monatlicher Betrag</p>
              {viewMode === "individual" && entry.frequency && entry.frequency !== "monthly" && (
                <p className="text-text-tertiary text-[10px]">{FREQUENCY_LABELS[entry.frequency ?? "monthly"]}</p>
              )}
            </div>
            <div className="text-right">
              <span className="font-mono font-bold text-gain text-base">
                {effectiveMonthly != null && effectiveMonthly > 0 ? fchf(effectiveMonthly) : "—"}
              </span>
              <span className="text-text-tertiary text-xs font-normal">/Mo</span>
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}
