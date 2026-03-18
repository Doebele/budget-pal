/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // ── Background ──────────────────────────────────────
        bg: {
          DEFAULT: "#0d0e12",
          surface: "#13141a",
          surface2: "#1a1b23",
          elevated: "#20212c",
        },

        // ── Border ───────────────────────────────────────────
        border: {
          DEFAULT: "rgba(255,255,255,0.13)",
          subtle: "rgba(255,255,255,0.07)",
          strong: "rgba(255,255,255,0.22)",
        },

        // ── Text ─────────────────────────────────────────────
        text: {
          primary: "#f0f1f5",
          secondary: "#b4bfcc",
          tertiary: "#8896a8",
          disabled: "#535e6b",
        },

        // ── Accent (blue) ────────────────────────────────────
        accent: {
          DEFAULT: "#3b82f6",
          light: "#60a5fa",
          dark: "#2563eb",
          muted: "rgba(59,130,246,0.15)",
        },

        // ── Financial States ─────────────────────────────────
        gain: {
          DEFAULT: "#4ade80",
          light: "#86efac",
          muted: "rgba(74,222,128,0.15)",
        },
        loss: {
          DEFAULT: "#f87171",
          light: "#fca5a5",
          muted: "rgba(248,113,113,0.15)",
        },

        // ── Warning ──────────────────────────────────────────
        warning: {
          DEFAULT: "#fbbf24",
          light: "#fde68a",
          muted: "rgba(251,191,36,0.15)",
        },

        // ── Purple (projections) ──────────────────────────────
        purple: {
          DEFAULT: "#a78bfa",
          light: "#c4b5fd",
          muted: "rgba(167,139,250,0.15)",
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
        DEFAULT: "0.5rem",
        card: "0.75rem",
        xl: "1rem",
        "2xl": "1.25rem",
      },

      boxShadow: {
        card: "0 4px 24px rgba(0,0,0,0.4)",
        glow: "0 0 20px rgba(59,130,246,0.25)",
        "glow-green": "0 0 20px rgba(74,222,128,0.2)",
      },

      backgroundImage: {
        "gradient-card": "linear-gradient(135deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%)",
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
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },

      animation: {
        "fade-in": "fade-in 0.3s ease-out",
        "slide-in": "slide-in 0.25s ease-out",
        shimmer: "shimmer 2s linear infinite",
      },
    },
  },
  plugins: [],
};
