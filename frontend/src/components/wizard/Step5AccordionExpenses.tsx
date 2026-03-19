/**
 * Step5AccordionExpenses — Enhanced Everyday Expenses & Subscriptions
 *
 * Layout:
 *  LEFT  – Category accordions with provider checkboxes
 *  RIGHT – Sticky detail sidebar for the focused provider
 */

import { useState, useMemo } from "react";
import {
  ChevronDown, ChevronRight, Plus, X, ExternalLink,
  Check, Users, Trash2,
} from "lucide-react";
import { clsx } from "clsx";

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
  emoji: string;
  tagline: string;
  website?: string;
  variants: ProviderVariant[];
  peerPopularity?: number;
}

export interface ExpenseCategory {
  id: string;
  label: string;
  emoji: string;
  description: string;
  providers: ExpenseProvider[];
}

export interface SelectedExpenseEntry {
  providerId: string;
  categoryId: string;
  variantId: string;
  customPrice?: number;
  note?: string;
}

export interface CustomExpenseEntry {
  id: string;
  categoryId: string;
  name: string;
  price: number;
  note?: string;
}

// ─────────────────────────────────────────────────────────────────
// Provider / Category Data
// ─────────────────────────────────────────────────────────────────

export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  {
    id: "streaming",
    label: "Streaming & TV",
    emoji: "📺",
    description: "Video-Streaming und TV-Dienste",
    providers: [
      {
        id: "netflix", name: "Netflix", emoji: "🎬",
        tagline: "Serien, Filme und Dokus", website: "https://netflix.com",
        peerPopularity: 68,
        variants: [
          { id: "ads",      label: "Standard mit Werbung", price: 6.99 },
          { id: "standard", label: "Standard",             price: 17.99, popular: true, description: "HD, 2 Geräte" },
          { id: "premium",  label: "Premium",              price: 24.99, description: "4K, 4 Geräte" },
        ],
      },
      {
        id: "disney-plus", name: "Disney+", emoji: "🏰",
        tagline: "Disney, Marvel, Star Wars, Pixar", website: "https://disneyplus.com",
        peerPopularity: 34,
        variants: [
          { id: "ads",      label: "Standard (Werbung)", price: 7.99 },
          { id: "standard", label: "Standard",           price: 11.99, popular: true },
          { id: "premium",  label: "Premium 4K",         price: 17.99 },
        ],
      },
      {
        id: "amazon-prime", name: "Amazon Prime Video", emoji: "📦",
        tagline: "Prime Video + schnelle Lieferung", website: "https://primevideo.com",
        peerPopularity: 29,
        variants: [
          { id: "video",   label: "Nur Prime Video",      price: 6.99 },
          { id: "prime",   label: "Prime Mitgliedschaft", price: 9.99, popular: true, description: "Video + Shopping" },
        ],
      },
      {
        id: "apple-tv", name: "Apple TV+", emoji: "🍎",
        tagline: "Apple Originals", website: "https://tv.apple.com",
        peerPopularity: 18,
        variants: [
          { id: "single",      label: "Einzeln",             price: 9.99 },
          { id: "apple-one",   label: "Apple One Einzel",    price: 19.95, popular: true, description: "Music, TV+, Arcade, iCloud 50 GB" },
          { id: "apple-fam",   label: "Apple One Familie",   price: 30.95, description: "Bis zu 5 Personen" },
        ],
      },
      {
        id: "yt-premium", name: "YouTube Premium", emoji: "▶️",
        tagline: "YouTube ohne Werbung + YouTube Music", website: "https://youtube.com/premium",
        peerPopularity: 22,
        variants: [
          { id: "single", label: "Einzel",           price: 13.99, popular: true },
          { id: "family", label: "Familie (bis 5)",  price: 20.99 },
        ],
      },
      {
        id: "dazn", name: "DAZN", emoji: "⚽",
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
    emoji: "🎵",
    description: "Musik-Streaming Dienste",
    providers: [
      {
        id: "spotify", name: "Spotify", emoji: "🟢",
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
        id: "apple-music", name: "Apple Music", emoji: "🎶",
        tagline: "Hi-Res Audio, für Apple-Nutzer", website: "https://music.apple.com",
        peerPopularity: 24,
        variants: [
          { id: "individual", label: "Individual",       price: 11.99, popular: true },
          { id: "family",     label: "Familie (bis 6)", price: 17.99 },
          { id: "student",    label: "Student",          price: 5.99 },
        ],
      },
      {
        id: "tidal", name: "TIDAL", emoji: "🌊",
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
    emoji: "☁️",
    description: "Cloud-Speicher und Software-Abos",
    providers: [
      {
        id: "icloud", name: "iCloud+", emoji: "🍏",
        tagline: "Apple Cloud-Speicher", website: "https://apple.com/icloud",
        peerPopularity: 55,
        variants: [
          { id: "50gb",  label: "50 GB",  price: 0.99 },
          { id: "200gb", label: "200 GB", price: 2.99, popular: true },
          { id: "2tb",   label: "2 TB",   price: 9.99 },
        ],
      },
      {
        id: "google-one", name: "Google One", emoji: "🔵",
        tagline: "Google Cloud-Speicher", website: "https://one.google.com",
        peerPopularity: 28,
        variants: [
          { id: "100gb", label: "100 GB", price: 2.99 },
          { id: "200gb", label: "200 GB", price: 3.99, popular: true },
          { id: "2tb",   label: "2 TB",   price: 9.99 },
        ],
      },
      {
        id: "ms365", name: "Microsoft 365", emoji: "💻",
        tagline: "Word, Excel, PowerPoint, 1 TB OneDrive", website: "https://microsoft.com/365",
        peerPopularity: 42,
        variants: [
          { id: "personal", label: "Personal (1 Nutzer)",  price: 9.00, popular: true },
          { id: "family",   label: "Familie (bis 6)",      price: 12.00 },
        ],
      },
      {
        id: "adobe-cc", name: "Adobe Creative Cloud", emoji: "🎨",
        tagline: "Photoshop, Illustrator, Premiere, InDesign", website: "https://adobe.com",
        peerPopularity: 11,
        variants: [
          { id: "photography", label: "Photography (LR+PS)", price: 14.24 },
          { id: "single-app",  label: "Einzelne App",        price: 29.99 },
          { id: "all-apps",    label: "Alle Apps",            price: 59.99, popular: true },
        ],
      },
      {
        id: "1password", name: "1Password", emoji: "🔐",
        tagline: "Passwort-Manager", website: "https://1password.com",
        peerPopularity: 18,
        variants: [
          { id: "individual", label: "Individual",      price: 3.99, popular: true },
          { id: "family",     label: "Familie (bis 5)", price: 6.99 },
        ],
      },
      {
        id: "chatgpt", name: "ChatGPT Plus", emoji: "🤖",
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
    emoji: "📱",
    description: "Internet, Mobile und Festnetz",
    providers: [
      {
        id: "swisscom-internet", name: "Swisscom Internet", emoji: "🔷",
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
        id: "sunrise-internet", name: "Sunrise Internet", emoji: "🌅",
        tagline: "Breitband & TV von Sunrise", website: "https://sunrise.ch",
        peerPopularity: 22,
        variants: [
          { id: "m", label: "Internet M",          price: 39.90 },
          { id: "l", label: "Internet L",          price: 49.90, popular: true },
          { id: "connect", label: "Connect M (TV)", price: 69.90 },
        ],
      },
      {
        id: "salt-home", name: "Salt Home", emoji: "🧂",
        tagline: "Günstiges Glasfaser-Internet", website: "https://salt.ch",
        peerPopularity: 12,
        variants: [
          { id: "fiber",    label: "Home Fiber",        price: 34.95, popular: true, description: "1 Gbit/s" },
          { id: "fiber-tv", label: "Home Fiber + TV",   price: 49.95 },
        ],
      },
      {
        id: "swisscom-mobile", name: "Swisscom Mobile", emoji: "🔷",
        tagline: "Bestes Netz der Schweiz", website: "https://swisscom.ch",
        peerPopularity: 35,
        variants: [
          { id: "s", label: "inOne mobile S", price: 39.00 },
          { id: "m", label: "inOne mobile M", price: 55.00, popular: true },
          { id: "l", label: "inOne mobile L", price: 75.00 },
        ],
      },
      {
        id: "sunrise-mobile", name: "Sunrise Mobile", emoji: "🌅",
        tagline: "Günstig und schnell", website: "https://sunrise.ch",
        peerPopularity: 20,
        variants: [
          { id: "s",         label: "Classic S",   price: 29.90 },
          { id: "m",         label: "Classic M",   price: 39.90, popular: true },
          { id: "unlimited", label: "Unlimited",   price: 55.00 },
        ],
      },
      {
        id: "wingo", name: "Wingo", emoji: "🟣",
        tagline: "Swisscom-Netz zum Sparpreis", website: "https://wingo.ch",
        peerPopularity: 16,
        variants: [
          { id: "m",  label: "M (5 GB)",          price: 19.00 },
          { id: "l",  label: "L (15 GB)",         price: 24.00, popular: true },
          { id: "xl", label: "XL (Unlimitiert)",  price: 29.00 },
        ],
      },
      {
        id: "salt-mobile", name: "Salt Mobile", emoji: "🧂",
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
    emoji: "📰",
    description: "Zeitungen, Magazine und Nachrichtenangebote",
    providers: [
      {
        id: "nzz", name: "NZZ Digital", emoji: "📜",
        tagline: "Neue Zürcher Zeitung – Premium-Journalismus", website: "https://nzz.ch",
        peerPopularity: 24,
        variants: [
          { id: "standard", label: "NZZ Digital",            price: 31.90, popular: true },
          { id: "premium",  label: "NZZ Premium (+ Print)",  price: 49.90 },
        ],
      },
      {
        id: "tagi", name: "Tages-Anzeiger", emoji: "📑",
        tagline: "Tagi Digital Abo", website: "https://tagesanzeiger.ch",
        peerPopularity: 18,
        variants: [
          { id: "basis",   label: "Digital Basis",   price: 9.90 },
          { id: "premium", label: "Digital Premium", price: 24.90, popular: true },
        ],
      },
      {
        id: "blick-plus", name: "Blick+", emoji: "⚡",
        tagline: "Blick Plus Digital", website: "https://blick.ch",
        peerPopularity: 11,
        variants: [
          { id: "plus", label: "Blick+", price: 12.90, popular: true },
        ],
      },
      {
        id: "guardian", name: "The Guardian", emoji: "🦅",
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
    emoji: "🏋️",
    description: "Fitnesscenter, Sport-Apps und Clubs",
    providers: [
      {
        id: "fitnesscenter", name: "Fitnesscenter", emoji: "💪",
        tagline: "Monatliches Fitnesscenter-Abo",
        peerPopularity: 42,
        variants: [
          { id: "basis",    label: "Basismitgliedschaft",     price: 50 },
          { id: "standard", label: "Standard",                price: 80, popular: true },
          { id: "premium",  label: "Premium (inkl. Kurse)",   price: 120 },
        ],
      },
      {
        id: "apple-fitness", name: "Apple Fitness+", emoji: "🍎",
        tagline: "Online-Workouts von Apple", website: "https://apple.com/apple-fitness-plus",
        peerPopularity: 12,
        variants: [
          { id: "individual", label: "Individual", price: 9.99, popular: true },
          { id: "family",     label: "Familie",    price: 14.99 },
        ],
      },
      {
        id: "strava", name: "Strava Premium", emoji: "🚴",
        tagline: "GPS-Tracking für Läufer & Radfahrer", website: "https://strava.com",
        peerPopularity: 19,
        variants: [
          { id: "monthly", label: "Monatlich",             price: 10.99 },
          { id: "annual",  label: "Jährlich (pro Monat)", price: 7.50, popular: true },
        ],
      },
      {
        id: "schwimmbad", name: "Schwimmbad-Abo", emoji: "🏊",
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
    emoji: "🚂",
    description: "SBB und weitere ÖV-Abonnements",
    providers: [
      {
        id: "sbb-halbtax", name: "SBB Halbtax", emoji: "🎫",
        tagline: "Alle ÖV-Tickets zum halben Preis", website: "https://sbb.ch",
        peerPopularity: 62,
        variants: [
          { id: "standard",      label: "Halbtax (Jahresabo)",       price: 19.40, popular: true, description: "CHF 233/Jahr" },
          { id: "railaway",      label: "Halbtax + Railaway",        price: 21.65 },
        ],
      },
      {
        id: "sbb-ga", name: "SBB Generalabonnement", emoji: "🚄",
        tagline: "Unlimitiert Reisen in der ganzen Schweiz", website: "https://sbb.ch",
        peerPopularity: 18,
        variants: [
          { id: "2kl", label: "2. Klasse", price: 345.00, popular: true, description: "CHF 4'140/Jahr" },
          { id: "1kl", label: "1. Klasse", price: 565.00, description: "CHF 6'780/Jahr" },
        ],
      },
      {
        id: "mobility", name: "Mobility Carsharing", emoji: "🚗",
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
    emoji: "💼",
    description: "Business-Tools, Weiterbildung und KI-Dienste",
    providers: [
      {
        id: "linkedin", name: "LinkedIn Premium", emoji: "🤝",
        tagline: "Karriere-Netzwerk mit erweiterten Funktionen", website: "https://linkedin.com",
        peerPopularity: 19,
        variants: [
          { id: "career",   label: "Premium Career",   price: 44.99, popular: true },
          { id: "business", label: "Premium Business", price: 69.99 },
          { id: "sales",    label: "Sales Navigator",  price: 129.99 },
        ],
      },
      {
        id: "notion", name: "Notion", emoji: "📓",
        tagline: "All-in-one Workspace", website: "https://notion.so",
        peerPopularity: 14,
        variants: [
          { id: "plus",     label: "Plus",     price: 9.00, popular: true },
          { id: "business", label: "Business", price: 17.00 },
        ],
      },
      {
        id: "claude-pro", name: "Claude Pro", emoji: "✨",
        tagline: "Anthropic Claude mit erweitertem Kontext", website: "https://claude.ai",
        peerPopularity: 12,
        variants: [
          { id: "pro", label: "Claude Pro", price: 22.00, popular: true },
        ],
      },
      {
        id: "slack", name: "Slack", emoji: "💬",
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
    emoji: "🏠",
    description: "Haushaltshilfe, Gartenpflege und Heimdienste",
    providers: [
      {
        id: "reinigung", name: "Reinigungshilfe", emoji: "🧹",
        tagline: "Regelmässige Putz-/Reinigungshilfe",
        peerPopularity: 28,
        variants: [
          { id: "2h-wo",   label: "2h/Woche",             price: 200, description: "ca. CHF 25/h × 8h/Monat" },
          { id: "4h-wo",   label: "4h/Woche",             price: 400, popular: true, description: "ca. CHF 25/h × 16h/Monat" },
          { id: "tage",    label: "1 Tagespauschale/Mo",  price: 300 },
        ],
      },
      {
        id: "gartenpflege", name: "Gartenpflege", emoji: "🌿",
        tagline: "Monatliche Gartenpflege",
        peerPopularity: 15,
        variants: [
          { id: "klein",  label: "Kleingarten (2h/Mo)",  price: 100 },
          { id: "mittel", label: "Mittelgross",           price: 200, popular: true },
          { id: "gross",  label: "Grossgarten",           price: 350 },
        ],
      },
      {
        id: "security", name: "Sicherheitssystem", emoji: "🔒",
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
    emoji: "🛒",
    description: "Kundenprogramme und Shopping-Abos",
    providers: [
      {
        id: "cumulus-extra", name: "Migros Cumulus Extra", emoji: "🛍️",
        tagline: "Erweiterte Cumulus-Vorteile + Rabattpässe", website: "https://migros.ch",
        peerPopularity: 22,
        variants: [
          { id: "extra", label: "Cumulus Extra", price: 7.95, popular: true },
        ],
      },
      {
        id: "galaxus-plus", name: "Galaxus Plus", emoji: "🔧",
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
// Main Component
// ─────────────────────────────────────────────────────────────────

export default function Step5AccordionExpenses({ data, update }: Props) {
  const [openCategories, setOpenCategories] = useState<Set<string>>(
    new Set(["streaming", "kommunikation"])
  );
  const [focusedProviderId, setFocusedProviderId] = useState<string | null>(null);
  const [focusedCategoryId, setFocusedCategoryId] = useState<string | null>(null);
  const [addingCustomIn, setAddingCustomIn] = useState<string | null>(null);
  const [customName, setCustomName] = useState("");
  const [customPrice, setCustomPrice] = useState("");

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
      const prov = cat?.providers.find(p => p.id === e.providerId);
      const variant = prov?.variants.find(v => v.id === e.variantId);
      sum += e.customPrice ?? variant?.price ?? 0;
    }
    for (const c of data.customExpenseEntries) sum += c.price;
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
  }

  function closeSidebar() {
    setFocusedProviderId(null);
    setFocusedCategoryId(null);
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
      if (focusedProviderId === provider.id) closeSidebar();
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
    if (focusedProviderId === providerId) closeSidebar();
  }

  function updateEntry(providerId: string, patch: Partial<SelectedExpenseEntry>) {
    update({
      expenseEntries: data.expenseEntries.map(e =>
        e.providerId === providerId ? { ...e, ...patch } : e
      ),
    });
  }

  function addCustomEntry(categoryId: string) {
    const price = parseFloat(customPrice);
    if (!customName.trim() || isNaN(price) || price < 0) return;
    update({
      customExpenseEntries: [
        ...data.customExpenseEntries,
        { id: `custom-${Date.now()}`, categoryId, name: customName.trim(), price },
      ],
    });
    setCustomName("");
    setCustomPrice("");
    setAddingCustomIn(null);
  }

  function removeCustomEntry(id: string) {
    update({ customExpenseEntries: data.customExpenseEntries.filter(e => e.id !== id) });
  }

  const totalCount = data.expenseEntries.length + data.customExpenseEntries.length;

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
        <div className="flex items-center justify-between rounded-xl bg-bg-surface2 border border-border/50 px-4 py-2.5">
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
            <div key={cat.id} className="bg-bg-surface border border-border/50 rounded-xl overflow-hidden">

              {/* Accordion toggle */}
              <button
                type="button"
                onClick={() => toggleCategory(cat.id)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/[0.02] transition-colors text-left"
              >
                <span className="text-xl flex-shrink-0">{cat.emoji}</span>
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

                        {/* Emoji */}
                        <span className="text-base flex-shrink-0">{prov.emoji}</span>

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
                            {entry?.customPrice !== undefined
                              ? fchf(entry.customPrice)
                              : fchf(activeVariant?.price ?? 0)}
                            {(activeVariant?.price ?? 0) > 0 && <span className="text-[10px] font-normal opacity-70">/Mo</span>}
                          </div>
                          {prov.peerPopularity && (
                            <div className="flex items-center gap-1 justify-end mt-0.5 text-[10px] text-text-tertiary">
                              <Users className="w-2.5 h-2.5" />
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
                    .map(custom => (
                      <div key={custom.id} className="flex items-center gap-3 px-4 py-3 border-b border-border/30 bg-warning/5">
                        <div className="w-5 h-5 rounded border bg-warning/20 border-warning/40 flex items-center justify-center flex-shrink-0">
                          <Check className="w-3 h-3 text-warning" />
                        </div>
                        <span className="text-base flex-shrink-0">✏️</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-text-primary text-sm font-medium">{custom.name}</div>
                          <div className="text-text-tertiary text-[11px]">Eigener Anbieter</div>
                        </div>
                        <span className="font-mono text-xs text-warning">{fchf(custom.price)}/Mo</span>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); removeCustomEntry(custom.id); }}
                          className="text-text-tertiary hover:text-loss transition-colors p-0.5"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}

                  {/* Add custom provider */}
                  {addingCustomIn === cat.id ? (
                    <div className="px-4 py-3 bg-bg-surface2 space-y-2">
                      <div className="flex gap-2">
                        <input
                          type="text"
                          className="input flex-1 text-sm"
                          placeholder="Anbieter-Name"
                          value={customName}
                          onChange={e => setCustomName(e.target.value)}
                          onKeyDown={e => e.key === "Enter" && addCustomEntry(cat.id)}
                          autoFocus
                        />
                        <div className="relative w-28">
                          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary text-xs pointer-events-none">CHF</span>
                          <input
                            type="number"
                            className="input pl-9 w-full text-sm"
                            placeholder="0"
                            value={customPrice}
                            onChange={e => setCustomPrice(e.target.value)}
                            onKeyDown={e => e.key === "Enter" && addCustomEntry(cat.id)}
                          />
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="btn-primary flex-1 text-xs py-1.5"
                          onClick={() => addCustomEntry(cat.id)}
                        >
                          Hinzufügen
                        </button>
                        <button
                          type="button"
                          className="btn-secondary text-xs py-1.5"
                          onClick={() => { setAddingCustomIn(null); setCustomName(""); setCustomPrice(""); }}
                        >
                          Abbrechen
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setAddingCustomIn(cat.id); }}
                      className="w-full flex items-center gap-2 px-4 py-2.5 text-text-tertiary hover:text-text-secondary hover:bg-white/[0.02] text-xs transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Eigenen Anbieter hinzufügen
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── RIGHT: Sticky Sidebar ────────────────────────────── */}
      <div className={clsx(
        "hidden lg:block w-72 flex-shrink-0 transition-all duration-200",
        focusedProvider ? "opacity-100" : "opacity-0 pointer-events-none"
      )}>
        {focusedProvider && focusedCategory && (
          <div className="sticky top-4 bg-bg-surface border border-border/50 rounded-xl overflow-hidden shadow-xl">

            {/* Sidebar header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/50 bg-bg-surface2">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="text-xl flex-shrink-0">{focusedProvider.emoji}</span>
                <div className="min-w-0">
                  <div className="text-text-primary font-semibold text-sm truncate">{focusedProvider.name}</div>
                  <div className="text-text-tertiary text-[11px] truncate">{focusedCategory.label}</div>
                </div>
              </div>
              <button
                type="button"
                onClick={closeSidebar}
                className="text-text-tertiary hover:text-text-primary transition-colors flex-shrink-0 ml-2"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Sidebar body */}
            <div className="p-4 space-y-4 max-h-[75vh] overflow-y-auto scrollbar-hide">

              {/* Tagline */}
              <p className="text-text-secondary text-xs leading-relaxed">{focusedProvider.tagline}</p>

              {/* Peer popularity */}
              {focusedProvider.peerPopularity && focusedProvider.peerPopularity > 0 && (
                <div className="flex items-start gap-2 bg-accent/8 border border-accent/15 rounded-lg px-3 py-2.5">
                  <Users className="w-3.5 h-3.5 text-accent flex-shrink-0 mt-0.5" />
                  <span className="text-text-secondary text-xs leading-relaxed">
                    <strong className="text-accent">{focusedProvider.peerPopularity}%</strong> deiner Peer-Gruppe nutzen diesen Dienst
                  </span>
                </div>
              )}

              {/* Variant picker */}
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary block mb-2">
                  Tarif / Plan
                </label>
                <div className="space-y-1.5">
                  {focusedProvider.variants.map(variant => {
                    const isActive = focusedEntry?.variantId === variant.id;
                    return (
                      <button
                        key={variant.id}
                        type="button"
                        disabled={!focusedEntry}
                        onClick={() => focusedEntry && updateEntry(focusedProvider.id, { variantId: variant.id, customPrice: undefined })}
                        className={clsx(
                          "w-full flex items-start justify-between rounded-lg px-3 py-2.5 text-left text-xs transition-all border",
                          isActive
                            ? "border-accent/60 bg-accent/12 text-text-primary"
                            : "border-border/50 hover:border-border text-text-secondary hover:bg-white/[0.03]",
                          !focusedEntry && "opacity-50 cursor-not-allowed"
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
                              <div className="text-text-tertiary text-[10px] mt-0.5 leading-relaxed">{variant.description}</div>
                            )}
                          </div>
                        </div>
                        <span className={clsx(
                          "font-mono flex-shrink-0 ml-2 mt-0.5",
                          isActive ? "text-accent font-semibold" : "text-text-tertiary"
                        )}>
                          {fchf(variant.price)}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {!focusedEntry && (
                  <p className="text-text-tertiary text-[10px] mt-2 text-center">
                    Wähle diesen Anbieter zuerst aus (Checkbox links)
                  </p>
                )}
              </div>

              {/* Custom price override */}
              {focusedEntry && (
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary block mb-1.5">
                    Eigener Preis <span className="normal-case font-normal">(optional)</span>
                  </label>
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary text-xs pointer-events-none">CHF</span>
                      <input
                        type="number"
                        className="input pl-10 text-sm w-full"
                        placeholder={String(focusedProvider.variants.find(v => v.id === focusedEntry.variantId)?.price ?? "")}
                        value={focusedEntry.customPrice ?? ""}
                        onChange={e => updateEntry(focusedProvider.id, {
                          customPrice: e.target.value ? parseFloat(e.target.value) : undefined,
                        })}
                        min={0}
                      />
                    </div>
                    <span className="text-text-tertiary text-xs">/Mo</span>
                    {focusedEntry.customPrice !== undefined && (
                      <button
                        type="button"
                        onClick={() => updateEntry(focusedProvider.id, { customPrice: undefined })}
                        className="text-text-tertiary hover:text-loss transition-colors"
                        title="Zurücksetzen"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <p className="text-text-tertiary text-[10px] mt-1 leading-relaxed">
                    Überschreibe den Planpreis mit deinem tatsächlichen Betrag.
                  </p>
                </div>
              )}

              {/* Note */}
              {focusedEntry && (
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary block mb-1.5">
                    Notiz
                  </label>
                  <input
                    type="text"
                    className="input text-sm w-full"
                    placeholder="z.B. Family-Plan, Jahresabo, mit Partner geteilt…"
                    value={focusedEntry.note ?? ""}
                    onChange={e => updateEntry(focusedProvider.id, { note: e.target.value || undefined })}
                  />
                </div>
              )}

              {/* Website */}
              {focusedProvider.website && (
                <a
                  href={focusedProvider.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-accent hover:text-accent-light text-xs transition-colors"
                >
                  <ExternalLink className="w-3 h-3" />
                  Webseite besuchen
                </a>
              )}

              {/* Action buttons */}
              <div className="pt-3 border-t border-border/50">
                {focusedEntry ? (
                  <button
                    type="button"
                    onClick={() => removeProvider(focusedProvider.id)}
                    className="w-full flex items-center justify-center gap-1.5 rounded-lg border border-loss/30 bg-loss/8 text-loss hover:bg-loss/15 px-3 py-2 text-xs font-medium transition-all"
                  >
                    <Trash2 className="w-3 h-3" />
                    Entfernen
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleProviderClick(focusedProvider, focusedCategory.id)}
                    className="w-full btn-primary text-xs py-2"
                  >
                    <Check className="w-3 h-3 mr-1 inline" />
                    Hinzufügen
                  </button>
                )}
              </div>

              {/* Currently selected total for this provider */}
              {focusedEntry && (() => {
                const variant = focusedProvider.variants.find(v => v.id === focusedEntry.variantId);
                const effectivePrice = focusedEntry.customPrice ?? variant?.price ?? 0;
                return effectivePrice > 0 ? (
                  <div className="bg-bg-surface2 rounded-lg px-3 py-2 flex items-center justify-between">
                    <span className="text-text-tertiary text-[11px]">Dieser Anbieter</span>
                    <span className="font-mono text-sm font-semibold text-text-primary">
                      {fchf(effectivePrice)}<span className="text-text-tertiary text-xs font-normal">/Mo</span>
                    </span>
                  </div>
                ) : null;
              })()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
