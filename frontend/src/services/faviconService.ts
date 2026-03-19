/**
 * faviconService.ts
 * Currency conversion (static CHF reference rates 2024) and
 * payment frequency helpers for the expense wizard.
 */

// ── Currency ────────────────────────────────────────────────────

export const SUPPORTED_CURRENCIES = ["CHF", "EUR", "USD", "GBP", "SEK", "NOK"] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

// Approximate rates TO CHF (Zürich reference, indicative only)
const RATES_TO_CHF: Record<SupportedCurrency, number> = {
  CHF: 1.000,
  EUR: 1.052,
  USD: 0.910,
  GBP: 1.160,
  SEK: 0.088,
  NOK: 0.086,
};

export const CURRENCY_SYMBOLS: Record<SupportedCurrency, string> = {
  CHF: "CHF", EUR: "€", USD: "$", GBP: "£", SEK: "kr", NOK: "kr",
};

export function toCHF(amount: number, currency: SupportedCurrency): number {
  return +(amount * RATES_TO_CHF[currency]).toFixed(2);
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
