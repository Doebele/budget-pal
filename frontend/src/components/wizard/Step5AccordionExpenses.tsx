/**
 * Step5AccordionExpenses — Enhanced Everyday Expenses & Subscriptions
 *
 * Layout:
 *  LEFT  – Category accordions with provider checkboxes + search-first add flow
 *  RIGHT – Sticky detail sidebar for focused provider OR custom provider sidebar
 */

import { useState, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import { Activity, Cart, Check, Cloud, CreditCard, EditPencil, Home, Journal, MusicDoubleNote, NavArrowDown, NavArrowRight, Plus, Search, SmartphoneDevice, Suitcase, Train, Tv, Xmark } from "@/lib/icons";
import { clsx } from "clsx";
import { toCHF, toMonthlyCHF } from "@/services/faviconService";
import type { Frequency, SupportedCurrency } from "@/services/faviconService";
import ProviderBrandIcon from "./ProviderBrandIcon";
import ProviderSidebar from "./ProviderSidebar";
import CustomProviderSidebar from "./CustomProviderSidebar";
import { catalogText } from "./catalogI18n";
import { useTranslation } from "react-i18next";

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

/** Länder mit eigenen Tarifen (Streaming, Musik, Apple One): CH in CHF, DE/FR in EUR, US in USD */
export type Country = "CH" | "DE" | "FR" | "US";
export const COUNTRIES: Country[] = ["CH", "DE", "FR", "US"];
export const COUNTRY_CURRENCY: Record<Country, SupportedCurrency> = { CH: "CHF", DE: "EUR", FR: "EUR", US: "USD" };

export interface ProviderVariant {
  id: string;
  label: string;
  /** Monatspreis in der Schweiz (CHF); fehlt, wenn es den Tarif dort nicht gibt */
  price?: number;
  /** Monatspreise in anderen Ländern, in deren Währung (DE/FR EUR, US USD) */
  prices?: Partial<Record<Exclude<Country, "CH">, number>>;
  /** Jahresabo: der Preis ist der Monatsanteil, bezahlt wird für 12 Monate im Voraus */
  billing?: "yearly";
  description?: string;
  popular?: boolean;
}

export interface ExpenseProvider {
  id: string;
  name: string;
  tagline: string;
  website?: string;
  variants: ProviderVariant[];
  peerPopularity?: number;
  /** Weltweit in dieser Währung verrechnet (z. B. KI-Dienste in USD): `price` ist
   *  dann in dieser Währung, eine Länderwahl gibt es nicht */
  currency?: SupportedCurrency;
}

/** Preis eines Tarifs im gewählten Land, in der Abrechnungswährung; null = dort nicht erhältlich */
export function variantPrice(
  provider: ExpenseProvider, variant: ProviderVariant, country: Country = "CH",
): { amount: number; currency: SupportedCurrency } | null {
  if (provider.currency) {
    return variant.price == null ? null : { amount: variant.price, currency: provider.currency };
  }
  const amount = country === "CH" ? variant.price : variant.prices?.[country];
  return amount == null ? null : { amount, currency: COUNTRY_CURRENCY[country] };
}

/** Monatsbetrag eines Tarifs in CHF zum aktuellen Kurs */
export function variantMonthlyCHF(provider: ExpenseProvider, variant: ProviderVariant, country: Country = "CH"): number {
  const p = variantPrice(provider, variant, country);
  return p ? toCHF(p.amount, p.currency) : 0;
}

/** Länder, für die der Anbieter Tarife hat (CH immer zuerst) */
export function providerCountries(provider: ExpenseProvider): Country[] {
  if (provider.currency) return [];
  return COUNTRIES.filter((c) =>
    provider.variants.some((v) => (c === "CH" ? v.price != null : v.prices?.[c] != null)));
}

/** Gewählter Tarif; fehlt er (Katalog geändert), der beliebteste */
export function entryVariant(provider: ExpenseProvider, variantId: string): ProviderVariant {
  return provider.variants.find((v) => v.id === variantId)
    ?? provider.variants.find((v) => v.popular) ?? provider.variants[0];
}

/** Vorauswahl beim Hinzufügen: der beliebteste Tarif, den es in der Schweiz gibt,
 *  sonst im ersten Land mit Tarifen (z. B. TIDAL, Duolingo nur mit EU/US-Preisen) */
export function defaultSelection(provider: ExpenseProvider): { variantId: string; country?: Country } {
  const country = providerCountries(provider)[0] ?? "CH";
  const available = provider.variants.filter((v) => variantPrice(provider, v, country));
  const v = available.find((x) => x.popular) ?? available[0] ?? provider.variants[0];
  return country === "CH" ? { variantId: v.id } : { variantId: v.id, country };
}

export interface ExpenseCategory {
  id: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  description: string;
  providers: ExpenseProvider[];
}

export interface SelectedExpenseEntry {
  providerId: string;
  categoryId: string;
  variantId: string;
  /** Land der Tarife (Standard CH) */
  country?: Country;
  customPrice?: number;
  note?: string;
  // Individual mode fields
  viewMode?: "simple" | "individual";
  individualAmount?: number;
  frequency?: Frequency;
  currency?: SupportedCurrency;
  firstPaymentDate?: string;
}

export interface CustomExpenseEntry {
  id: string;
  categoryId: string;
  name: string;
  website?: string;
  individualAmount?: number;
  frequency?: Frequency;
  currency?: SupportedCurrency;
  firstPaymentDate?: string;
  note?: string;
  price: number; // effective monthly CHF — computed on save
}

// ─────────────────────────────────────────────────────────────────
// Provider / Category Data
// ─────────────────────────────────────────────────────────────────

export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  {
    id: "streaming",
    label: "Streaming & TV",
    Icon: Tv,
    description: "Video-Streaming und TV-Dienste",
    providers: [
      {
        id: "netflix", name: "Netflix",
        tagline: "Serien, Filme und Dokus", website: "https://netflix.com",
        peerPopularity: 68,
        variants: [
          { id: "basic",    label: "Basis",                price: 14.90, description: "Nur in der Schweiz" },
          { id: "ads",      label: "Standard mit Werbung", prices: { DE: 6.99, FR: 7.99, US: 8.99 }, description: "In der Schweiz nicht erhältlich" },
          { id: "standard", label: "Standard",             price: 22.90, prices: { DE: 15.99, FR: 14.99, US: 19.99 }, popular: true, description: "Full HD, 2 Geräte" },
          { id: "premium",  label: "Premium",              price: 29.90, prices: { DE: 21.99, FR: 21.99, US: 26.99 }, description: "4K, 4 Geräte" },
        ],
      },
      {
        id: "disney-plus", name: "Disney+",
        tagline: "Disney, Marvel, Star Wars, Pixar", website: "https://disneyplus.com",
        peerPopularity: 34,
        variants: [
          { id: "ads",           label: "Standard mit Werbung", price: 9.90,  prices: { DE: 6.99, FR: 6.99, US: 12.49 } },
          { id: "standard",      label: "Standard",             price: 16.90, prices: { DE: 10.99, FR: 10.99 }, popular: true },
          { id: "standard-year", label: "Standard, Jahresabo",  price: 14.08, prices: { DE: 9.16, FR: 9.16 }, billing: "yearly", description: "CHF 169 bzw. 109.90 € pro Jahr" },
          { id: "premium",       label: "Premium 4K",           price: 23.40, prices: { DE: 15.99, FR: 15.99, US: 21.49 } },
          { id: "premium-year",  label: "Premium, Jahresabo",   price: 19.50, prices: { DE: 13.33, FR: 13.33, US: 17.92 }, billing: "yearly", description: "CHF 234, 159.90 € bzw. $214.99 pro Jahr" },
        ],
      },
      {
        id: "amazon-prime", name: "Amazon Prime Video",
        tagline: "Prime Video (CH) bzw. Prime mit Versand (DE/FR/US)", website: "https://primevideo.com",
        peerPopularity: 29,
        variants: [
          { id: "video",      label: "Prime Video",          price: 9.99, description: "In der Schweiz nur Video" },
          { id: "prime",      label: "Prime Mitgliedschaft", prices: { DE: 8.99, FR: 6.99, US: 14.99 }, popular: true, description: "Video + Versand" },
          { id: "prime-year", label: "Prime, Jahresabo",     prices: { DE: 7.49, FR: 5.83, US: 11.58 }, billing: "yearly", description: "89.90 €, 69.90 € bzw. $139 pro Jahr" },
        ],
      },
      {
        id: "apple-tv", name: "Apple TV",
        tagline: "Apple Originals (früher Apple TV+)", website: "https://tv.apple.com",
        peerPopularity: 18,
        variants: [
          { id: "single", label: "Apple TV", price: 10.90, prices: { DE: 9.99, FR: 9.99, US: 14.99 }, popular: true, description: "Auch in Apple One enthalten" },
        ],
      },
      {
        id: "apple-one", name: "Apple One",
        tagline: "Apple Music, TV, Arcade und iCloud+ im Paket", website: "https://apple.com/apple-one",
        peerPopularity: 14,
        variants: [
          { id: "individual", label: "Einzelperson", price: 23.90, prices: { DE: 19.95, FR: 19.95, US: 21.95 }, popular: true, description: "Music, TV, Arcade, iCloud+ 50 GB" },
          { id: "family",     label: "Familie",      price: 33.90, prices: { DE: 25.95, FR: 25.95, US: 27.95 }, description: "Bis 6 Personen, iCloud+ 200 GB" },
          { id: "premier",    label: "Premium",      price: 42.90, prices: { DE: 34.95, FR: 34.95, US: 39.95 }, description: "Bis 6 Personen, iCloud+ 2 TB, Fitness+ (US zusätzlich News+)" },
        ],
      },
      {
        id: "yt-premium", name: "YouTube Premium",
        tagline: "YouTube ohne Werbung + YouTube Music", website: "https://youtube.com/premium",
        peerPopularity: 22,
        variants: [
          { id: "single", label: "Einzel",          price: 17.90, prices: { DE: 14.99, US: 15.99 }, popular: true },
          { id: "family", label: "Familie (bis 6)", price: 33.90, prices: { DE: 27.99, US: 26.99 } },
        ],
      },
      {
        id: "dazn", name: "DAZN",
        tagline: "Sport-Streaming: Fussball, Champions League", website: "https://dazn.com",
        peerPopularity: 12,
        variants: [
          { id: "monthly",          label: "Super Sports, monatlich", price: 24.90, prices: { DE: 24.99 } },
          { id: "annual",           label: "Super Sports, Jahresabo", prices: { DE: 19.99 }, billing: "yearly", popular: true },
          { id: "unlimited",        label: "Unlimited, monatlich",    price: 34.90, prices: { DE: 44.99 }, description: "Schweiz: ab-Preis" },
          { id: "unlimited-annual", label: "Unlimited, Jahresabo",    prices: { DE: 34.99 }, billing: "yearly" },
        ],
      },
    ],
  },
  {
    id: "musik",
    label: "Musik",
    Icon: MusicDoubleNote,
    description: "Musik-Streaming Dienste",
    providers: [
      {
        id: "spotify", name: "Spotify",
        tagline: "Meistgenutzter Musik-Streamingdienst", website: "https://spotify.com",
        peerPopularity: 71,
        variants: [
          { id: "individual", label: "Individual",      price: 15.95, prices: { DE: 12.99, FR: 12.14, US: 12.99 }, popular: true },
          { id: "duo",        label: "Duo (2 Pers.)",   price: 21.95, prices: { DE: 17.99, FR: 17.20, US: 18.99 } },
          { id: "family",     label: "Familie (bis 6)", price: 26.95, prices: { DE: 21.99, FR: 21.24, US: 21.99 } },
          { id: "student",    label: "Student",         price: 8.95,  prices: { DE: 6.99, FR: 7.07, US: 6.99 } },
        ],
      },
      {
        id: "apple-music", name: "Apple Music",
        tagline: "Hi-Res Audio, für Apple-Nutzer (auch in Apple One)", website: "https://music.apple.com",
        peerPopularity: 24,
        variants: [
          { id: "individual", label: "Einzelperson",    price: 14.90, prices: { DE: 11.99, FR: 11.99, US: 11.99 }, popular: true },
          { id: "family",     label: "Familie (bis 6)", price: 24.90, prices: { DE: 19.99, FR: 19.99, US: 19.99 } },
          { id: "student",    label: "Studierende",     price: 8.90,  prices: { DE: 6.99, FR: 6.99, US: 6.99 } },
        ],
      },
      {
        id: "tidal", name: "TIDAL",
        tagline: "Lossless und Dolby Atmos", website: "https://tidal.com",
        peerPopularity: 5,
        variants: [
          { id: "individual", label: "Individual",      prices: { DE: 12.99, FR: 12.99, US: 11.99 }, popular: true },
          { id: "family",     label: "Familie (bis 6)", prices: { DE: 21.99, FR: 21.99, US: 19.99 } },
          { id: "student",    label: "Studierende",     prices: { US: 6.99 } },
        ],
      },
    ],
  },
  {
    id: "cloud-software",
    label: "Cloud & Software",
    Icon: Cloud,
    description: "Cloud-Speicher und Software-Abos",
    providers: [
      {
        id: "icloud", name: "iCloud+",
        tagline: "Apple Cloud-Speicher", website: "https://apple.com/icloud",
        peerPopularity: 55,
        variants: [
          { id: "50gb",  label: "50 GB",  price: 0.99 },
          { id: "200gb", label: "200 GB", price: 2.99, popular: true },
          { id: "2tb",   label: "2 TB",   price: 9.99 },
        ],
      },
      {
        id: "google-one", name: "Google One",
        tagline: "Google Cloud-Speicher", website: "https://one.google.com",
        peerPopularity: 28,
        variants: [
          { id: "100gb", label: "100 GB", price: 2.99 },
          { id: "200gb", label: "200 GB", price: 3.99, popular: true },
          { id: "2tb",   label: "2 TB",   price: 9.99 },
        ],
      },
      {
        id: "ms365", name: "Microsoft 365",
        tagline: "Word, Excel, PowerPoint, 1 TB OneDrive", website: "https://microsoft.com/365",
        peerPopularity: 42,
        variants: [
          { id: "personal", label: "Personal (1 Nutzer)",  price: 9.00, popular: true },
          { id: "family",   label: "Familie (bis 6)",      price: 12.00 },
        ],
      },
      {
        id: "adobe-cc", name: "Adobe Creative Cloud",
        tagline: "Photoshop, Illustrator, Premiere, InDesign", website: "https://adobe.com",
        peerPopularity: 11,
        variants: [
          { id: "photography", label: "Photography (LR+PS)", price: 14.24 },
          { id: "single-app",  label: "Einzelne App",        price: 29.99 },
          { id: "all-apps",    label: "Alle Apps",            price: 59.99, popular: true },
        ],
      },
      {
        id: "1password", name: "1Password",
        tagline: "Passwort-Manager", website: "https://1password.com",
        peerPopularity: 18,
        variants: [
          { id: "individual", label: "Individual",      price: 3.99, popular: true },
          { id: "family",     label: "Familie (bis 5)", price: 6.99 },
        ],
      },
      {
        id: "chatgpt", name: "ChatGPT",
        tagline: "OpenAI, verrechnet in USD", website: "https://chatgpt.com",
        peerPopularity: 24, currency: "USD",
        variants: [
          { id: "go",            label: "Go",                              price: 8,   description: "Mit Werbung, Preis je nach Region" },
          { id: "plus",          label: "Plus",                            price: 20,  popular: true },
          { id: "pro",           label: "Pro",                             price: 200, description: "Höchste Limits" },
          { id: "business",      label: "Business (pro Platz)",            price: 25,  description: "Ab 2 Plätzen" },
          { id: "business-year", label: "Business, Jahresabo (pro Platz)", price: 20,  billing: "yearly" },
        ],
      },
    ],
  },
  {
    id: "kommunikation",
    label: "Kommunikation",
    Icon: SmartphoneDevice,
    description: "Internet, Mobile und Festnetz",
    providers: [
      {
        id: "swisscom-internet", name: "Swisscom Internet",
        tagline: "Glasfaser/VDSL, Marktführer Schweiz", website: "https://swisscom.ch",
        peerPopularity: 38,
        variants: [
          { id: "vivo-s",       label: "vivo S (1 Gbit/s)",           price: 49.95 },
          { id: "vivo-m",       label: "vivo M (10 Gbit/s)",          price: 59.95, popular: true },
          { id: "inone-home-s", label: "inOne home S (inkl. TV)",     price: 75.95 },
          { id: "inone-home-m", label: "inOne home M (TV + Festnetz)", price: 89.95 },
        ],
      },
      {
        id: "sunrise-internet", name: "Sunrise Internet",
        tagline: "Breitband & TV von Sunrise", website: "https://sunrise.ch",
        peerPopularity: 22,
        variants: [
          { id: "m", label: "Internet M",          price: 39.90 },
          { id: "l", label: "Internet L",          price: 49.90, popular: true },
          { id: "connect", label: "Connect M (TV)", price: 69.90 },
        ],
      },
      {
        id: "salt-home", name: "Salt Home",
        tagline: "Günstiges Glasfaser-Internet", website: "https://salt.ch",
        peerPopularity: 12,
        variants: [
          { id: "fiber",    label: "Home Fiber",        price: 34.95, popular: true, description: "1 Gbit/s" },
          { id: "fiber-tv", label: "Home Fiber + TV",   price: 49.95 },
        ],
      },
      {
        id: "swisscom-mobile", name: "Swisscom Mobile",
        tagline: "Bestes Netz der Schweiz", website: "https://swisscom.ch",
        peerPopularity: 35,
        variants: [
          { id: "s", label: "inOne mobile S", price: 39.00 },
          { id: "m", label: "inOne mobile M", price: 55.00, popular: true },
          { id: "l", label: "inOne mobile L", price: 75.00 },
        ],
      },
      {
        id: "sunrise-mobile", name: "Sunrise Mobile",
        tagline: "Günstig und schnell", website: "https://sunrise.ch",
        peerPopularity: 20,
        variants: [
          { id: "s",         label: "Classic S",   price: 29.90 },
          { id: "m",         label: "Classic M",   price: 39.90, popular: true },
          { id: "unlimited", label: "Unlimited",   price: 55.00 },
        ],
      },
      {
        id: "wingo", name: "Wingo",
        tagline: "Swisscom-Netz zum Sparpreis", website: "https://wingo.ch",
        peerPopularity: 16,
        variants: [
          { id: "m",  label: "M (5 GB)",          price: 19.00 },
          { id: "l",  label: "L (15 GB)",         price: 24.00, popular: true },
          { id: "xl", label: "XL (Unlimitiert)",  price: 29.00 },
        ],
      },
      {
        id: "salt-mobile", name: "Salt Mobile",
        tagline: "Günstige Alternative", website: "https://salt.ch",
        peerPopularity: 12,
        variants: [
          { id: "m", label: "M",                  price: 19.95 },
          { id: "l", label: "L (Unlimitiert)",    price: 24.95, popular: true },
        ],
      },
    ],
  },
  {
    id: "news-medien",
    label: "News & Medien",
    Icon: Journal,
    description: "Zeitungen, Magazine und Nachrichtenangebote",
    providers: [
      {
        id: "nzz", name: "NZZ Digital",
        tagline: "Neue Zürcher Zeitung – Premium-Journalismus", website: "https://nzz.ch",
        peerPopularity: 24,
        variants: [
          { id: "standard", label: "NZZ Digital",            price: 31.90, popular: true },
          { id: "premium",  label: "NZZ Premium (+ Print)",  price: 49.90 },
        ],
      },
      {
        id: "tagi", name: "Tages-Anzeiger",
        tagline: "Tagi Digital Abo", website: "https://tagesanzeiger.ch",
        peerPopularity: 18,
        variants: [
          { id: "basis",   label: "Digital Basis",   price: 9.90 },
          { id: "premium", label: "Digital Premium", price: 24.90, popular: true },
        ],
      },
      {
        id: "blick-plus", name: "Blick+",
        tagline: "Blick Plus Digital", website: "https://blick.ch",
        peerPopularity: 11,
        variants: [
          { id: "plus", label: "Blick+", price: 12.90, popular: true },
        ],
      },
      {
        id: "guardian", name: "The Guardian",
        tagline: "Unabhängiger Qualitätsjournalismus (EN)", website: "https://theguardian.com",
        peerPopularity: 8,
        variants: [
          { id: "supporter",  label: "Supporter",   price: 7.00 },
          { id: "all-access", label: "All Access",  price: 14.00, popular: true },
        ],
      },
    ],
  },
  {
    id: "fitness",
    label: "Fitness & Sport",
    Icon: Activity,
    description: "Fitnesscenter, Sport-Apps und Clubs",
    providers: [
      {
        id: "fitnesscenter", name: "Fitnesscenter",
        tagline: "Monatliches Fitnesscenter-Abo",
        peerPopularity: 42,
        variants: [
          { id: "basis",    label: "Basismitgliedschaft",     price: 50 },
          { id: "standard", label: "Standard",                price: 80, popular: true },
          { id: "premium",  label: "Premium (inkl. Kurse)",   price: 120 },
        ],
      },
      {
        id: "apple-fitness", name: "Apple Fitness+",
        tagline: "Online-Workouts von Apple", website: "https://apple.com/apple-fitness-plus",
        peerPopularity: 12,
        variants: [
          { id: "individual", label: "Individual", price: 9.99, popular: true },
          { id: "family",     label: "Familie",    price: 14.99 },
        ],
      },
      {
        id: "strava", name: "Strava Premium",
        tagline: "GPS-Tracking für Läufer & Radfahrer", website: "https://strava.com",
        peerPopularity: 19,
        variants: [
          { id: "monthly", label: "Monatlich",             price: 10.99 },
          { id: "annual",  label: "Jährlich (pro Monat)", price: 7.50, popular: true },
        ],
      },
      {
        id: "schwimmbad", name: "Schwimmbad-Abo",
        tagline: "Monatskarte Hallenbad",
        peerPopularity: 14,
        variants: [
          { id: "einzel",  label: "Einzelperson",  price: 35, popular: true },
          { id: "familie", label: "Familie",        price: 65 },
        ],
      },
    ],
  },
  {
    id: "mobilitaet",
    label: "Mobilität (ÖV-Abos)",
    Icon: Train,
    description: "SBB und weitere ÖV-Abonnements",
    providers: [
      {
        id: "sbb-halbtax", name: "SBB Halbtax",
        tagline: "Alle ÖV-Tickets zum halben Preis", website: "https://sbb.ch",
        peerPopularity: 62,
        variants: [
          { id: "standard",      label: "Halbtax (Jahresabo)",       price: 19.40, popular: true, description: "CHF 233/Jahr" },
          { id: "railaway",      label: "Halbtax + Railaway",        price: 21.65 },
        ],
      },
      {
        id: "sbb-ga", name: "SBB Generalabonnement",
        tagline: "Unlimitiert Reisen in der ganzen Schweiz", website: "https://sbb.ch",
        peerPopularity: 18,
        variants: [
          { id: "2kl", label: "2. Klasse", price: 345.00, popular: true, description: "CHF 4'140/Jahr" },
          { id: "1kl", label: "1. Klasse", price: 565.00, description: "CHF 6'780/Jahr" },
        ],
      },
      {
        id: "mobility", name: "Mobility Carsharing",
        tagline: "Carsharing mit 3'000+ Autos schweizweit", website: "https://mobility.ch",
        peerPopularity: 11,
        variants: [
          { id: "easy",    label: "Easy (kein Abo)",  price: 0, description: "Nur Nutzungsgebühren" },
          { id: "classic", label: "Classic Abo",      price: 9.90, popular: true },
          { id: "plus",    label: "Plus Abo",         price: 19.90 },
        ],
      },
    ],
  },
  {
    id: "business",
    label: "Business & Weiterbildung",
    Icon: Suitcase,
    description: "Business-Tools, Weiterbildung und KI-Dienste",
    providers: [
      {
        id: "linkedin", name: "LinkedIn Premium",
        tagline: "Karriere-Netzwerk, inklusive LinkedIn Learning", website: "https://linkedin.com",
        peerPopularity: 19,
        variants: [
          { id: "career",   label: "Premium Career",   price: 44.99, popular: true },
          { id: "business", label: "Premium Business", price: 69.99 },
          { id: "sales",    label: "Sales Navigator",  price: 129.99 },
        ],
      },
      {
        id: "claude-pro", name: "Claude",
        tagline: "Anthropic, verrechnet in USD", website: "https://claude.ai",
        peerPopularity: 12, currency: "USD",
        variants: [
          { id: "pro",       label: "Pro",                                  price: 20, popular: true },
          { id: "pro-year",  label: "Pro, Jahresabo",                       price: 17, billing: "yearly", description: "$200 pro Jahr" },
          { id: "max5",      label: "Max (5× Pro)",                         price: 100 },
          { id: "max20",     label: "Max (20× Pro)",                        price: 200 },
          { id: "team",      label: "Team Standard (pro Platz)",            price: 25 },
          { id: "team-year", label: "Team Standard, Jahresabo (pro Platz)", price: 20, billing: "yearly" },
        ],
      },
      {
        id: "google-gemini", name: "Google Gemini",
        tagline: "Google AI mit Gemini, inklusive Google-One-Speicher", website: "https://gemini.google.com",
        peerPopularity: 16,
        variants: [
          { id: "plus",  label: "Google AI Plus",  price: 10, description: "2 TB Speicher" },
          { id: "pro",   label: "Google AI Pro",   price: 17, prices: { US: 19.99 }, popular: true, description: "5 TB Speicher" },
          { id: "ultra", label: "Google AI Ultra", prices: { US: 99.99 }, description: "Höchste Limits" },
        ],
      },
      {
        id: "perplexity", name: "Perplexity",
        tagline: "KI-Suche, verrechnet in USD", website: "https://perplexity.ai",
        peerPopularity: 8, currency: "USD",
        variants: [
          { id: "pro",      label: "Pro",            price: 20, popular: true },
          { id: "pro-year", label: "Pro, Jahresabo", price: 16.67, billing: "yearly", description: "$200 pro Jahr" },
          { id: "max",      label: "Max",            price: 200 },
          { id: "max-year", label: "Max, Jahresabo", price: 166.67, billing: "yearly", description: "$2'000 pro Jahr" },
        ],
      },
      {
        id: "mistral", name: "Mistral Le Chat",
        tagline: "Europäische KI, verrechnet in USD", website: "https://chat.mistral.ai",
        peerPopularity: 3, currency: "USD",
        variants: [
          { id: "pro",  label: "Pro",               price: 14.99, popular: true },
          { id: "team", label: "Team (pro Nutzer)", price: 24.99 },
        ],
      },
      {
        id: "cursor", name: "Cursor",
        tagline: "KI-Editor für Entwicklung, verrechnet in USD", website: "https://cursor.com",
        peerPopularity: 9, currency: "USD",
        variants: [
          { id: "plus",    label: "Plus",               price: 8 },
          { id: "premium", label: "Premium",            price: 30, popular: true },
          { id: "super",   label: "Super",              price: 100 },
          { id: "ultra",   label: "Ultra",              price: 200 },
          { id: "teams",   label: "Teams (pro Nutzer)", price: 30 },
        ],
      },
      {
        id: "github-copilot", name: "GitHub Copilot",
        tagline: "KI-Assistent im Code-Editor, verrechnet in USD", website: "https://github.com/features/copilot",
        peerPopularity: 7, currency: "USD",
        variants: [
          { id: "pro",      label: "Pro",  price: 10, popular: true },
          { id: "pro-plus", label: "Pro+", price: 39 },
          { id: "max",      label: "Max",  price: 100 },
        ],
      },
      {
        id: "midjourney", name: "Midjourney",
        tagline: "KI-Bilder, verrechnet in USD", website: "https://midjourney.com",
        peerPopularity: 4, currency: "USD",
        variants: [
          { id: "basic",         label: "Basic",               price: 10 },
          { id: "basic-year",    label: "Basic, Jahresabo",    price: 8,  billing: "yearly" },
          { id: "standard",      label: "Standard",            price: 30, popular: true },
          { id: "standard-year", label: "Standard, Jahresabo", price: 24, billing: "yearly" },
          { id: "pro",           label: "Pro",                 price: 60 },
          { id: "pro-year",      label: "Pro, Jahresabo",      price: 48, billing: "yearly" },
          { id: "mega",          label: "Mega",                price: 120 },
          { id: "mega-year",     label: "Mega, Jahresabo",     price: 96, billing: "yearly" },
        ],
      },
      {
        id: "notion", name: "Notion",
        tagline: "All-in-one Workspace", website: "https://notion.so",
        peerPopularity: 14,
        variants: [
          { id: "plus",     label: "Plus",     price: 9.00, popular: true },
          { id: "business", label: "Business", price: 17.00 },
        ],
      },
      {
        id: "figma", name: "Figma",
        tagline: "Design und Prototyping", website: "https://figma.com",
        peerPopularity: 8,
        variants: [
          { id: "professional", label: "Professional (pro Platz)", price: 13.50, popular: true },
          { id: "organization", label: "Organization (pro Platz)", price: 40.00 },
        ],
      },
      {
        id: "kimi", name: "Kimi",
        tagline: "Moonshot AI mit langem Kontext", website: "https://kimi.moonshot.cn",
        peerPopularity: 4,
        variants: [
          { id: "plus", label: "Plus", price: 18.00, popular: true },
        ],
      },
      {
        id: "z-ai", name: "Z.AI",
        tagline: "GLM-Modelle, günstiger Coding-Plan", website: "https://z.ai",
        peerPopularity: 3,
        variants: [
          { id: "lite", label: "Coding Lite", price: 3.00, popular: true },
          { id: "pro",  label: "Coding Pro",  price: 14.00 },
        ],
      },
      {
        id: "higgsfield", name: "Higgsfield",
        tagline: "KI-Generierung für Bild und Video", website: "https://higgsfield.ai",
        peerPopularity: 3,
        variants: [
          { id: "basic",   label: "Basic",   price: 8.00 },
          { id: "pro",     label: "Pro",     price: 26.00, popular: true },
          { id: "ultimate", label: "Ultimate", price: 45.00 },
        ],
      },
      {
        id: "slack", name: "Slack",
        tagline: "Team-Kommunikation", website: "https://slack.com",
        peerPopularity: 11,
        variants: [
          { id: "pro",      label: "Pro (pro Nutzer)",      price: 7.50, popular: true },
          { id: "biz-plus", label: "Business+ (pro Nutzer)", price: 12.50 },
        ],
      },
      {
        id: "linkedin-learning", name: "LinkedIn Learning",
        tagline: "Video-Kurse, verrechnet in USD (in Premium Career enthalten)", website: "https://linkedin.com/learning",
        peerPopularity: 6, currency: "USD",
        variants: [
          { id: "monthly", label: "Monatlich", price: 39.99 },
          { id: "annual",  label: "Jahresabo", price: 19.99, billing: "yearly", popular: true },
        ],
      },
      {
        id: "coursera", name: "Coursera Plus",
        tagline: "Kurse und Zertifikate von Hochschulen, verrechnet in USD", website: "https://coursera.org",
        peerPopularity: 4, currency: "USD",
        variants: [
          { id: "monthly", label: "Monatlich", price: 59 },
          { id: "annual",  label: "Jahresabo", price: 33.25, billing: "yearly", popular: true, description: "$399 pro Jahr" },
        ],
      },
      {
        id: "duolingo", name: "Duolingo",
        tagline: "Sprachen lernen (Preise aus Deutschland)", website: "https://duolingo.com",
        peerPopularity: 9,
        variants: [
          { id: "super-year", label: "Super, Jahresabo",       prices: { DE: 6.99 },  billing: "yearly", popular: true },
          { id: "max",        label: "Max, monatlich",         prices: { DE: 29.99 } },
          { id: "max-year",   label: "Max, Jahresabo",         prices: { DE: 14.99 }, billing: "yearly" },
          { id: "family",     label: "Familie Max, Jahresabo", prices: { DE: 19.99 }, billing: "yearly", description: "Bis 6 Profile" },
        ],
      },
      {
        id: "babbel", name: "Babbel",
        tagline: "Sprachkurse (Preise aus Deutschland)", website: "https://babbel.com",
        peerPopularity: 5,
        variants: [
          { id: "3m",  label: "3 Monate (pro Monat)",  prices: { DE: 17.99 } },
          { id: "6m",  label: "6 Monate (pro Monat)",  prices: { DE: 13.99 } },
          { id: "12m", label: "12 Monate (pro Monat)", prices: { DE: 8.99 }, billing: "yearly", popular: true },
        ],
      },
    ],
  },
  {
    id: "haus-garten",
    label: "Haus & Garten",
    Icon: Home,
    description: "Haushaltshilfe, Gartenpflege und Heimdienste",
    providers: [
      {
        id: "reinigung", name: "Reinigungshilfe",
        tagline: "Regelmässige Putz-/Reinigungshilfe",
        peerPopularity: 28,
        variants: [
          { id: "2h-wo",   label: "2h/Woche",             price: 200, description: "ca. CHF 25/h × 8h/Monat" },
          { id: "4h-wo",   label: "4h/Woche",             price: 400, popular: true, description: "ca. CHF 25/h × 16h/Monat" },
          { id: "tage",    label: "1 Tagespauschale/Mo",  price: 300 },
        ],
      },
      {
        id: "gartenpflege", name: "Gartenpflege",
        tagline: "Monatliche Gartenpflege",
        peerPopularity: 15,
        variants: [
          { id: "klein",  label: "Kleingarten (2h/Mo)",  price: 100 },
          { id: "mittel", label: "Mittelgross",           price: 200, popular: true },
          { id: "gross",  label: "Grossgarten",           price: 350 },
        ],
      },
      {
        id: "security", name: "Sicherheitssystem",
        tagline: "Abo für Heimsicherheit (z.B. Securitas)",
        peerPopularity: 9,
        variants: [
          { id: "basic", label: "Basic Monitoring",  price: 29.90 },
          { id: "full",  label: "Full Service",      price: 59.90, popular: true },
        ],
      },
    ],
  },
  {
    id: "finanzdienste",
    label: "Finanzdienste",
    Icon: CreditCard,
    description: "Konto-, Karten- und Depotgebühren",
    providers: [
      {
        id: "ubs", name: "UBS",
        tagline: "Privatkonto mit Debitkarte (Richtwert, Preisblatt prüfen)", website: "https://ubs.com/ch",
        peerPopularity: 30,
        variants: [
          { id: "key4", label: "UBS key4 banking", price: 3, popular: true, description: "Rund CHF 36 pro Jahr bei Nutzung in der Schweiz" },
        ],
      },
      {
        id: "postfinance", name: "PostFinance",
        tagline: "Privatkonto (Richtwert, Preisblatt prüfen)", website: "https://postfinance.ch",
        peerPopularity: 28,
        variants: [
          { id: "smart", label: "Smart", price: 5, popular: true, description: "Gratis mit Hypothek, Versicherung oder Anlagen" },
        ],
      },
      {
        id: "zkb", name: "Zürcher Kantonalbank",
        tagline: "Privatkonto (Richtwert, Preisblatt prüfen)", website: "https://zkb.ch",
        peerPopularity: 16,
        variants: [
          { id: "banking", label: "ZKB Banking", price: 0, popular: true, description: "Ohne Kontoführungsgebühr" },
        ],
      },
      {
        id: "raiffeisen", name: "Raiffeisen",
        tagline: "Privatkonto (Richtwert, je Raiffeisenbank verschieden)", website: "https://raiffeisen.ch",
        peerPopularity: 22,
        variants: [
          { id: "package", label: "Kontopaket", price: 7, popular: true, description: "Rund CHF 84 pro Jahr" },
        ],
      },
      {
        id: "migros-bank", name: "Migros Bank",
        tagline: "Privatkonto (Richtwert, Preisblatt prüfen)", website: "https://migrosbank.ch",
        peerPopularity: 12,
        variants: [
          { id: "free", label: "Privatkonto", price: 0, popular: true, description: "Ohne Kontoführungsgebühr" },
        ],
      },
      {
        id: "valiant", name: "Valiant",
        tagline: "Privatkonto (Richtwert, Preisblatt prüfen)", website: "https://valiant.ch",
        peerPopularity: 6,
        variants: [
          { id: "lila", label: "Lila Set", price: 0, popular: true, description: "Ohne Kontoführungsgebühr" },
        ],
      },
      {
        id: "cler", name: "Bank Cler (Zak)",
        tagline: "Smartphone-Konto (Richtwert)", website: "https://cler.ch",
        peerPopularity: 5,
        variants: [
          { id: "zak",      label: "Zak",      price: 0, popular: true },
          { id: "zak-plus", label: "Zak Plus", price: 8 },
        ],
      },
      {
        id: "revolut", name: "Revolut",
        tagline: "Konto und Karte mit Fremdwährungen", website: "https://revolut.com",
        peerPopularity: 24,
        variants: [
          { id: "standard", label: "Standard", price: 0.00, description: "Kostenlos" },
          { id: "plus",     label: "Plus",     price: 3.99 },
          { id: "premium",  label: "Premium",  price: 9.99, popular: true },
          { id: "metal",    label: "Metal",    price: 16.99 },
          { id: "ultra",    label: "Ultra",    price: 45.00 },
        ],
      },
      {
        id: "trade-republic", name: "Trade Republic",
        tagline: "Broker mit Verrechnungskonto", website: "https://traderepublic.com",
        peerPopularity: 14,
        variants: [
          { id: "free",   label: "Kostenlos",                 price: 0.00, popular: true },
          { id: "orders", label: "Ordergebühren (geschätzt)", price: 3.00, description: "z. B. 3 Trades/Monat" },
        ],
      },
      {
        id: "neon", name: "neon",
        tagline: "Schweizer Smartphone-Konto", website: "https://neon-free.ch",
        peerPopularity: 18,
        variants: [
          { id: "free",  label: "neon free",  price: 0.00, popular: true },
          { id: "green", label: "neon green", price: 5.00 },
          { id: "metal", label: "neon metal", price: 16.00 },
        ],
      },
      {
        id: "yuh", name: "Yuh",
        tagline: "Konto, Anlegen und Vorsorge in einer App", website: "https://yuh.com",
        peerPopularity: 11,
        variants: [
          { id: "free", label: "Kostenlos", price: 0.00, popular: true },
        ],
      },
      {
        id: "n26", name: "N26",
        tagline: "Digitales Konto mit Karte", website: "https://n26.com",
        peerPopularity: 9,
        variants: [
          { id: "standard", label: "Standard", price: 0.00, popular: true },
          { id: "smart",    label: "Smart",    price: 4.90 },
          { id: "you",      label: "You",      price: 9.90 },
          { id: "metal",    label: "Metal",    price: 16.90 },
        ],
      },
      {
        id: "swissquote", name: "Swissquote",
        tagline: "Schweizer Online-Broker", website: "https://swissquote.ch",
        peerPopularity: 8,
        variants: [
          { id: "custody", label: "Depotgebühr (geschätzt)", price: 5.00, popular: true },
        ],
      },
      {
        id: "interactive-brokers", name: "Interactive Brokers",
        tagline: "Internationaler Broker", website: "https://interactivebrokers.com",
        peerPopularity: 5,
        variants: [
          { id: "orders", label: "Ordergebühren (geschätzt)", price: 4.00, popular: true },
        ],
      },
    ],
  },
  {
    id: "shopping-loyalty",
    label: "Shopping & Loyalität",
    Icon: Cart,
    description: "Kundenprogramme und Shopping-Abos",
    providers: [
      {
        id: "cumulus-extra", name: "Migros Cumulus Extra",
        tagline: "Erweiterte Cumulus-Vorteile + Rabattpässe", website: "https://migros.ch",
        peerPopularity: 22,
        variants: [
          { id: "extra", label: "Cumulus Extra", price: 7.95, popular: true },
        ],
      },
      {
        id: "galaxus-plus", name: "Galaxus Plus",
        tagline: "Kostenloser Versand bei Digitec/Galaxus", website: "https://galaxus.ch",
        peerPopularity: 16,
        variants: [
          { id: "plus", label: "Galaxus Plus", price: 4.95, popular: true },
        ],
      },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────

function fchf(n: number): string {
  if (n === 0) return "Gratis";
  return `CHF ${n % 1 === 0 ? n : n.toFixed(2)}`;
}

export function getEffectiveMonthly(entry: SelectedExpenseEntry, providers: ExpenseProvider[]): number {
  if (entry.viewMode === "individual" && entry.individualAmount != null) {
    return toMonthlyCHF(entry.individualAmount, entry.frequency ?? "monthly", entry.currency ?? "CHF");
  }
  if (entry.customPrice != null) return entry.customPrice;
  // Tarif-IDs wie «individual» gibt es bei mehreren Anbietern: über den Anbieter suchen
  const provider = providers.find(p => p.id === entry.providerId);
  const variant = provider && entryVariant(provider, entry.variantId);
  return provider && variant ? variantMonthlyCHF(provider, variant, entry.country ?? "CH") : 0;
}

function getEffectiveMonthlyCustom(entry: CustomExpenseEntry): number {
  return entry.price; // already computed as monthly CHF on save
}

function searchProviders(query: string): Array<{ provider: ExpenseProvider; category: ExpenseCategory }> {
  if (!query.trim()) return [];
  const q = query.toLowerCase();
  const results: Array<{ provider: ExpenseProvider; category: ExpenseCategory }> = [];
  for (const cat of EXPENSE_CATEGORIES) {
    for (const prov of cat.providers) {
      if (prov.name.toLowerCase().includes(q) || prov.tagline.toLowerCase().includes(q)) {
        results.push({ provider: prov, category: cat });
      }
    }
  }
  return results.slice(0, 6);
}

// ─────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────

interface Props {
  data: {
    expenseEntries: SelectedExpenseEntry[];
    customExpenseEntries: CustomExpenseEntry[];
  };
  update: (p: Partial<{ expenseEntries: SelectedExpenseEntry[]; customExpenseEntries: CustomExpenseEntry[] }>) => void;
}

// ─────────────────────────────────────────────────────────────────
// Custom sidebar state type
// ─────────────────────────────────────────────────────────────────

type CustomSidebarState =
  | { mode: "new"; categoryId: string; initialName?: string }
  | { mode: "edit"; entryId: string };

// ─────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────

export default function Step5AccordionExpenses({ data, update }: Props) {
  const { t } = useTranslation();
  const [openCategories, setOpenCategories] = useState<Set<string>>(
    new Set(["streaming", "kommunikation"])
  );
  const [focusedProviderId, setFocusedProviderId] = useState<string | null>(null);
  const [focusedCategoryId, setFocusedCategoryId] = useState<string | null>(null);

  // Search-first add flow state
  const [searchCategoryId, setSearchCategoryId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [customSidebarState, setCustomSidebarState] = useState<CustomSidebarState | null>(null);

  // O(1) lookup map: providerId → entry
  const selectedMap = useMemo(() => {
    const m: Record<string, SelectedExpenseEntry> = {};
    for (const e of data.expenseEntries) m[e.providerId] = e;
    return m;
  }, [data.expenseEntries]);

  // Monthly total
  const totalMonthly = useMemo(() => {
    let sum = 0;
    for (const e of data.expenseEntries) {
      const cat = EXPENSE_CATEGORIES.find(c => c.id === e.categoryId);
      const providers = cat?.providers ?? [];
      sum += getEffectiveMonthly(e, providers);
    }
    for (const c of data.customExpenseEntries) sum += getEffectiveMonthlyCustom(c);
    return sum;
  }, [data.expenseEntries, data.customExpenseEntries]);

  // Focused objects for sidebar
  const focusedCategory = EXPENSE_CATEGORIES.find(c => c.id === focusedCategoryId) ?? null;
  const focusedProvider = focusedCategory?.providers.find(p => p.id === focusedProviderId) ?? null;
  const focusedEntry = focusedProviderId ? (selectedMap[focusedProviderId] ?? null) : null;

  // ── Handlers ──────────────────────────────────────────────────

  function toggleCategory(id: string) {
    setOpenCategories(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function openSidebar(provider: ExpenseProvider, categoryId: string) {
    setFocusedProviderId(provider.id);
    setFocusedCategoryId(categoryId);
    setCustomSidebarState(null); // close custom sidebar when opening provider sidebar
  }

  function closeSidebarProvider() {
    setFocusedProviderId(null);
    setFocusedCategoryId(null);
  }

  function openCustomNew(categoryId: string, initialName?: string) {
    setCustomSidebarState({ mode: "new", categoryId, initialName });
    closeSidebarProvider();
    setSearchCategoryId(null);
    setSearchQuery("");
  }

  function openCustomEdit(entryId: string) {
    setCustomSidebarState({ mode: "edit", entryId });
    closeSidebarProvider();
  }

  function closeCustomSidebar() {
    setCustomSidebarState(null);
  }

  function handleCustomSave(entry: CustomExpenseEntry) {
    const existing = data.customExpenseEntries.findIndex(e => e.id === entry.id);
    if (existing >= 0) {
      update({ customExpenseEntries: data.customExpenseEntries.map(e => e.id === entry.id ? entry : e) });
    } else {
      update({ customExpenseEntries: [...data.customExpenseEntries, entry] });
    }
    closeCustomSidebar();
  }

  function handleSearchSelect(provider: ExpenseProvider, category: ExpenseCategory) {
    setOpenCategories(prev => { const next = new Set(prev); next.add(category.id); return next; });
    if (!selectedMap[provider.id]) {
      const defaultSel = defaultSelection(provider);
      update({ expenseEntries: [...data.expenseEntries, { providerId: provider.id, categoryId: category.id, ...defaultSel }] });
    }
    openSidebar(provider, category.id);
    setSearchCategoryId(null);
    setSearchQuery("");
  }

  function handleProviderClick(provider: ExpenseProvider, categoryId: string) {
    const isSelected = !!selectedMap[provider.id];
    if (!isSelected) {
      // Select with popular variant as default
      const defaultSel = defaultSelection(provider);
      update({
        expenseEntries: [
          ...data.expenseEntries,
          { providerId: provider.id, categoryId, ...defaultSel },
        ],
      });
    }
    openSidebar(provider, categoryId);
  }

  function handleCheckboxClick(e: React.MouseEvent, provider: ExpenseProvider, categoryId: string) {
    e.stopPropagation();
    const isSelected = !!selectedMap[provider.id];
    if (isSelected) {
      update({ expenseEntries: data.expenseEntries.filter(x => x.providerId !== provider.id) });
      if (focusedProviderId === provider.id) closeSidebarProvider();
    } else {
      const defaultSel = defaultSelection(provider);
      update({
        expenseEntries: [
          ...data.expenseEntries,
          { providerId: provider.id, categoryId, ...defaultSel },
        ],
      });
      openSidebar(provider, categoryId);
    }
  }

  function removeProvider(providerId: string) {
    update({ expenseEntries: data.expenseEntries.filter(e => e.providerId !== providerId) });
    if (focusedProviderId === providerId) closeSidebarProvider();
  }

  function updateEntry(providerId: string, patch: Partial<SelectedExpenseEntry>) {
    update({
      expenseEntries: data.expenseEntries.map(e =>
        e.providerId === providerId ? { ...e, ...patch } : e
      ),
    });
  }

  function removeCustomEntry(id: string) {
    update({ customExpenseEntries: data.customExpenseEntries.filter(e => e.id !== id) });
  }

  const totalCount = data.expenseEntries.length + data.customExpenseEntries.length;

  // Mobile overlay open state
  const mobileOverlayOpen = !!(focusedProvider || customSidebarState);

  // Lock body scroll ONLY on mobile (< lg = 1024px) when the overlay is open
  useEffect(() => {
    if (mobileOverlayOpen && window.innerWidth < 1024) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [mobileOverlayOpen]);

  function closeMobileOverlay() {
    closeSidebarProvider();
    closeCustomSidebar();
  }

  // ── Render ────────────────────────────────────────────────────

  return (
    <div className="flex gap-5 items-start">

      {/* ── LEFT: Accordion ─────────────────────────────────── */}
      <div className="flex-1 min-w-0 space-y-3">

        {/* Header */}
        <div>
          <h2 className="text-text-primary font-semibold text-lg">{t("pages:step5.s00")}</h2>
          <p className="text-text-secondary text-base mt-1">
            {t("pages:ui.waehle_deine_anbieter_aus_klicke_auf_eine_ze")}
          </p>
        </div>

        {/* Summary bar */}
        <div className="flex items-center justify-between rounded-lg bg-bg-surface2 border border-border/50 px-4 py-2">
          <div className="flex items-center gap-2 text-text-secondary text-base">
            <Check className="w-3.5 h-3.5 text-gain" />
            <span>{totalCount} Positionen ausgewählt</span>
          </div>
          <span className="font-mono font-semibold text-text-primary">{fchf(totalMonthly)}<span className="text-text-tertiary font-normal">/Mo</span></span>
        </div>

        {/* Category accordions */}
        {EXPENSE_CATEGORIES.map(cat => {
          const isOpen = openCategories.has(cat.id);
          const selCount =
            data.expenseEntries.filter(e => e.categoryId === cat.id).length +
            data.customExpenseEntries.filter(e => e.categoryId === cat.id).length;

          return (
            <div key={cat.id} className="bg-bg-surface border border-border/50 rounded-lg overflow-hidden">

              {/* Accordion toggle */}
              <button
                type="button"
                onClick={() => toggleCategory(cat.id)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/[0.02] transition-colors text-left"
              >
                <cat.Icon className="w-5 h-5 text-text-secondary flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-text-primary text-base font-medium">{catalogText(cat.label)}</div>
                  <div className="text-text-tertiary text-sm">{catalogText(cat.description)}</div>
                </div>
                {selCount > 0 && (
                  <span className="bg-accent/20 text-accent text-xs font-semibold px-2 py-1 rounded-full flex-shrink-0">
                    {selCount}
                  </span>
                )}
                <NavArrowDown className={clsx(
                  "w-4 h-4 text-text-tertiary flex-shrink-0 transition-transform duration-200",
                  isOpen && "rotate-180"
                )} />
              </button>

              {/* Accordion body */}
              {isOpen && (
                <div className="border-t border-border/40">

                  {/* Provider rows */}
                  {cat.providers.map(prov => {
                    const isSelected = !!selectedMap[prov.id];
                    const isFocused = focusedProviderId === prov.id;
                    const entry = selectedMap[prov.id];
                    // Ausgewählt: der eigene Betrag; sonst die Vorauswahl (Tarif und Land)
                    const rowMonthly = entry
                      ? getEffectiveMonthly(entry, cat.providers)
                      : (() => {
                          const d = defaultSelection(prov);
                          return variantMonthlyCHF(prov, entryVariant(prov, d.variantId), d.country ?? "CH");
                        })();

                    return (
                      <div
                        key={prov.id}
                        onClick={() => handleProviderClick(prov, cat.id)}
                        className={clsx(
                          "flex items-center gap-3 px-4 py-3 cursor-pointer border-b border-border/30 last:border-b-0 transition-all duration-150",
                          isFocused ? "bg-accent/10" : isSelected ? "bg-accent/5 hover:bg-accent/8" : "hover:bg-white/[0.025]"
                        )}
                      >
                        {/* Checkbox */}
                        <div
                          onClick={(e) => handleCheckboxClick(e, prov, cat.id)}
                          className={clsx(
                            "w-5 h-5 rounded border flex items-center justify-center flex-shrink-0 transition-all cursor-pointer",
                            isSelected ? "bg-accent border-accent" : "border-white/20 hover:border-white/40"
                          )}
                        >
                          {isSelected && <Check className="w-3 h-3 text-white" />}
                        </div>

                        {/* Provider icon (favicon) */}
                        <ProviderBrandIcon providerId={prov.id} size={20} />

                        {/* Name + tagline */}
                        <div className="flex-1 min-w-0">
                          <div className="text-text-primary text-base font-medium leading-tight">{prov.name}</div>
                          <div className="text-text-tertiary text-xs truncate mt-1">{catalogText(prov.tagline)}</div>
                        </div>

                        {/* Price + peer */}
                        <div className="text-right flex-shrink-0">
                          <div className={clsx(
                            "font-mono text-sm",
                            isSelected ? "text-accent font-semibold" : "text-text-tertiary"
                          )}>
                            {fchf(rowMonthly)}
                            {rowMonthly > 0 && <span className="text-2xs font-normal opacity-70">/Mo</span>}
                          </div>
                          {prov.peerPopularity && (
                            <div className="flex items-center gap-1 justify-end mt-1 text-2xs text-text-tertiary">
                              <Activity className="w-2.5 h-2.5" />
                              {prov.peerPopularity}%
                            </div>
                          )}
                        </div>

                        {isFocused && <NavArrowRight className="w-3.5 h-3.5 text-accent flex-shrink-0" />}
                      </div>
                    );
                  })}

                  {/* Custom entries */}
                  {data.customExpenseEntries
                    .filter(e => e.categoryId === cat.id)
                    .map(custom => {
                      const isFocusedCustom =
                        customSidebarState?.mode === "edit" && customSidebarState.entryId === custom.id;
                      return (
                        <div
                          key={custom.id}
                          onClick={() => openCustomEdit(custom.id)}
                          className={clsx(
                            "flex items-center gap-3 px-4 py-3 border-b border-border/30 cursor-pointer transition-all duration-150",
                            isFocusedCustom ? "bg-accent/10" : "bg-warning/5 hover:bg-warning/10"
                          )}
                        >
                          <div className="w-5 h-5 rounded border bg-warning/20 border-warning/40 flex items-center justify-center flex-shrink-0">
                            <Check className="w-3 h-3 text-warning" />
                          </div>
                          <EditPencil className="w-4 h-4 text-text-tertiary flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="text-text-primary text-base font-medium">{custom.name}</div>
                            <div className="text-text-tertiary text-xs">{t("pages:step5.s03")}</div>
                          </div>
                          <span className="font-mono text-sm text-warning">{fchf(getEffectiveMonthlyCustom(custom))}/Mo</span>
                          {isFocusedCustom && <NavArrowRight className="w-3.5 h-3.5 text-accent flex-shrink-0" />}
                        </div>
                      );
                    })}

                  {/* Add / Search provider */}
                  {searchCategoryId === cat.id ? (
                    <div className="px-4 py-3 bg-bg-surface2 space-y-2 border-t border-border/40">
                      <div className="flex items-center gap-2">
                        <Search className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />
                        <input
                          type="text"
                          className="input flex-1 text-base py-1"
                          placeholder={t("pages:step5.s01")}
                          value={searchQuery}
                          onChange={e => setSearchQuery(e.target.value)}
                          autoFocus
                        />
                        <button
                          type="button"
                          onClick={() => { setSearchCategoryId(null); setSearchQuery(""); }}
                          className="text-text-tertiary hover:text-text-primary transition-colors flex-shrink-0"
                        >
                          <Xmark className="w-4 h-4" />
                        </button>
                      </div>

                      {/* Search results */}
                      {searchQuery.trim() && (() => {
                        const results = searchProviders(searchQuery);
                        return (
                          <div className="space-y-1">
                            {results.map(({ provider, category: resCat }) => (
                              <button
                                key={provider.id}
                                type="button"
                                onClick={() => handleSearchSelect(provider, resCat)}
                                className={clsx(
                                  "w-full flex items-center gap-2 px-2 py-2 rounded-md hover:bg-white/[0.04] transition-colors text-left",
                                  selectedMap[provider.id] && "opacity-60"
                                )}
                              >
                                <ProviderBrandIcon providerId={provider.id} size={16} />
                                <div className="flex-1 min-w-0">
                                  <span className="text-text-primary text-sm font-medium">{provider.name}</span>
                                  <span className="text-text-tertiary text-2xs ml-2">{catalogText(resCat.label)}</span>
                                </div>
                                <span className="text-text-tertiary font-mono text-2xs flex-shrink-0">
                                  {fchf((() => { const d = defaultSelection(provider); return variantMonthlyCHF(provider, entryVariant(provider, d.variantId), d.country ?? "CH"); })())}/Mo
                                </span>
                                {selectedMap[provider.id] && <Check className="w-3 h-3 text-accent flex-shrink-0" />}
                              </button>
                            ))}

                            {/* Always show "create custom" at bottom */}
                            <button
                              type="button"
                              onClick={() => openCustomNew(cat.id, searchQuery)}
                              className="w-full flex items-center gap-2 px-2 py-2 rounded-md hover:bg-accent/8 text-accent text-left transition-colors border border-dashed border-accent/30 mt-1"
                            >
                              <Plus className="w-3.5 h-3.5 flex-shrink-0" />
                              <span className="text-sm font-medium">
                                {results.length === 0
                                  ? `"${searchQuery}" als eigenen Anbieter anlegen`
                                  : "Eigenen Anbieter anlegen"}
                              </span>
                            </button>
                          </div>
                        );
                      })()}

                      {/* Empty state — no query */}
                      {!searchQuery.trim() && (
                        <button
                          type="button"
                          onClick={() => openCustomNew(cat.id)}
                          className="w-full flex items-center gap-2 px-2 py-2 rounded-md hover:bg-accent/8 text-accent text-left transition-colors border border-dashed border-accent/30"
                        >
                          <Plus className="w-3.5 h-3.5 flex-shrink-0" />
                          <span className="text-sm font-medium">{t("pages:step5.s02")}</span>
                        </button>
                      )}
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSearchCategoryId(cat.id);
                        setSearchQuery("");
                        setCustomSidebarState(null);
                        closeSidebarProvider();
                      }}
                      className="w-full flex items-center gap-2 px-4 py-2 text-text-tertiary hover:text-text-secondary hover:bg-white/[0.02] text-sm transition-colors border-t border-border/40"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      {t("pages:ui.anbieter_hinzufuegen")}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── RIGHT: Sticky Sidebar (desktop lg+) ──────────────── */}
      <div className={clsx(
        // Unter der Wizard-Kopfzeile kleben, über der Fusszeile enden: beide
        // Höhen misst der Wizard (--wiz-head / --wiz-nav), je 16 px Luft
        "hidden lg:flex lg:flex-col w-72 flex-shrink-0 sticky top-[calc(var(--wiz-head)+16px)] max-h-[calc(100vh-var(--wiz-head)-var(--wiz-nav)-32px)] overflow-hidden",
        !focusedProvider && !customSidebarState && "invisible pointer-events-none"
      )}>
        {focusedProvider && focusedCategory && !customSidebarState && (
          <ProviderSidebar
            provider={focusedProvider}
            category={focusedCategory}
            entry={focusedEntry}
            onClose={closeSidebarProvider}
            onSelect={() => handleProviderClick(focusedProvider, focusedCategory.id)}
            onDeselect={() => removeProvider(focusedProvider.id)}
            onUpdate={(patch) => updateEntry(focusedProvider.id, patch)}
          />
        )}
        {customSidebarState && (
          <CustomProviderSidebar
            key={customSidebarState.mode === "new" ? "new" : customSidebarState.entryId}
            categories={EXPENSE_CATEGORIES}
            initialCategoryId={customSidebarState.mode === "new" ? customSidebarState.categoryId : undefined}
            initialName={customSidebarState.mode === "new" ? customSidebarState.initialName : undefined}
            entry={
              customSidebarState.mode === "edit"
                ? (data.customExpenseEntries.find(e => e.id === customSidebarState.entryId) ?? null)
                : null
            }
            onClose={closeCustomSidebar}
            onSave={handleCustomSave}
            onDelete={(id) => { removeCustomEntry(id); closeCustomSidebar(); }}
          />
        )}
      </div>

      {/* ── Mobile Bottom-Sheet Overlay (< lg) — rendered in portal to escape transform context ── */}
      {mobileOverlayOpen && createPortal(
        <div className="lg:hidden">
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
            onClick={closeMobileOverlay}
          />

          {/* Bottom sheet */}
          <div className="fixed bottom-0 left-0 right-0 z-50 flex flex-col overlay-sheet animate-slide-up">
            {/* Drag handle */}
            <div className="flex justify-center pt-2 pb-1 bg-bg-surface rounded-t-lg border-t border-x border-border/50">
              <div className="w-10 h-1 rounded-full bg-white/20" />
            </div>

            <div className="flex-1 min-h-0 flex flex-col overflow-hidden border-x border-b border-border/50 rounded-b-lg">
              {focusedProvider && focusedCategory && !customSidebarState && (
                <ProviderSidebar
                  provider={focusedProvider}
                  category={focusedCategory}
                  entry={focusedEntry}
                  onClose={closeMobileOverlay}
                  onSelect={() => handleProviderClick(focusedProvider, focusedCategory.id)}
                  onDeselect={() => removeProvider(focusedProvider.id)}
                  onUpdate={(patch) => updateEntry(focusedProvider.id, patch)}
                />
              )}
              {customSidebarState && (
                <CustomProviderSidebar
                  key={customSidebarState.mode === "new" ? "new" : customSidebarState.entryId}
                  categories={EXPENSE_CATEGORIES}
                  initialCategoryId={customSidebarState.mode === "new" ? customSidebarState.categoryId : undefined}
                  initialName={customSidebarState.mode === "new" ? customSidebarState.initialName : undefined}
                  entry={
                    customSidebarState.mode === "edit"
                      ? (data.customExpenseEntries.find(e => e.id === customSidebarState.entryId) ?? null)
                      : null
                  }
                  onClose={closeMobileOverlay}
                  onSave={handleCustomSave}
                  onDelete={(id) => { removeCustomEntry(id); closeMobileOverlay(); }}
                />
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
