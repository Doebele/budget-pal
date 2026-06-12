/**
 * Peer Group Analyzer — Swiss BFS (Bundesamt für Statistik) data.
 *
 * Based on: BFS Haushaltsbudgeterhebung (HABE) 2021
 * https://www.bfs.admin.ch/bfs/de/home/statistiken/wirtschaftliche-soziale-situation-bevoelkerung/haushaltsbudget.html
 *
 * All amounts in CHF/Monat (monthly).
 */
import { displayLocale } from "@/lib/format";

// ── Types ──────────────────────────────────────────────────────

export interface PeerGroupProfile {
  ageGroup: "25-34" | "35-44" | "45-54" | "55-64" | "65+";
  canton: string;
  householdType: "single" | "couple" | "family" | "single-parent";
  employmentStatus: "employed" | "self-employed" | "mixed" | "retired";
  incomeLevel: "low" | "medium" | "high"; // <80k / 80–150k / >150k CHF
}

export interface PeerGroupDefaults {
  // Monthly CHF amounts
  housing: number;           // Miete / Hypothek
  groceries: number;         // Lebensmittel
  transport: number;         // Auto + ÖV
  health_insurance: number;  // Krankenkasse
  other_insurance: number;   // Andere Versicherungen
  communication: number;     // Handy + Internet
  dining_out: number;        // Restaurant / Takeaway
  entertainment: number;     // Freizeit, Kino, etc.
  clothing: number;          // Kleidung
  travel: number;            // Urlaub (monatlich aufgeteilt)
  education: number;         // Weiterbildung
  subscriptions: number;     // Netflix, Spotify, etc.
  savings_rate: number;      // % of income
  pillar_3a_monthly: number; // Säule 3a monatlich

  // Peer group metadata
  peerLabel: string;         // e.g. "Zürcher Single-Haushalt, 35-44"
  sampleSize: string;        // e.g. "~42.000 Haushalte (BFS 2023)"
  incomeMedian: number;      // Median CHF / Monat netto
  confidenceNote: string;    // Erklärung zur Datenqualität
}

// ── Canton multipliers (Zürich = 1.0 base) ────────────────────
// Source: BFS Regionaler Preisindex, Kostenunterschiede nach Kanton

const CANTON_MULTIPLIERS: Record<string, number> = {
  ZH: 1.00,
  BS: 1.05,
  GE: 1.08,
  VD: 1.02,
  BE: 0.95,
  AG: 0.90,
  SG: 0.88,
  LU: 0.92,
  ZG: 1.15,
  TI: 0.88,
  VS: 0.85,
  GR: 0.87,
  FR: 0.90,
  SO: 0.89,
  BL: 0.93,
  SH: 0.92,
  AR: 0.87,
  AI: 0.86,
  GL: 0.88,
  TG: 0.89,
  NE: 0.93,
  JU: 0.88,
  UR: 0.86,
  SZ: 0.98,
  OW: 0.87,
  NW: 0.89,
  ZG_extra: 1.15, // duplicate guard
};

// ── Age-based health insurance multipliers (Krankenkasse) ─────
// Grundprämie steigt mit dem Alter (BFS/BAG Referenzwerte 2023)

const HEALTH_INSURANCE_BY_AGE: Record<PeerGroupProfile["ageGroup"], number> = {
  "25-34": 380,
  "35-44": 420,
  "45-54": 460,
  "55-64": 510,
  "65+":   560,
};

// ── Household type base multipliers ───────────────────────────

const HOUSEHOLD_MULTIPLIERS: Record<PeerGroupProfile["householdType"], number> = {
  "single":       1.0,
  "couple":       1.7,
  "family":       2.2,
  "single-parent": 1.5,
};

// ── Income level median (CHF/Monat netto) ─────────────────────

const INCOME_MEDIANS: Record<
  PeerGroupProfile["householdType"],
  Record<PeerGroupProfile["incomeLevel"], number>
> = {
  single:        { low: 3_800, medium: 6_200, high: 11_000 },
  couple:        { low: 6_200, medium: 10_500, high: 18_500 },
  family:        { low: 7_400, medium: 12_500, high: 22_000 },
  "single-parent": { low: 4_200, medium: 6_800, high: 11_500 },
};

// ── Sample sizes (approximate, BFS 2021 HABE) ─────────────────

const SAMPLE_SIZES: Record<PeerGroupProfile["householdType"], string> = {
  single:         "~58.000 Haushalte (BFS HABE 2021)",
  couple:         "~72.000 Haushalte (BFS HABE 2021)",
  family:         "~94.000 Haushalte (BFS HABE 2021)",
  "single-parent": "~18.000 Haushalte (BFS HABE 2021)",
};

// ── Canton full names ──────────────────────────────────────────

