/**
 * Design system constants — mirror of tailwind.config.js values.
 * Use these in JS/TS contexts (chart configs, inline styles, etc.)
 * that can't read Tailwind classes directly.
 *
 * Theme-bewusst: `themePalettes.dark` / `themePalettes.light` +
 * `buildNivoTheme(palette)`. Komponenten nutzen den Hook
 * `useThemeColors()` (src/hooks/useThemeColors.ts); die Exporte
 * `colors` / `nivoTheme` sind Dark-Aliase für noch nicht migrierte Stellen.
 */
import { displayLocale } from "./format";

// Chart-Serienfarben sind in beiden Themes lesbar und bleiben geteilt.
const chart = {
  1: "#3b82f6",
  2: "#4ade80",
  3: "#f87171",
  4: "#fbbf24",
  5: "#a78bfa",
  6: "#34d399",
  7: "#fb923c",
  8: "#38bdf8",
} as const;

const chartPalette = [
  "#3b82f6",
  "#4ade80",
  "#f87171",
  "#fbbf24",
  "#a78bfa",
  "#34d399",
  "#fb923c",
  "#38bdf8",
  "#f472b6",
  "#6ee7b7",
] as const;

const darkPalette = {
  // ── Background ──────────────────────────────────────────────
  bg: "#0d0e12",
  bgSurface: "#13141a",
  bgSurface2: "#1a1b23",
  bgElevated: "#20212c",

  // ── Border ───────────────────────────────────────────────────
  border: "rgba(255,255,255,0.13)",
  borderSubtle: "rgba(255,255,255,0.07)",
  borderStrong: "rgba(255,255,255,0.22)",

  // ── Text ─────────────────────────────────────────────────────
  textPrimary: "#f0f1f5",
  textSecondary: "#b4bfcc",
  textTertiary: "#8896a8",
  textDisabled: "#535e6b",

  // ── Accent ────────────────────────────────────────────────────
  accent: "#3b82f6",
  accentLight: "#60a5fa",
  accentDark: "#2563eb",
  accentMuted: "rgba(59,130,246,0.15)",

  // ── Financial ─────────────────────────────────────────────────
  gain: "#4ade80",
  gainLight: "#86efac",
  gainMuted: "rgba(74,222,128,0.15)",

  loss: "#f87171",
  lossLight: "#fca5a5",
  lossMuted: "rgba(248,113,113,0.15)",

  warning: "#fbbf24",
  warningLight: "#fde68a",
  warningMuted: "rgba(251,191,36,0.15)",

  purple: "#a78bfa",
  purpleLight: "#c4b5fd",
  purpleMuted: "rgba(167,139,250,0.15)",

  teal: "#34d399",

  // ── Chart palette ─────────────────────────────────────────────
  chart,
  chartPalette,

  // Tooltip-Schatten (Nivo/Recharts)
  tooltipShadow: "0 8px 32px rgba(0,0,0,0.5)",
} as const;

const lightPalette: ThemePalette = {
  bg: "#f7f7f5",
  bgSurface: "#ffffff",
  bgSurface2: "#f3f3f0",
  bgElevated: "#ececea",

  border: "rgba(15,17,22,0.12)",
  borderSubtle: "rgba(15,17,22,0.07)",
  borderStrong: "rgba(15,17,22,0.22)",

  textPrimary: "#15171c",
  textSecondary: "#45505d",
  textTertiary: "#7a8493",
  textDisabled: "#9aa3ae",

  accent: "#3b82f6",
  accentLight: "#60a5fa",
  accentDark: "#2563eb",
  accentMuted: "rgba(59,130,246,0.15)",

  // Dunklere Semantik für WCAG-Kontrast auf hellen Flächen
  gain: "#16a34a",
  gainLight: "#22c55e",
  gainMuted: "rgba(22,163,74,0.15)",

  loss: "#dc2626",
  lossLight: "#ef4444",
  lossMuted: "rgba(220,38,38,0.15)",

  warning: "#d97706",
  warningLight: "#f59e0b",
  warningMuted: "rgba(217,119,6,0.15)",

  purple: "#7c3aed",
  purpleLight: "#8b5cf6",
  purpleMuted: "rgba(124,58,237,0.15)",

  teal: "#0d9488",

  chart,
  chartPalette,

  tooltipShadow: "0 8px 32px rgba(15,17,22,0.15)",
};

