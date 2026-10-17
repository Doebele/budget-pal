/**
 * ProviderSidebar — Sticky right-side panel for provider configuration.
 *
 * Modes:
 *  simple     – Pick a plan variant, optional price override + note
 *  individual – Enter own amount, frequency, currency, first-payment date
 */
import { useState, useRef } from "react";
import { Calendar, Check, EditPencil, Group, NavArrowLeft, OpenNewWindow, Refresh, Settings, Trash, Xmark } from "@/lib/icons";
import { clsx } from "clsx";
import ProviderBrandIcon from "./ProviderBrandIcon";
import {
  toCHF, toMonthlyCHF, FREQUENCY_LABELS, FREQUENCIES,
  SUPPORTED_CURRENCIES, CURRENCY_SYMBOLS,
  type Frequency, type SupportedCurrency,
} from "@/services/faviconService";
import type { ExpenseProvider, ExpenseCategory, SelectedExpenseEntry, Country } from "./Step5AccordionExpenses";
import { getEffectiveMonthly, providerCountries, variantPrice } from "./Step5AccordionExpenses";
import { catalogText } from "./catalogI18n";
import { useTranslation } from "react-i18next";

// ── helpers ────────────────────────────────────────────────────

function fchf(n: number) {
  if (n === 0) return "Gratis";
  return `CHF ${n % 1 === 0 ? n : n.toFixed(2)}`;
}

/** Tarifpreis in der Abrechnungswährung, z. B. «12.99 €» oder «$20» */
function fmoney(amount: number, currency: SupportedCurrency): string {
  if (amount === 0) return "Gratis";
  const n = amount % 1 === 0 ? String(amount) : amount.toFixed(2);
  return currency === "CHF" ? `CHF ${n}` : currency === "USD" ? `$${n}` : `${n} ${CURRENCY_SYMBOLS[currency]}`;
}

