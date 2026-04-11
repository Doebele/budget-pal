/**
 * Design system constants — mirror of tailwind.config.js values.
 * Use these in JS/TS contexts (chart configs, inline styles, etc.)
 * that can't read Tailwind classes directly.
 */

export const colors = {
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
  chart: {
    1: "#3b82f6",
    2: "#4ade80",
    3: "#f87171",
    4: "#fbbf24",
    5: "#a78bfa",
    6: "#34d399",
    7: "#fb923c",
    8: "#38bdf8",
  },

  chartPalette: [
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
  ],
} as const;

// ── Nivo chart theme ──────────────────────────────────────────

export const nivoTheme = {
  background: "transparent",
  textColor: colors.textSecondary,
  fontSize: 12,
  fontFamily: "Syne, system-ui, sans-serif",
  axis: {
    domain: {
      line: {
        stroke: colors.border,
        strokeWidth: 1,
      },
    },
    legend: {
      text: {
        fill: colors.textTertiary,
        fontSize: 11,
      },
    },
    ticks: {
      line: {
        stroke: colors.borderSubtle,
        strokeWidth: 1,
      },
      text: {
        fill: colors.textTertiary,
        fontSize: 11,
      },
    },
  },
  grid: {
    line: {
      stroke: colors.borderSubtle,
      strokeWidth: 1,
    },
  },
  legends: {
    title: {
      text: {
        fill: colors.textSecondary,
        fontSize: 11,
      },
    },
    text: {
      fill: colors.textSecondary,
      fontSize: 11,
    },
    ticks: {
      line: {},
      text: {
        fill: colors.textTertiary,
        fontSize: 10,
      },
    },
  },
  annotations: {
    text: {
      fill: colors.textPrimary,
      fontSize: 12,
    },
    link: {
      stroke: colors.accent,
      strokeWidth: 1,
    },
    outline: {
      stroke: colors.border,
      strokeWidth: 2,
    },
    symbol: {
      fill: colors.bgSurface,
      outlineWidth: 2,
      outlineColor: colors.accent,
    },
  },
  tooltip: {
    container: {
      background: colors.bgElevated,
      color: colors.textPrimary,
      fontSize: 12,
      borderRadius: "6px",
      border: `1px solid ${colors.border}`,
      padding: "8px 12px",
      boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
    },
  },
  crosshair: {
    line: {
      stroke: colors.textTertiary,
      strokeWidth: 1,
      strokeOpacity: 0.5,
    },
  },
};

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
  return new Intl.NumberFormat("de-CH", {
    style: "currency",
    currency: "CHF",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatAmount(amount: number, currency = "CHF", maximumFractionDigits = 2): string {
  return new Intl.NumberFormat("de-CH", {
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
 */
export function getFrequencyStyle(periodicity: string | null | undefined): string {
  switch (periodicity) {
    case "weekly":     return "bg-cyan-900/20 border-cyan-800 text-cyan-300";
    case "monthly":    return "bg-blue-900/20 border-blue-800 text-blue-300";
    case "quarterly":  return "bg-orange-900/20 border-orange-800 text-orange-300";
    case "halfyearly": return "bg-violet-900/20 border-violet-800 text-violet-300";
    case "yearly":     return "bg-emerald-900/20 border-emerald-800 text-emerald-300";
    default:           return "bg-slate-700/50 border-slate-600 text-slate-400";
  }
}

/** Tailwind badge classes (no border) for inline status chips. */
export function getFrequencyBadgeStyle(periodicity: string | null | undefined): string {
  switch (periodicity) {
    case "weekly":     return "bg-cyan-900/50 text-cyan-300";
    case "monthly":    return "bg-blue-900/50 text-blue-300";
    case "quarterly":  return "bg-orange-900/50 text-orange-300";
    case "halfyearly": return "bg-violet-900/50 text-violet-300";
    case "yearly":     return "bg-emerald-900/50 text-emerald-300";
    default:           return "bg-slate-700 text-slate-400";
  }
}
