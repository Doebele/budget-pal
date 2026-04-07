/**
 * Canonical super-category taxonomy for budget-pal.
 *
 * This is the single source of truth for:
 *   • Category colours  (used in Sankey, Budget bars, transaction badges)
 *   • Grouping logic    (transaction categories → supercategory)
 *   • Wizard label mapping (wizard notes → supercategory)
 *   • Monochrome icons  (used in all UI components instead of emojis)
 *
 * txnCategories  = canonical German names shown in the UI and stored in the DB
 * legacyAliases  = old/English names kept for backwards-compat matching only
 *                  (hidden from UI; migrated to German on server startup)
 */
import type { LucideIcon } from "lucide-react";
import {
  Home,
  ShoppingCart,
  Train,
  ShieldCheck,
  Clapperboard,
  Smartphone,
  ShoppingBag,
  GraduationCap,
  Landmark,
  PiggyBank,
  Layers,
} from "lucide-react";

export interface SuperCategory {
  id: string;
  label: string;         // German display label
  icon: LucideIcon;      // monochrome lucide icon
  emoji: string;         // kept for plain-text contexts (tooltips, <option>)
  color: string;         // hex – identical in Sankey + Budget + badges
  /** Canonical German transaction category names stored in the DB */
  txnCategories: string[];
  /** Old / English aliases kept for backwards-compat matching only */
  legacyAliases?: string[];
  /** Lowercase wizard budget `notes` values that belong here */
  wizardLabels: string[];
}

export const SUPER_CATEGORIES: SuperCategory[] = [
  {
    id: "wohnen",
    label: "Wohnen",
    icon: Home,
    emoji: "🏠",
    color: "#f0b429",
    txnCategories: ["Wohnen", "Nebenkosten"],
    legacyAliases: ["housing", "utilities"],
    wizardLabels: ["miete", "hypothek", "hypothek & amortisation", "nebenkosten", "parkplatz"],
  },
  {
    id: "essen",
    label: "Essen & Trinken",
    icon: ShoppingCart,
    emoji: "🛒",
    color: "#84cc16",
    txnCategories: ["Lebensmittel", "Restaurant & Takeaway"],
    legacyAliases: ["groceries", "food & drink"],
    wizardLabels: ["lebensmittel", "freizeit & restaurant"],
  },
  {
    id: "mobilitaet",
    label: "Mobilität",
    icon: Train,
    emoji: "🚆",
    color: "#38bdf8",
    txnCategories: ["Transport", "Reisen", "ÖV-Kosten"],
    legacyAliases: [
      "travel",
      "öv-abonnements", "ov-abonnements", "öv abonnements",
    ],
    wizardLabels: [
      "benzin / strom (auto)", "auto-amortisation",
      "sbb halbtax", "sbb ga 2. klasse", "transport",
    ],
  },
  {
    id: "versicherungen",
    label: "Versicherungen & Gesundheit",
    icon: ShieldCheck,
    emoji: "🛡️",
    color: "#a78bfa",
    txnCategories: [
      "Versicherungen", "Gesundheit", "Krankenkasse",
      "Weitere Versicherungen", "Fitness",
    ],
    legacyAliases: ["insurance", "health"],
    wizardLabels: [
      "krankenkasse", "zusatzversicherung",
      "hausrat & haftpflicht", "autoversicherung",
    ],
  },
  {
    id: "freizeit",
    label: "Freizeit & Unterhaltung",
    icon: Clapperboard,
    emoji: "🎬",
    color: "#fb923c",
    txnCategories: ["Freizeit & Unterhaltung"],
    legacyAliases: ["entertainment", "unterhaltung"],
    wizardLabels: ["freizeit & unterhaltung", "sport & fitness", "kultur & events"],
  },
  {
    id: "abos",
    label: "Abonnements & Kommunikation",
    icon: Smartphone,
    emoji: "📱",
    color: "#22d3ee",
    txnCategories: [
      "Abonnements", "Kommunikation", "Streaming",
      "Musik & Medien", "Internet (Festnetz)", "Mobilfunk",
      "Cloud & Backup", "Software & Apps", "Nachrichten & Medien",
      "Treue & Mitgliedschaften", "Bildung & Weiterbildung",
      "Beruflich", "Shopping & Lieferdienste",
    ],
    legacyAliases: [
      // lowercase variants in old data
      "abonnements", "kommunikation", "streaming",
      "musik & medien", "internet (festnetz)", "mobilfunk",
      "cloud & backup", "software & apps", "nachrichten & medien",
      "treue & mitgliedschaften", "bildung & weiterbildung",
      "beruflich", "shopping & lieferdienste",
    ],
    wizardLabels: [
      "abonnements",
      "serafe",
      "netflix", "spotify", "disney+", "nzz digital", "blick+",
      "srf play (optional)", "icloud 200gb", "google one", "microsoft 365",
      "migros cumulus extra", "adsl/fiber (swisscom)", "mobile abo (sunrise)",
      "fitnesscenter", "adobe creative cloud", "linkedin premium",
      "dropbox plus", "amazon prime", "youtube premium",
    ],
  },
  {
    id: "shopping",
    label: "Shopping & Kleidung",
    icon: ShoppingBag,
    emoji: "👔",
    color: "#ec4899",
    txnCategories: ["Shopping", "Kleidung"],
    wizardLabels: ["kleidung", "shopping & kleidung", "bekleidung & schuhe"],
  },
  {
    id: "bildung",
    label: "Bildung",
    icon: GraduationCap,
    emoji: "📚",
    color: "#6366f1",
    txnCategories: ["Bildung"],
    legacyAliases: ["education"],
    wizardLabels: ["weiterbildung & kurse", "bücher & medien", "bildung & weiterbildung"],
  },
  {
    id: "steuern",
    label: "Steuern & Abgaben",
    icon: Landmark,
    emoji: "🏛️",
    color: "#f43f5e",
    txnCategories: ["Steuern", "Abgaben", "Finanzen", "Gebühren", "Dienstleistungen"],
    legacyAliases: ["finance", "taxes", "services", "fees"],
    wizardLabels: [
      "direkte steuern",
      "gebühren",
      "kirchensteuern",
    ],
  },
  {
    id: "sparen",
    label: "Sparen",
    icon: PiggyBank,
    emoji: "💰",
    color: "#10b981",
    txnCategories: ["Gehalt", "Investitionen", "Einzahlungen", "Kontoübertrag", "Säule 3A"],
    legacyAliases: ["salary", "investment"],
    wizardLabels: ["säule 3a"],
  },
  {
    id: "sonstiges",
    label: "Sonstiges",
    icon: Layers,
    emoji: "💸",
    color: "#94a3b8",
    txnCategories: [],   // catch-all – everything not matched above
    wizardLabels: [],
  },
];