const COUNTRY_LABEL: Record<Country, string> = { CH: "🇨🇭 CH", DE: "🇩🇪 DE", FR: "🇫🇷 FR", US: "🇺🇸 US" };

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
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<"simple" | "individual">(
    entry?.viewMode ?? "simple"
  );
  const customInputRef = useRef<HTMLInputElement>(null);

  function switchMode(mode: "simple" | "individual") {
    setViewMode(mode);
    if (entry) onUpdate({ viewMode: mode });
  }

  const effectiveMonthly = entry ? getEffectiveMonthly(entry, [provider]) : null;
  const countries = providerCountries(provider);
  const country: Country = entry?.country ?? "CH";

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-bg-surface border border-border/50 rounded-lg overflow-hidden shadow-2xl">

      {/* ── Fixed Header ──────────────────────────────────── */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-border/50 bg-bg-surface2 flex-shrink-0">
        <ProviderBrandIcon providerId={provider.id} size={24} />
        <div className="flex-1 min-w-0">
          <div className="text-text-primary font-semibold text-base truncate">{provider.name}</div>
          <div className="text-text-tertiary text-xs truncate">{catalogText(category.label)}</div>
        </div>

        {/* View toggle */}
        {entry && (
          <button
            type="button"
            title={viewMode === "simple" ? "Individuelle Eingabe" : "Einfache Ansicht"}
            onClick={() => switchMode(viewMode === "simple" ? "individual" : "simple")}
            className={clsx(
              "p-1 rounded-md transition-all flex-shrink-0",
              viewMode === "individual"
                ? "bg-accent/20 text-accent"
                : "text-text-tertiary hover:text-text-primary hover:bg-white/[0.05]"
            )}
          >
            {viewMode === "simple"
              ? <Settings className="w-3.5 h-3.5" />
              : <NavArrowLeft className="w-3.5 h-3.5" />}
          </button>
        )}

        {/* Close */}
        <button
          type="button"
          onClick={onClose}
          className="text-text-tertiary hover:text-text-primary transition-colors flex-shrink-0"
        >
          <Xmark className="w-4 h-4" />
        </button>
      </header>

      {/* ── Scrollable Body ───────────────────────────────── */}
      <div className="flex-1 overflow-y-auto scrollbar-hide p-4 space-y-4 min-h-0">

        {/* Tagline */}
        <p className="text-text-secondary text-sm leading-relaxed">{catalogText(provider.tagline)}</p>

        {/* Peer popularity */}
        {(provider.peerPopularity ?? 0) > 0 && (
          <div className="flex items-start gap-2 bg-accent/8 border border-accent/15 rounded-lg px-3 py-2">
            <Group className="w-3.5 h-3.5 text-accent flex-shrink-0 mt-1" />
            <p className="text-text-secondary text-sm leading-relaxed">
              <strong className="text-accent">{provider.peerPopularity}%</strong> {t("pages:ui.deiner_peer_gruppe_nutzen_diesen_dienst")}
            </p>
          </div>
        )}

        {/* ── SIMPLE VIEW ─────────────────────────────── */}
        {viewMode === "simple" && (
          <>
            {/* Land der Tarife: Preise in der Landeswährung, umgerechnet in CHF */}
            {countries.length > 1 && (
              <div>
                <p className="text-2xs font-semibold text-text-tertiary mb-2">{t("pages:step5.country")}</p>
                <div className="toggle-group w-full">
                  {countries.map((c) => (
                    <button
                      key={c}
                      type="button"
                      disabled={!entry}
                      onClick={() => {
                        if (!entry) return;
                        // Gibt es den gewählten Tarif im Land nicht, den beliebtesten dort nehmen
                        const has = (id: string) => provider.variants.some((v) => v.id === id && variantPrice(provider, v, c));
                        const next = has(entry.variantId) ? entry.variantId
                          : (provider.variants.find((v) => v.popular && has(v.id)) ?? provider.variants.find((v) => has(v.id)))?.id;
                        onUpdate({ country: c, customPrice: undefined, ...(next ? { variantId: next } : {}) });
                      }}
                      className={clsx("toggle-btn", country === c && "active")}
                    >
                      {COUNTRY_LABEL[c]}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <p className="text-2xs font-semibold text-text-tertiary mb-2">{t("pages:step5.s08")}</p>
              <div className="space-y-1">
                {provider.variants.map(variant => {
                  const isActive = entry?.variantId === variant.id && entry?.customPrice == null;
                  const local = variantPrice(provider, variant, country);
                  return (
                    <button
                      key={variant.id}
                      type="button"
                      disabled={!entry || !local}
                      onClick={() => entry && onUpdate({ variantId: variant.id, customPrice: undefined })}
                      className={clsx(
                        "w-full flex items-start justify-between rounded-md px-3 py-2 text-left text-sm transition-all border",
                        isActive
                          ? "border-accent/60 bg-accent/12 text-text-primary"
                          : "border-border/50 hover:border-border text-text-secondary hover:bg-white/[0.03]",
                        (!entry || !local) && "opacity-40 cursor-not-allowed"
                      )}
                    >
                      <div className="flex items-start gap-2">
                        <div className={clsx(
                          "w-3.5 h-3.5 rounded-full border mt-1 flex-shrink-0 flex items-center justify-center transition-all",
                          isActive ? "border-accent bg-accent" : "border-white/25"
                        )}>
                          {isActive && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                        </div>
                        <div className="min-w-0">
                          <div className="font-medium flex items-center gap-1 flex-wrap">
                            {catalogText(variant.label)}
                            {variant.popular && (
                              <span className="text-2xs bg-gain/15 text-gain px-1 py-px rounded-full font-semibold">{t("pages:step5.s04")}</span>
                            )}
                            {variant.billing === "yearly" && (
                              <span className="text-2xs bg-bg-surface2 text-text-secondary px-1 py-px rounded-full">{t("pages:step5.yearly")}</span>
                            )}
                          </div>
                          {variant.description && (
                            <div className="text-text-tertiary text-2xs mt-1">{catalogText(variant.description)}</div>
                          )}
                        </div>
                      </div>
                      <span className={clsx("font-mono flex-shrink-0 ml-2 mt-1 text-sm text-right", isActive ? "text-accent font-semibold" : "text-text-tertiary")}>
                        {local ? fmoney(local.amount, local.currency) : t("pages:step5.unavailable")}
                        {local && local.currency !== "CHF" && local.amount > 0 && (
                          <span className="block text-2xs font-normal opacity-70">≈ {fchf(toCHF(local.amount, local.currency))}</span>
                        )}
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
                        "w-full flex items-start justify-between rounded-md px-3 py-2 text-left text-sm transition-all border",
                        isCustomActive
                          ? "border-accent/60 bg-accent/12 text-text-primary"
                          : "border-border/50 hover:border-border text-text-secondary hover:bg-white/[0.03]"
                      )}
                    >
                      <div className="flex items-start gap-2 flex-1 min-w-0">
                        <div className={clsx(
                          "w-3.5 h-3.5 rounded-full border mt-1 flex-shrink-0 flex items-center justify-center transition-all",
                          isCustomActive ? "border-accent bg-accent" : "border-white/25"
                        )}>
                          {isCustomActive && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium flex items-center gap-1">
                            <EditPencil className="w-3 h-3" />
                            {t("pages:ui.eigener_preis")}
                          </div>
                          {isCustomActive && (
                            <div className="flex items-center gap-1 mt-1" onClick={e => e.stopPropagation()}>
                              <div className="relative">
                                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary text-sm pointer-events-none">CHF</span>
                                <input
                                  ref={customInputRef}
                                  type="number"
                                  className="input input-amount pl-9 text-base w-28"
                                  placeholder="0.00"
                                  value={entry.customPrice === 0 ? "" : (entry.customPrice ?? "")}
                                  onChange={e => onUpdate({ customPrice: e.target.value ? parseFloat(e.target.value) : 0 })}
                                  min={0}
                                  step={0.01}
                                />
                              </div>
                              <span className="text-text-tertiary text-sm">/Mo</span>
                              <button
                                type="button"
                                onClick={() => onUpdate({ customPrice: undefined })}
                                className="text-text-tertiary hover:text-loss transition-colors ml-1"
                                title={t("pages:step5.s11")}
                              >
                                <Xmark className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                      {!isCustomActive && (
                        <span className="font-mono flex-shrink-0 ml-2 mt-1 text-sm text-text-tertiary">—</span>
                      )}
                    </button>
                  );
                })()}
              </div>
              {!entry && (
                <p className="text-text-tertiary text-2xs mt-2 text-center">{t("pages:step5.s09")}</p>
              )}
            </div>

            {/* Note */}
            {entry && (
              <div>
                <p className="text-2xs font-semibold text-text-tertiary mb-1">{t("pages:step5.s07")}</p>
                <input
                  type="text"
                  className="input text-base w-full"
                  placeholder={t("pages:step5.s12")}
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
              <p className="text-2xs font-semibold text-text-tertiary mb-1">{t("pages:step5.s05")}</p>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    type="number"
                    className="input input-amount text-base w-full pr-2"
                    placeholder="0.00"
                    value={entry.individualAmount ?? ""}
                    onChange={e => onUpdate({ individualAmount: e.target.value ? parseFloat(e.target.value) : undefined })}
                    min={0}
                    step={0.01}
                  />
                </div>
                <select
                  className="input text-base w-24 cursor-pointer"
                  value={entry.currency ?? "CHF"}
                  onChange={e => onUpdate({ currency: e.target.value as SupportedCurrency })}
                >
                  {SUPPORTED_CURRENCIES.map(c => (
                    <option key={c} value={c}>{CURRENCY_SYMBOLS[c]} {c}</option>
                  ))}
                </select>
              </div>
              {entry.currency && entry.currency !== "CHF" && entry.individualAmount && (
                <p className="text-text-tertiary text-2xs mt-1 flex items-center gap-1">
                  <Refresh className="w-2.5 h-2.5" />
                  {t("pages:ui.indikativer_kurs_angaben_ohne_gewaehr")}
                </p>
              )}
            </div>

            {/* Frequency */}
            <div>
              <p className="text-2xs font-semibold text-text-tertiary mb-1">{t("pages:step5.s10")}</p>
              <div className="grid grid-cols-2 gap-1">
                {FREQUENCIES.map(freq => (
                  <button
                    key={freq}
                    type="button"
                    onClick={() => onUpdate({ frequency: freq })}
                    className={clsx(
                      "rounded-md border px-2 py-2 text-xs font-medium transition-all text-left",
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
              <p className="text-2xs font-semibold text-text-tertiary mb-1">
                <Calendar className="w-3 h-3 inline mr-1 mb-1" />
                Erste Zahlung
              </p>
              <input
                type="date"
                className="input text-base w-full"
                value={entry.firstPaymentDate ?? ""}
                onChange={e => onUpdate({ firstPaymentDate: e.target.value || undefined })}
                max="2030-12-31"
              />
            </div>

            {/* Note */}
            <div>
              <p className="text-2xs font-semibold text-text-tertiary mb-1">{t("pages:step5.s07")}</p>
              <input
                type="text"
                className="input text-base w-full"
                placeholder={t("pages:step5.s13")}
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
            className="flex items-center gap-1 text-accent hover:text-accent-light text-sm transition-colors"
          >
            <OpenNewWindow className="w-3 h-3" />
            {t("pages:ui.webseite_besuchen")}
          </a>
        )}

        {/* Action */}
        <div className="pt-2 border-t border-border/50">
          {entry ? (
            <button
              type="button"
              onClick={onDeselect}
              className="w-full flex items-center justify-center gap-1 rounded-md border border-loss/30 bg-loss/8 text-loss hover:bg-loss/15 px-3 py-2 text-sm font-medium transition-all"
            >
              <Trash className="w-3 h-3" />
              {t("pages:ui.entfernen")}
            </button>
          ) : (
            <button
              type="button"
              onClick={onSelect}
              className="w-full btn-primary text-sm py-2 flex items-center justify-center gap-1"
            >
              <Check className="w-3 h-3" />
              {t("pages:ui.hinzufuegen")}
            </button>
          )}
        </div>
      </div>

      {/* ── Fixed Footer ──────────────────────────────────── */}
      {entry && (
        <footer className="flex-shrink-0 border-t border-border/50 bg-bg-surface2 px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-text-tertiary text-2xs font-semibold">{t("pages:step5.s06")}</p>
              {viewMode === "individual" && entry.frequency && entry.frequency !== "monthly" && (
                <p className="text-text-tertiary text-2xs">{FREQUENCY_LABELS[entry.frequency ?? "monthly"]}</p>
              )}
            </div>
            <div className="text-right">
              <span className="font-mono font-bold text-gain text-lg">
                {effectiveMonthly != null && effectiveMonthly > 0 ? fchf(effectiveMonthly) : "—"}
              </span>
              <span className="text-text-tertiary text-sm font-normal">/Mo</span>
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}
