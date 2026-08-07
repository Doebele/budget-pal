/**
 * Locale-bewusste Formatierung — folgt der UI-Sprache (i18n),
 * behält aber Schweizer Zahlen-/Währungskonventionen (de-CH/en-CH).
 */
import i18n from "@/i18n";

const LOCALE_MAP: Record<string, string> = {
  de: "de-CH",
  en: "en-CH",
};

/** Anzeige-Locale für Intl-APIs, abgeleitet aus der aktiven UI-Sprache. */
export function displayLocale(): string {
  const lang = (i18n.language || "de").slice(0, 2);
  return LOCALE_MAP[lang] ?? "de-CH";
}

export function formatDate(date: string | number | Date, options?: Intl.DateTimeFormatOptions): string {
  return new Date(date).toLocaleDateString(displayLocale(), options);
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(displayLocale(), options).format(value);
}
