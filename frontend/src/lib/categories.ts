/**
 * Canonical super-category taxonomy for budget-pal.
 *
 * This is the single source of truth for:
 *   • Category colours  (used in Sankey, Budget bars, transaction badges)
 *   • Grouping logic    (transaction categories → supercategory)
 *   • Wizard label mapping (wizard notes → supercategory)
 *
 * The colours mirror the values in SankeyChart FLOW_COLORS so that
 * every chart always renders the same colour for the same concept.
 */

export interface SuperCategory {
  id: string;
  label: string;         // German display label
  emoji: string;
  color: string;         // hex – identical in Sankey + Budget + badges
  /** Lowercase transaction category names that belong here */
  txnCategories: string[];
  /** Lowercase wizard budget `notes` values that belong here */
  wizardLabels: string[];
}

export const SUPER_CATEGORIES: SuperCategory[] = [
  {
    id: "wohnen",
    label: "Wohnen",
    emoji: "🏠",
    color: "#f0b429",
    txnCategories: ["housing", "wohnen", "utilities", "nebenkosten"],
    wizardLabels: ["miete", "hypothek", "hypothek & amortisation", "nebenkosten", "parkplatz"],
  },
  {
    id: "essen",
    label: "Essen & Trinken",
    emoji: "🛒",
    color: "#84cc16",
    txnCategories: ["groceries", "food & drink", "lebensmittel", "restaurant & takeaway"],
    wizardLabels: ["lebensmittel", "freizeit & restaurant"],
  },
  {
    id: "mobilitaet",
    label: "Mobilität",
    emoji: "🚆",
    color: "#38bdf8",
    txnCategories: [
      "transport", "travel", "reisen",
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
    emoji: "🛡️",
    color: "#a78bfa",
    txnCategories: [
      "insurance", "health", "versicherungen", "krankenkasse",
      "weitere versicherungen", "gesundheit", "fitness",
    ],
    wizardLabels: [
      "krankenkasse", "zusatzversicherung",
      "hausrat & haftpflicht", "autoversicherung",
    ],
  },
  {
    id: "freizeit",
    label: "Freizeit & Unterhaltung",
    emoji: "🎬",
    color: "#fb923c",
    txnCategories: ["entertainment", "unterhaltung", "freizeit & unterhaltung"],
    wizardLabels: [],
  },
  {
    id: "abos",
    label: "Abonnements & Kommunikation",
    emoji: "📱",
    color: "#22d3ee",
    txnCategories: [
      "abonnements", "kommunikation", "streaming",
      "musik & medien", "internet (festnetz)", "mobilfunk",
      "cloud & backup", "software & apps", "nachrichten & medien",
      "treue & mitgliedschaften", "bildung & weiterbildung",
      "beruflich", "shopping & lieferdienste",
    ],
    wizardLabels: [
      // aggregate fallback (old wizard runs)
      "abonnements",
      // individual subscription services (new wizard runs)
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
    emoji: "👔",
    color: "#ec4899",
    txnCategories: ["shopping", "kleidung"],
    wizardLabels: ["kleidung"],
  },
  {
    id: "bildung",
    label: "Bildung",
    emoji: "📚",
    color: "#6366f1",
    txnCategories: ["education"],
    wizardLabels: [],
  },
  {
    id: "sparen",
    label: "Sparen",
    emoji: "💰",
    color: "#10b981",
    txnCategories: ["salary", "investment", "einzahlungen"],
    wizardLabels: [],
  },
  {
    id: "sonstiges",
    label: "Sonstiges",
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

/** Find supercategory for a transaction category name */
export function getSuperCategory(txnCategory: string): SuperCategory | undefined {
  const lower = txnCategory.toLowerCase();
  return SUPER_CATEGORIES.find((sc) => sc.txnCategories.includes(lower));
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
    // Skip income-side categories (salary etc.) from expense grouping
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