export type ThemePalette = {
  [K in keyof typeof darkPalette]: (typeof darkPalette)[K] extends string
    ? string
    : (typeof darkPalette)[K];
};

export const themePalettes: Record<"dark" | "light", ThemePalette> = {
  dark: darkPalette,
  light: lightPalette,
};

/** @deprecated Dark-Alias — neue Stellen nutzen useThemeColors(). */
export const colors = themePalettes.dark;

// ── Nivo chart theme ──────────────────────────────────────────

export function buildNivoTheme(c: ThemePalette) {
  return {
    background: "transparent",
    textColor: c.textSecondary,
    fontSize: 12,
    fontFamily: "Syne, system-ui, sans-serif",
    axis: {
      domain: {
        line: {
          stroke: c.border,
          strokeWidth: 1,
        },
      },
      legend: {
        text: {
          fill: c.textTertiary,
          fontSize: 11,
        },
      },
      ticks: {
        line: {
          stroke: c.borderSubtle,
          strokeWidth: 1,
        },
        text: {
          fill: c.textTertiary,
          fontSize: 11,
        },
      },
    },
    grid: {
      line: {
        stroke: c.borderSubtle,
        strokeWidth: 1,
      },
    },
    legends: {
      title: {
        text: {
          fill: c.textSecondary,
          fontSize: 11,
        },
      },
      text: {
        fill: c.textSecondary,
        fontSize: 11,
      },
      ticks: {
        line: {},
        text: {
          fill: c.textTertiary,
          fontSize: 10,
        },
      },
    },
    annotations: {
      text: {
        fill: c.textPrimary,
        fontSize: 12,
      },
      link: {
        stroke: c.accent,
        strokeWidth: 1,
      },
      outline: {
        stroke: c.border,
        strokeWidth: 2,
      },
      symbol: {
        fill: c.bgSurface,
        outlineWidth: 2,
        outlineColor: c.accent,
      },
    },
    tooltip: {
      container: {
        background: c.bgElevated,
        color: c.textPrimary,
        fontSize: 12,
        borderRadius: "6px",
        border: `1px solid ${c.border}`,
        padding: "8px 12px",
        boxShadow: c.tooltipShadow,
      },
    },
    crosshair: {
      line: {
        stroke: c.textTertiary,
        strokeWidth: 1,
        strokeOpacity: 0.5,
      },
    },
  };
}

/** @deprecated Dark-Alias — neue Stellen nutzen useThemeColors().nivoTheme. */
export const nivoTheme = buildNivoTheme(themePalettes.dark);

// ── Category colors ───────────────────────────────────────────
// NOTE: canonical colours now live in src/lib/categories.ts (getCategoryColor).
// This map is kept for legacy compatibility but defers to SUPER_CATEGORIES.

export const categoryColors: Record<string, string> = {
  // ── Wohnen (amber) ──────────────────────────────────────────
  Housing: "#f0b429",
  Wohnen: "#f0b429",
  Utilities: "#f0b429",
  Nebenkosten: "#f0b429",
  // ── Essen & Trinken (lime) ───────────────────────────────────
  Groceries: "#84cc16",
  "Food & Drink": "#84cc16",
  Lebensmittel: "#84cc16",
  "Restaurant & Takeaway": "#84cc16",
  // ── Mobilität (sky) ─────────────────────────────────────────
  Transport: "#38bdf8",
  Travel: "#38bdf8",
  Reisen: "#38bdf8",
  "ÖV-Abonnements": "#38bdf8",
  // ── Versicherungen & Gesundheit (violet) ─────────────────────
  Insurance: "#a78bfa",
  Health: "#a78bfa",
  Versicherungen: "#a78bfa",
  Krankenkasse: "#a78bfa",
  Gesundheit: "#a78bfa",
  Fitness: "#a78bfa",
  // ── Freizeit & Unterhaltung (orange) ─────────────────────────
  Entertainment: "#fb923c",
  Unterhaltung: "#fb923c",
  "Freizeit & Unterhaltung": "#fb923c",
  // ── Abonnements & Kommunikation (cyan) ───────────────────────
  Abonnements: "#22d3ee",
  Kommunikation: "#22d3ee",
  Streaming: "#22d3ee",
  // ── Shopping & Kleidung (pink) ───────────────────────────────
  Shopping: "#ec4899",
  Kleidung: "#ec4899",
  // ── Bildung (indigo) ─────────────────────────────────────────
  Education: "#6366f1",
  Bildung: "#6366f1",
  // ── Einnahmen / Sparen (emerald) ─────────────────────────────
  Salary: "#10b981",
  Sparen: "#10b981",
  Investment: "#10b981",
  // ── Sonstiges (slate) ────────────────────────────────────────
  Finance: "#94a3b8",
  Services: "#94a3b8",
  Taxes: "#94a3b8",
  Other: "#94a3b8",
};

