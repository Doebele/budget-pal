import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  server: {
    port: 5173,
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
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom", "react-router-dom"],
          "query": ["@tanstack/react-query"],
          "charts": ["recharts", "@nivo/core", "@nivo/sankey", "@nivo/bar", "@nivo/line"],
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