// ── Lookup helpers ─────────────────────────────────────────────

/** Find supercategory by its label (e.g. "Wohnen") */
export function getSuperCategoryByLabel(label: string): SuperCategory | undefined {
  const lower = label.toLowerCase();
  return SUPER_CATEGORIES.find((sc) => sc.label.toLowerCase() === lower);
}

/** Find supercategory for a transaction category name (checks canonical + legacy aliases) */
export function getSuperCategory(txnCategory: string): SuperCategory | undefined {
  const lower = txnCategory.toLowerCase();
  return SUPER_CATEGORIES.find(
    (sc) =>
      sc.txnCategories.some((t) => t.toLowerCase() === lower) ||
      (sc.legacyAliases ?? []).some((a) => a.toLowerCase() === lower),
  );
}

/** Find supercategory for a wizard budget label (notes field) */
export function getSuperCategoryByWizardLabel(label: string): SuperCategory | undefined {
  const lower = label.toLowerCase();
  return SUPER_CATEGORIES.find((sc) => sc.wizardLabels.includes(lower));
}

/**
 * Resolve the best supercategory for any name, trying multiple lookup
 * strategies. Returns the "Sonstiges" catch-all if nothing matches.
 */
export function resolveSuperCategory(name: string, isWizard = false): SuperCategory {
  const lower = name.toLowerCase();

  // 1. Exact label match ("Wohnen", "Mobilität", …)
  const byLabel = SUPER_CATEGORIES.find((sc) => sc.label.toLowerCase() === lower);
  if (byLabel) return byLabel;

  // 2. Supercategory ID match ("wohnen", "sparen", …)
  const byId = SUPER_CATEGORIES.find((sc) => sc.id === lower);
  if (byId) return byId;

  if (isWizard) {
    const byWizard = getSuperCategoryByWizardLabel(name);
    if (byWizard) return byWizard;
    const byTxn = getSuperCategory(name);
    if (byTxn) return byTxn;
  } else {
    const byTxn = getSuperCategory(name);
    if (byTxn) return byTxn;
    const byWizard = getSuperCategoryByWizardLabel(name);
    if (byWizard) return byWizard;
  }

  // Catch-all
  return SUPER_CATEGORIES[SUPER_CATEGORIES.length - 1];
}

/**
 * Returns the canonical hex colour for any category name (txn or wizard).
 * Falls back to slate (#94a3b8) for unknowns.
 */
export function getCategoryColor(name: string): string {
  return resolveSuperCategory(name).color;
}

// ── Aggregation helper ─────────────────────────────────────────

export interface SuperCategoryAggregate {
  superCategory: SuperCategory;
  total: number;
  subItems: Array<{ label: string; value: number }>;
}

/**
 * Groups a flat list of { category, total } entries into supercategories.
 * Preserves order by total descending within each group.
 */
export function groupBySuper(
  items: Array<{ category: string; total: number }>,
  isWizard = false,
): SuperCategoryAggregate[] {
  const map = new Map<string, SuperCategoryAggregate>();

  for (const item of items) {
    if (item.total <= 0) continue;
    const sc = resolveSuperCategory(item.category, isWizard);
    // Skip income-side / transfer categories from expense grouping
    if (sc.id === "sparen") continue;

    if (!map.has(sc.id)) {
      map.set(sc.id, { superCategory: sc, total: 0, subItems: [] });
    }
    const agg = map.get(sc.id)!;
    agg.total += item.total;
    agg.subItems.push({ label: item.category, value: item.total });
  }

  return [...map.values()].sort((a, b) => b.total - a.total);
}
