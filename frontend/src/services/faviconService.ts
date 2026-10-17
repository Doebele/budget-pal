/**
 * faviconService.ts
 * Currency conversion (live ECB rates from /api/currency, static fallback) and
 * payment frequency helpers for the expense wizard.
 */
import api from "@/lib/api";

// ── Currency ────────────────────────────────────────────────────

export const SUPPORTED_CURRENCIES = ["CHF", "EUR", "USD", "GBP", "SEK", "NOK"] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

// CHF je Einheit der Fremdwährung. Startwerte nur als Rückfall (Stand
// Oktober 2026); loadLiveRates() ersetzt sie nach dem Login durch die
// EZB-Kurse des Servers. Früher stand hier EUR 1.052 — ein Euro-Betrag wurde
// so um rund 13 % zu hoch in Franken umgerechnet.
const RATES_TO_CHF: Record<string, number> = {
  CHF: 1.000,
  EUR: 0.930,
  USD: 0.830,
  GBP: 1.100,
  SEK: 0.083,
  NOK: 0.087,
};

/** EZB-Kurse vom Server holen (Basis CHF: 1 CHF = x Fremdwährung). */
export async function loadLiveRates(): Promise<Record<string, number>> {
  const { data } = await api.get("/currency/rates", { params: { base: "CHF" } });
  for (const [cur, perChf] of Object.entries(data.rates as Record<string, number>)) {
    if (perChf > 0) RATES_TO_CHF[cur] = 1 / perChf;
  }
  return RATES_TO_CHF;
}

export const CURRENCY_SYMBOLS: Record<SupportedCurrency, string> = {
  CHF: "CHF", EUR: "€", USD: "$", GBP: "£", SEK: "kr", NOK: "kr",
};

export function toCHF(amount: number, currency: SupportedCurrency | string): number {
  return +(amount * (RATES_TO_CHF[currency] ?? 1)).toFixed(2);
}

// ── Frequency ───────────────────────────────────────────────────

export const FREQUENCIES = ["monthly", "quarterly", "semiannually", "yearly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  monthly:      "Monatlich",
  quarterly:    "Quartalsweise (3 Mo.)",
  semiannually: "Halbjährlich (6 Mo.)",
  yearly:       "Jährlich (12 Mo.)",
};

const FREQUENCY_DIVISOR: Record<Frequency, number> = {
  monthly: 1, quarterly: 3, semiannually: 6, yearly: 12,
};

/** Nächste Verlängerung eines Abos: ab dem Startdatum im Takt von `everyMonths`
 *  Monaten, der erste Termin heute oder später. Monatsende wird gekappt
 *  (Start 31.01. → 28./29.02.). */
export function nextRenewal(start: string, everyMonths: number, today: Date = new Date()): Date | null {
  const [y, m, d] = start.split("-").map(Number);
  if (!y || !m || !d || everyMonths < 1) return null;
  const day0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  for (let k = 0; k < 1200; k += everyMonths) {
    const last = new Date(y, m - 1 + k + 1, 0).getDate();
    const due = new Date(y, m - 1 + k, Math.min(d, last));
    if (due >= day0) return due;
  }
  return null;
}

/** Monate pro Zahlung je Rhythmus */
export function frequencyMonths(frequency: Frequency): number {
  return FREQUENCY_DIVISOR[frequency];
}

/** Convert any amount/frequency/currency → CHF per month */
export function toMonthlyCHF(
  amount: number,
  frequency: Frequency,
  currency: SupportedCurrency
): number {
  const monthly = amount / FREQUENCY_DIVISOR[frequency];
  return +(toCHF(monthly, currency)).toFixed(2);
}

// ── Favicon URL helper ──────────────────────────────────────────

/** Returns Google's favicon CDN URL for a given website domain. */
export function getFaviconUrl(website: string, size: 16 | 32 | 64 = 32): string {
  try {
    const hostname = new URL(website).hostname.replace(/^www\./, "");
    return `https://www.google.com/s2/favicons?domain=${hostname}&sz=${size}`;
  } catch {
    return "";
  }
}