// ── Formatters ────────────────────────────────────────────────

export function formatCHF(amount: number, compact = false): string {
  if (compact && Math.abs(amount) >= 1_000_000) {
    return `CHF ${(amount / 1_000_000).toFixed(1)}M`;
  }
  if (compact && Math.abs(amount) >= 1_000) {
    return `CHF ${(amount / 1_000).toFixed(0)}k`;
  }
  return new Intl.NumberFormat(displayLocale(), {
    style: "currency",
    currency: "CHF",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatAmount(amount: number, currency = "CHF", maximumFractionDigits = 2): string {
  return new Intl.NumberFormat(displayLocale(), {
    style: "currency",
    currency,
    minimumFractionDigits: maximumFractionDigits,
    maximumFractionDigits,
  }).format(amount);
}

/** Compact label (e.g. Budgetplan chips): «EUR 12k» style when large. */
export function formatCurrencyCompact(amount: number, currency: string): string {
  const a = Math.abs(amount);
  if (a >= 1_000_000) {
    return `${currency} ${(amount / 1_000_000).toFixed(1)}M`;
  }
  if (a >= 1_000) {
    return `${currency} ${(amount / 1_000).toFixed(0)}k`;
  }
  return formatAmount(amount, currency, 0);
}

export function formatPercent(value: number): string {
  return `${(value >= 0 ? "+" : "")}${(value * 100).toFixed(1)}%`;
}

// ── Periodicity / Frequency ───────────────────────────────────

export type Periodicity = "weekly" | "monthly" | "quarterly" | "halfyearly" | "yearly";

export const PERIODICITY_LABELS: Record<string, string> = {
  weekly: "Wöchentlich",
  monthly: "Monatlich",
  quarterly: "Vierteljährlich",
  halfyearly: "Halbjährlich",
  yearly: "Jährlich",
};

/**
 * Returns Tailwind class string (bg + border + text) for the periodicity value.
 * Guaranteed to use full literal class names so Tailwind JIT keeps them.
 * Light-Mode-Varianten zuerst, `dark:` überschreibt (darkMode-Selector
 * in tailwind.config.js zeigt auf [data-theme="dark"]).
 */
export function getFrequencyStyle(periodicity: string | null | undefined): string {
  switch (periodicity) {
    case "weekly":     return "bg-cyan-100 border-cyan-300 text-cyan-700 dark:bg-cyan-900/20 dark:border-cyan-800 dark:text-cyan-300";
    case "monthly":    return "bg-blue-100 border-blue-300 text-blue-700 dark:bg-blue-900/20 dark:border-blue-800 dark:text-blue-300";
    case "quarterly":  return "bg-orange-100 border-orange-300 text-orange-700 dark:bg-orange-900/20 dark:border-orange-800 dark:text-orange-300";
    case "halfyearly": return "bg-violet-100 border-violet-300 text-violet-700 dark:bg-violet-900/20 dark:border-violet-800 dark:text-violet-300";
    case "yearly":     return "bg-emerald-100 border-emerald-300 text-emerald-700 dark:bg-emerald-900/20 dark:border-emerald-800 dark:text-emerald-300";
    default:           return "bg-slate-200 border-slate-300 text-slate-600 dark:bg-slate-700/50 dark:border-slate-600 dark:text-slate-400";
  }
}

/** Tailwind badge classes (no border) for inline status chips. */
export function getFrequencyBadgeStyle(periodicity: string | null | undefined): string {
  switch (periodicity) {
    case "weekly":     return "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300";
    case "monthly":    return "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300";
    case "quarterly":  return "bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300";
    case "halfyearly": return "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300";
    case "yearly":     return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300";
    default:           return "bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-400";
  }
}
