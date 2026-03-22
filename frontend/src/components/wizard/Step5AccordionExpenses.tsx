/**
 * Step5AccordionExpenses — Enhanced Everyday Expenses & Subscriptions
 *
 * Layout:
 *  LEFT  – Category accordions with provider checkboxes + search-first add flow
 *  RIGHT – Sticky detail sidebar for focused provider OR custom provider sidebar
 */

import { useState, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown, ChevronRight, Plus, X,
  Check, Tv, Music, Cloud, Smartphone, Newspaper,
  Activity, Train, Briefcase, Home, ShoppingCart,
  Search, PenLine,
} from "lucide-react";
import { clsx } from "clsx";
import { toMonthlyCHF } from "@/services/faviconService";
import type { Frequency, SupportedCurrency } from "@/services/faviconService";
import ProviderBrandIcon from "./ProviderBrandIcon";
import ProviderSidebar from "./ProviderSidebar";
import CustomProviderSidebar from "./CustomProviderSidebar";

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export interface ProviderVariant {
  id: string;
  label: string;
  price: number;
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
          { id: "ads",      label: "Standard mit Werbung", price: 6.99 },
          { id: "standard", label: "Standard",             price: 17.99, popular: true, description: "HD, 2 Geräte" },
          { id: "premium",  label: "Premium",              price: 24.99, description: "4K, 4 Geräte" },
        ],
      },
      {
        id: "disney-plus", name: "Disney+",
        tagline: "Disney, Marvel, Star Wars, Pixar", website: "https://disneyplus.com",
        peerPopularity: 34,
        variants: [
          { id: "ads",      label: "Standard (Werbung)", price: 7.99 },
          { id: "standard", label: "Standard",           price: 11.99, popular: true },
          { id: "premium",  label: "Premium 4K",         price: 17.99 },
        ],
      },
      {
        id: "amazon-prime", name: "Amazon Prime Video",
        tagline: "Prime Video + schnelle Lieferung", website: "https://primevideo.com",
        peerPopularity: 29,
        variants: [
          { id: "video",   label: "Nur Prime Video",      price: 6.99 },
          { id: "prime",   label: "Prime Mitgliedschaft", price: 9.99, popular: true, description: "Video + Shopping" },
        ],
      },
      {
        id: "apple-tv", name: "Apple TV+",
        tagline: "Apple Originals", website: "https://tv.apple.com",
        peerPopularity: 18,
        variants: [
          { id: "single",      label: "Einzeln",             price: 9.99 },
          { id: "apple-one",   label: "Apple One Einzel",    price: 19.95, popular: true, description: "Music, TV+, Arcade, iCloud 50 GB" },
          { id: "apple-fam",   label: "Apple One Familie",   price: 30.95, description: "Bis zu 5 Personen" },
        ],
      },
      {
        id: "yt-premium", name: "YouTube Premium",
        tagline: "YouTube ohne Werbung + YouTube Music", website: "https://youtube.com/premium",
        peerPopularity: 22,
        variants: [
          { id: "single", label: "Einzel",           price: 13.99, popular: true },
          { id: "family", label: "Familie (bis 5)",  price: 20.99 },
        ],
      },
      {
        id: "dazn", name: "DAZN",
        tagline: "Sport-Streaming: Fussball, Champions League", website: "https://dazn.com",
        peerPopularity: 12,
        variants: [
          { id: "monthly", label: "Monatlich",             price: 29.99 },
          { id: "annual",  label: "Jährlich (pro Monat)", price: 19.99, popular: true, description: "CHF 239.88/Jahr" },
        ],
      },
    ],
  },
  {
    id: "musik",
    label: "Musik",
    Icon: Music,
    description: "Musik-Streaming Dienste",
    providers: [
      {
        id: "spotify", name: "Spotify",
        tagline: "Meistgenutzter Musik-Streamingdienst", website: "https://spotify.com",
        peerPopularity: 71,
        variants: [
          { id: "individual", label: "Individual",       price: 12.95, popular: true },
          { id: "duo",        label: "Duo (2 Pers.)",   price: 16.95 },
          { id: "family",     label: "Familie (bis 6)", price: 21.95 },
          { id: "student",    label: "Student",          price: 6.50 },
        ],
      },
      {
        id: "apple-music", name: "Apple Music",
        tagline: "Hi-Res Audio, für Apple-Nutzer", website: "https://music.apple.com",
        peerPopularity: 24,
        variants: [
          { id: "individual", label: "Individual",       price: 11.99, popular: true },
          { id: "family",     label: "Familie (bis 6)", price: 17.99 },
          { id: "student",    label: "Student",          price: 5.99 },
        ],
      },
      {
        id: "tidal", name: "TIDAL",
        tagline: "HiFi Lossless Audio", website: "https://tidal.com",
        peerPopularity: 5,
        variants: [
          { id: "hifi",      label: "HiFi",            price: 9.99 },
          { id: "hifi-plus", label: "HiFi Plus",       price: 19.99, popular: true, description: "Dolby Atmos, 360° Audio" },
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
        id: "chatgpt", name: "ChatGPT Plus",
        tagline: "GPT-4o, DALL-E, Plugins", website: "https://chat.openai.com",
        peerPopularity: 24,
        variants: [
          { id: "plus", label: "ChatGPT Plus", price: 22.00, popular: true },
        ],
      },
    ],
  },
  {
    id: "kommunikation",
    label: "Kommunikation",
    Icon: Smartphone,
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
    Icon: Newspaper,
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
    Icon: Briefcase,
    description: "Business-Tools, Weiterbildung und KI-Dienste",
    providers: [
      {
        id: "linkedin", name: "LinkedIn Premium",
        tagline: "Karriere-Netzwerk mit erweiterten Funktionen", website: "https://linkedin.com",
        peerPopularity: 19,
        variants: [
          { id: "career",   label: "Premium Career",   price: 44.99, popular: true },
          { id: "business", label: "Premium Business", price: 69.99 },
          { id: "sales",    label: "Sales Navigator",  price: 129.99 },
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
        id: "claude-pro", name: "Claude Pro",
        tagline: "Anthropic Claude mit erweitertem Kontext", website: "https://claude.ai",
        peerPopularity: 12,
        variants: [
          { id: "pro", label: "Claude Pro", price: 22.00, popular: true },
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
    id: "shopping-loyalty",
    label: "Shopping & Loyalität",
    Icon: ShoppingCart,
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

function getEffectiveMonthly(entry: SelectedExpenseEntry, providers: ExpenseProvider[]): number {
  if (entry.viewMode === "individual" && entry.individualAmount != null) {
    return toMonthlyCHF(entry.individualAmount, entry.frequency ?? "monthly", entry.currency ?? "CHF");
  }
  if (entry.customPrice != null) return entry.customPrice;
  const variant = providers.flatMap(p => p.variants).find(v => v.id === entry.variantId);
  return variant?.price ?? 0;
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
      const defaultVariant = provider.variants.find(v => v.popular) ?? provider.variants[0];
      update({ expenseEntries: [...data.expenseEntries, { providerId: provider.id, categoryId: category.id, variantId: defaultVariant.id }] });
    }
    openSidebar(provider, category.id);
    setSearchCategoryId(null);
    setSearchQuery("");
  }

  function handleProviderClick(provider: ExpenseProvider, categoryId: string) {
    const isSelected = !!selectedMap[provider.id];
    if (!isSelected) {
      // Select with popular variant as default
      const defaultVariant = provider.variants.find(v => v.popular) ?? provider.variants[0];
      update({
        expenseEntries: [
          ...data.expenseEntries,
          { providerId: provider.id, categoryId, variantId: defaultVariant.id },
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
      const defaultVariant = provider.variants.find(v => v.popular) ?? provider.variants[0];
      update({
        expenseEntries: [
          ...data.expenseEntries,
          { providerId: provider.id, categoryId, variantId: defaultVariant.id },
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

  // Lock body scroll when mobile overlay is open
  useEffect(() => {
    if (mobileOverlayOpen) {
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
          <h2 className="text-text-primary font-semibold text-lg">Alltag & Abonnements</h2>
          <p className="text-text-secondary text-sm mt-1">
            Wähle deine Anbieter aus — klicke auf eine Zeile um Details zu konfigurieren.
          </p>
        </div>

        {/* Summary bar */}
        <div className="flex items-center justify-between rounded-lg bg-bg-surface2 border border-border/50 px-4 py-2.5">
          <div className="flex items-center gap-2 text-text-secondary text-sm">
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
                  <div className="text-text-primary text-sm font-medium">{cat.label}</div>
                  <div className="text-text-tertiary text-xs">{cat.description}</div>
                </div>
                {selCount > 0 && (
                  <span className="bg-accent/20 text-accent text-[11px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0">
                    {selCount}
                  </span>
                )}
                <ChevronDown className={clsx(
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
                    const activeVariant = entry
                      ? prov.variants.find(v => v.id === entry.variantId)
                      : (prov.variants.find(v => v.popular) ?? prov.variants[0]);

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
                          <div className="text-text-primary text-sm font-medium leading-tight">{prov.name}</div>
                          <div className="text-text-tertiary text-[11px] truncate mt-0.5">{prov.tagline}</div>
                        </div>

                        {/* Price + peer */}
                        <div className="text-right flex-shrink-0">
                          <div className={clsx(
                            "font-mono text-xs",
                            isSelected ? "text-accent font-semibold" : "text-text-tertiary"
                          )}>
                            {entry
                              ? fchf(getEffectiveMonthly(entry, cat.providers))
                              : fchf(activeVariant?.price ?? 0)}
                            {(activeVariant?.price ?? 0) > 0 && <span className="text-[10px] font-normal opacity-70">/Mo</span>}
                          </div>
                          {prov.peerPopularity && (
                            <div className="flex items-center gap-1 justify-end mt-0.5 text-[10px] text-text-tertiary">
                              <Activity className="w-2.5 h-2.5" />
                              {prov.peerPopularity}%
                            </div>
                          )}
                        </div>

                        {isFocused && <ChevronRight className="w-3.5 h-3.5 text-accent flex-shrink-0" />}
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
                          <PenLine className="w-4 h-4 text-text-tertiary flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="text-text-primary text-sm font-medium">{custom.name}</div>
                            <div className="text-text-tertiary text-[11px]">Eigener Anbieter</div>
                          </div>
                          <span className="font-mono text-xs text-warning">{fchf(getEffectiveMonthlyCustom(custom))}/Mo</span>
                          {isFocusedCustom && <ChevronRight className="w-3.5 h-3.5 text-accent flex-shrink-0" />}
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
                          className="input flex-1 text-sm py-1.5"
                          placeholder="Anbieter suchen…"
                          value={searchQuery}
                          onChange={e => setSearchQuery(e.target.value)}
                          autoFocus
                        />
                        <button
                          type="button"
                          onClick={() => { setSearchCategoryId(null); setSearchQuery(""); }}
                          className="text-text-tertiary hover:text-text-primary transition-colors flex-shrink-0"
                        >
                          <X className="w-4 h-4" />
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
                                  "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md hover:bg-white/[0.04] transition-colors text-left",
                                  selectedMap[provider.id] && "opacity-60"
                                )}
                              >
                                <ProviderBrandIcon providerId={provider.id} size={16} />
                                <div className="flex-1 min-w-0">
                                  <span className="text-text-primary text-xs font-medium">{provider.name}</span>
                                  <span className="text-text-tertiary text-[10px] ml-2">{resCat.label}</span>
                                </div>
                                <span className="text-text-tertiary font-mono text-[10px] flex-shrink-0">
                                  CHF {provider.variants.find(v => v.popular)?.price ?? provider.variants[0]?.price}/Mo
                                </span>
                                {selectedMap[provider.id] && <Check className="w-3 h-3 text-accent flex-shrink-0" />}
                              </button>
                            ))}

                            {/* Always show "create custom" at bottom */}
                            <button
                              type="button"
                              onClick={() => openCustomNew(cat.id, searchQuery)}
                              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md hover:bg-accent/8 text-accent text-left transition-colors border border-dashed border-accent/30 mt-1"
                            >
                              <Plus className="w-3.5 h-3.5 flex-shrink-0" />
                              <span className="text-xs font-medium">
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
                          className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md hover:bg-accent/8 text-accent text-left transition-colors border border-dashed border-accent/30"
                        >
                          <Plus className="w-3.5 h-3.5 flex-shrink-0" />
                          <span className="text-xs font-medium">Eigenen Anbieter anlegen</span>
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
                      className="w-full flex items-center gap-2 px-4 py-2.5 text-text-tertiary hover:text-text-secondary hover:bg-white/[0.02] text-xs transition-colors border-t border-border/40"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Anbieter hinzufügen
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
        "hidden lg:block w-72 flex-shrink-0 sticky top-4 max-h-[calc(100vh-2rem)]",
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
          <div className="fixed bottom-0 left-0 right-0 z-50 flex flex-col max-h-[88vh] animate-slide-up">
            {/* Drag handle */}
            <div className="flex justify-center pt-2 pb-1 bg-bg-surface rounded-t-lg border-t border-x border-border/50">
              <div className="w-10 h-1 rounded-full bg-white/20" />
            </div>

            <div className="flex-1 min-h-0 overflow-hidden border-x border-b border-border/50 rounded-b-lg">
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
