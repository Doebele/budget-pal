/** @type {import('tailwindcss').Config} */

// Token mit eingebautem Alpha (z. B. --border-bp = weiss/0.13):
// Plain-Nutzung (border-border) liefert den Token unverändert; ein
// Opacity-Modifier (border-border/50) ersetzt das Alpha themeabhängig
// über das Mono-RGB-Triplet — wie zuvor mit den rgba-Literalen.
const tokenWithAlpha = (plainVar, monoRgbVar) => ({ opacityValue }) =>
  opacityValue === undefined || `${opacityValue}`.includes("var(")
    ? plainVar
    : `rgb(var(${monoRgbVar}) / ${opacityValue})`;

export default {
  darkMode: "class",
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Alle Farben zeigen auf CSS-Variablen (index.css) — Light/Dark
        // wird über [data-theme] gesteuert. RGB-Triplets erhalten die
        // Tailwind-Opacity-Modifier (z. B. bg-accent/15).
        // ── Background ──────────────────────────────────────
        bg: {
          DEFAULT: "rgb(var(--bg-rgb) / <alpha-value>)",
          surface: "rgb(var(--surface-rgb) / <alpha-value>)",
          surface2: "rgb(var(--surface-2-rgb) / <alpha-value>)",
          elevated: "rgb(var(--elevated-rgb) / <alpha-value>)",
        },

        // ── Border (Alpha im Token enthalten; Modifier wie
        //    border-border/50 ersetzen das Alpha themeabhängig) ──
        border: {
          DEFAULT: tokenWithAlpha("var(--border-bp)", "--border-mono-rgb"),
          subtle: tokenWithAlpha("var(--border-bp-subtle)", "--border-mono-rgb"),
          strong: tokenWithAlpha("var(--border-bp-strong)", "--border-mono-rgb"),
        },

        // ── Text ─────────────────────────────────────────────
        text: {
          primary: "rgb(var(--fg-1-rgb) / <alpha-value>)",
          secondary: "rgb(var(--fg-2-rgb) / <alpha-value>)",
          tertiary: "rgb(var(--fg-3-rgb) / <alpha-value>)",
          disabled: tokenWithAlpha("var(--fg-disabled)", "--fg-disabled-rgb"),
        },

        // ── Accent (folgt data-accent Preset) ────────────────
        accent: {
          DEFAULT: "rgb(var(--accent-rgb) / <alpha-value>)",
          light: "var(--accent-light)",
          dark: "var(--accent-dark)",
          muted: "var(--accent-15)",
        },

        // ── Financial States ─────────────────────────────────
        gain: {
          DEFAULT: "rgb(var(--green-rgb) / <alpha-value>)",
          light: "var(--green-light)",
          muted: "rgb(var(--green-rgb) / 0.15)",
        },
        loss: {
          DEFAULT: "rgb(var(--red-rgb) / <alpha-value>)",
          light: "var(--red-light)",
          muted: "rgb(var(--red-rgb) / 0.15)",
        },

        // ── Warning ──────────────────────────────────────────
        warning: {
          DEFAULT: "rgb(var(--yellow-rgb) / <alpha-value>)",
          light: "var(--yellow-light)",
          muted: "rgb(var(--yellow-rgb) / 0.15)",
        },

        // ── Purple (projections) ──────────────────────────────
        purple: {
          DEFAULT: "rgb(var(--purple-rgb) / <alpha-value>)",
          light: "var(--purple-light)",
          muted: "rgb(var(--purple-rgb) / 0.15)",
        },

        // ── Chart palette ─────────────────────────────────────
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
      },

      fontFamily: {
        sans: ["Syne", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
        display: ["DM Serif Display", "Georgia", "serif"],
      },

      fontSize: {
        "2xs": ["0.625rem", { lineHeight: "0.875rem" }],
      },

      borderRadius: {
        none: "0",
        sm: "2px",      // Level 4 – Badges, Icon-Container, Tags
        DEFAULT: "4px", // Level 3 – Inputs, Buttons
        md: "6px",      // Level 2 – Sub-Cards, Accordions, Toggle-Cards
        lg: "8px",      // Level 1 – Haupt-Cards, Sections
        full: "9999px", // Kreise, Progress-Bars, Avatare
      },

      boxShadow: {
        card: "var(--shadow-card)",
        modal: "var(--shadow-modal)",
        glow: "0 0 20px rgba(59,130,246,0.25)",
        "glow-green": "0 0 20px rgba(74,222,128,0.2)",
      },

      backgroundImage: {
        "gradient-card": "linear-gradient(135deg, var(--gradient-card-from) 0%, var(--gradient-card-to) 100%)",
        "gradient-accent": "linear-gradient(135deg, #3b82f6 0%, #6366f1 100%)",
        "gradient-gain": "linear-gradient(135deg, #4ade80 0%, #34d399 100%)",
      },

      keyframes: {
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in": {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(0)" },
        },
        "slide-up": {
          "0%": { transform: "translateY(100%)" },
          "100%": { transform: "translateY(0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },

      animation: {
        "fade-in": "fade-in 0.3s ease-out",
        "slide-in": "slide-in 0.25s ease-out",
        "slide-up": "slide-up 0.3s cubic-bezier(0.32, 0.72, 0, 1)",
        shimmer: "shimmer 2s linear infinite",
      },
    },
  },
  plugins: [],
};