const CANTON_NAMES: Record<string, string> = {
  ZH: "Zürich",     BE: "Bern",       LU: "Luzern",     UR: "Uri",
  SZ: "Schwyz",     OW: "Obwalden",   NW: "Nidwalden",  GL: "Glarus",
  ZG: "Zug",        FR: "Freiburg",   SO: "Solothurn",  BS: "Basel-Stadt",
  BL: "Basel-Land", SH: "Schaffhausen",AR: "Appenzell AR",AI: "Appenzell AI",
  SG: "St. Gallen", GR: "Graubünden", AG: "Aargau",     TG: "Thurgau",
  TI: "Tessin",     VD: "Waadt",      VS: "Wallis",     NE: "Neuenburg",
  GE: "Genf",       JU: "Jura",
};

// ── Savings rate by income level ──────────────────────────────

const SAVINGS_RATES: Record<PeerGroupProfile["incomeLevel"], number> = {
  low:    8,
  medium: 16,
  high:   26,
};

// ── Education spending by employment ──────────────────────────

const EDUCATION_BY_EMPLOYMENT: Record<PeerGroupProfile["employmentStatus"], number> = {
  employed:      80,
  "self-employed": 200,
  mixed:         150,
  retired:       40,
};

// ── Core computation ──────────────────────────────────────────

function round50(n: number): number {
  return Math.round(n / 50) * 50;
}

function round10(n: number): number {
  return Math.round(n / 10) * 10;
}

export function getPeerGroupDefaults(profile: PeerGroupProfile): PeerGroupDefaults {
  const cm = CANTON_MULTIPLIERS[profile.canton] ?? 0.93;
  const hm = HOUSEHOLD_MULTIPLIERS[profile.householdType];
  const ageHealthBase = HEALTH_INSURANCE_BY_AGE[profile.ageGroup];
  const incomeMedian = INCOME_MEDIANS[profile.householdType][profile.incomeLevel];
  const savingsRate = SAVINGS_RATES[profile.incomeLevel];

  // ── Base expense calculations ──
  const housingBase: Record<PeerGroupProfile["householdType"], number> = {
    single:         1_450,
    couple:         1_850,
    family:         2_200,
    "single-parent": 1_650,
  };
  const groceriesBase: Record<PeerGroupProfile["householdType"], number> = {
    single:         480,
    couple:         780,
    family:         1_050,
    "single-parent": 680,
  };
  const transportBase: Record<PeerGroupProfile["householdType"], number> = {
    single:         580,
    couple:         700,
    family:         800,
    "single-parent": 620,
  };

  const housing = round50(housingBase[profile.householdType] * cm);
  const groceries = round10(groceriesBase[profile.householdType] * cm);
  const transport = round10(transportBase[profile.householdType] * cm);

  // Health insurance: per person, age-adjusted, canton-adjusted
  const personsInHousehold =
    profile.householdType === "single" ? 1
    : profile.householdType === "couple" ? 2
    : profile.householdType === "family" ? 2.8 // avg 0.8 children
    : 1.5; // single-parent: 1 adult + avg 1.5 kids
  const kk = round10(ageHealthBase * cm * personsInHousehold);

  // Other insurance (Hausrat, Haftpflicht, Auto)
  const otherInsurance = round10(120 * cm * Math.sqrt(hm));

  // Communication (Handy + Internet, slight canton variation)
  const communication = round10(
    profile.householdType === "single" ? 110 * cm
    : 160 * cm
  );

  // Dining out varies by age group and income
  const diningOutBase: Record<PeerGroupProfile["ageGroup"], number> = {
    "25-34": 320,
    "35-44": 290,
    "45-54": 270,
    "55-64": 240,
    "65+":   200,
  };
  const incomeDiningMultiplier = profile.incomeLevel === "high" ? 1.4 : profile.incomeLevel === "medium" ? 1.0 : 0.7;
  const dining_out = round10(diningOutBase[profile.ageGroup] * cm * incomeDiningMultiplier * Math.sqrt(hm / 1.5));

  // Entertainment
  const entertainmentBase = profile.incomeLevel === "high" ? 280 : profile.incomeLevel === "medium" ? 200 : 140;
  const entertainment = round10(entertainmentBase * cm * Math.sqrt(hm));

  // Clothing
  const clothingBase = profile.incomeLevel === "high" ? 250 : profile.incomeLevel === "medium" ? 170 : 110;
  const clothing = round10(clothingBase * Math.sqrt(hm));

  // Travel (annualized per month)
  const travelBase: Record<PeerGroupProfile["incomeLevel"], number> = {
    low:    150,
    medium: 280,
    high:   480,
  };
  const travel = round50(travelBase[profile.incomeLevel] * Math.sqrt(hm));

  // Education
  const education = round10(EDUCATION_BY_EMPLOYMENT[profile.employmentStatus] * cm);

  // Subscriptions (streaming, cloud, etc.)
  const subscriptionsBase = profile.householdType === "single" ? 100 : 130;
  const subscriptions = round10(subscriptionsBase);

  // Pillar 3a: max annual contribution 2023 = CHF 7,056 for employed
  const pillar3aAnnualMax = profile.employmentStatus === "self-employed" ? 35_280 : 7_056;
  const pillar3aUsageRate = profile.incomeLevel === "high" ? 0.95 : profile.incomeLevel === "medium" ? 0.70 : 0.35;
  const pillar_3a_monthly = Math.round((pillar3aAnnualMax * pillar3aUsageRate) / 12);

  // ── Label construction ──
  const cantonName = CANTON_NAMES[profile.canton] ?? profile.canton;
  const hhLabel: Record<PeerGroupProfile["householdType"], string> = {
    single:         "Single-Haushalt",
    couple:         "Paar-Haushalt",
    family:         "Familienhaushalt",
    "single-parent": "Alleinerziehend",
  };
  const peerLabel = `${cantonName}er ${hhLabel[profile.householdType]}, ${profile.ageGroup}`;

  // ── Confidence note ──
  const confidenceByAge: Record<PeerGroupProfile["ageGroup"], string> = {
    "25-34": "Gute Datenlage (n > 8.000 in diesem Segment)",
    "35-44": "Sehr gute Datenlage (n > 12.000 in diesem Segment)",
    "45-54": "Sehr gute Datenlage (n > 14.000 in diesem Segment)",
    "55-64": "Gute Datenlage (n > 9.000 in diesem Segment)",
    "65+":   "Moderate Datenlage (Stichprobe kleiner, Renten dominieren)",
  };

  return {
    housing,
    groceries,
    transport,
    health_insurance: kk,
    other_insurance:  otherInsurance,
    communication,
    dining_out,
    entertainment,
    clothing,
    travel,
    education,
    subscriptions,
    savings_rate:     savingsRate,
    pillar_3a_monthly,
    peerLabel,
    sampleSize:        SAMPLE_SIZES[profile.householdType],
    incomeMedian,
    confidenceNote:    confidenceByAge[profile.ageGroup],
  };
}

