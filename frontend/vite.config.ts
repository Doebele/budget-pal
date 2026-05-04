import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "pwa-192.svg", "pwa-512.svg"],
      manifest: {
        name: "Budget-Pal",
        short_name: "BudgetPal",
        description: "Persönliche Finanzplanung mit Schweizer Rentenrechner, Monte Carlo und KI-Kategorisierung.",
        theme_color: "#0d0e12",
        background_color: "#0d0e12",
        display: "standalone",
        orientation: "portrait-primary",
        scope: "/",
        start_url: "/",
        lang: "de-CH",
        icons: [
          { src: "/pwa-192.svg", sizes: "192x192", type: "image/svg+xml" },
          { src: "/pwa-512.svg", sizes: "512x512", type: "image/svg+xml" },
          { src: "/pwa-512.svg", sizes: "512x512", type: "image/svg+xml", purpose: "any maskable" },
        ],
        categories: ["finance", "productivity"],
        shortcuts: [
          { name: "Transaktionen", url: "/transactions", description: "Transaktionen anzeigen" },
          { name: "Budget", url: "/budget", description: "Budgetanalyse öffnen" },
          { name: "Import", url: "/import", description: "Bankauszug importieren" },
        ],
      },
      workbox: {
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts",
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
          {
            urlPattern: /\/api\/.*/,
            handler: "NetworkOnly", // API-Antworten nie cachen
          },
        ],
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
      },
    }),
  ],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  server: {
    port: parseInt(process.env.PORT || "5173"),
    proxy: {
      // Proxy /api requests to the backend during development
      "/api": {
        target: process.env.VITE_BACKEND_URL || "http://localhost:8010",
        changeOrigin: true,
        secure: false,
      },
    },
  },

  build: {
    outDir: "dist",
    sourcemap: false,
    // Nivo + Recharts exceed Vite’s default 500 kB warning; gzip is typically ~150 kB.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom", "react-router-dom"],
          "query": ["@tanstack/react-query"],
          "charts": [
            "recharts",
            "@nivo/core",
            "@nivo/bar",
            "@nivo/heatmap",
            "@nivo/line",
            "@nivo/pie",
            "@nivo/sankey",
            "@nivo/treemap",
          ],
          "ui": [
            "@radix-ui/react-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-tabs",
            "lucide-react",
          ],
        },
      },
    },
  },
});