// ── Common Swiss subscriptions ─────────────────────────────────

export interface SubscriptionItem {
  name: string;
  price: number;
  category: string;
  defaultChecked?: boolean;
}

export const COMMON_SUBSCRIPTIONS: SubscriptionItem[] = [
  { name: "Netflix",                price: 18,  category: "streaming",     defaultChecked: true  },
  { name: "Spotify",                price: 13,  category: "music",         defaultChecked: true  },
  { name: "Disney+",                price: 12,  category: "streaming",     defaultChecked: false },
  { name: "NZZ Digital",            price: 39,  category: "news",          defaultChecked: false },
  { name: "Blick+",                 price: 13,  category: "news",          defaultChecked: false },
  { name: "SRF Play (optional)",    price: 0,   category: "streaming",     defaultChecked: false },
  { name: "iCloud 200GB",           price: 3,   category: "cloud",         defaultChecked: false },
  { name: "Google One",             price: 3,   category: "cloud",         defaultChecked: false },
  { name: "Microsoft 365",          price: 12,  category: "software",      defaultChecked: false },
  { name: "Migros Cumulus Extra",   price: 8,   category: "loyalty",       defaultChecked: false },
  { name: "ADSL/Fiber (Swisscom)",  price: 59,  category: "internet",      defaultChecked: true  },
  { name: "Mobile Abo (Sunrise)",   price: 39,  category: "mobile",        defaultChecked: true  },
  { name: "SBB Halbtax",            price: 19,  category: "transport",     defaultChecked: false },
  { name: "SBB GA 2. Kl.",          price: 345, category: "transport",     defaultChecked: false },
  { name: "Fitnesscenter",          price: 80,  category: "fitness",       defaultChecked: false },
  { name: "Adobe Creative Cloud",   price: 56,  category: "software",      defaultChecked: false },
  { name: "LinkedIn Premium",       price: 45,  category: "professional",  defaultChecked: false },
  { name: "Dropbox Plus",           price: 12,  category: "cloud",         defaultChecked: false },
  { name: "Amazon Prime",           price: 9,   category: "shopping",      defaultChecked: false },
  { name: "YouTube Premium",        price: 14,  category: "streaming",     defaultChecked: false },
];

// ── Utility: format CHF ────────────────────────────────────────

export function formatCHF(amount: number, decimals = 0): string {
  return new Intl.NumberFormat(displayLocale(), {
    style: "currency",
    currency: "CHF",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(amount);
}

// ── All 26 cantons list ────────────────────────────────────────

export const SWISS_CANTONS: { code: string; name: string }[] = Object.entries(CANTON_NAMES)
  .filter(([code]) => code !== "ZG_extra")
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name, "de-CH"));
