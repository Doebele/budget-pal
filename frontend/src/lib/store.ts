import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "dark" | "light";
export type Accent = "indigo" | "violet" | "emerald" | "amber" | "rose";
export type Density = "low" | "high";
export type UiLanguage = "de" | "en";

type UiState = {
  theme: Theme;
  accent: Accent;
  density: Density;
  railOpen: boolean;
  // UI language preference — mirrored in users.ui_language (server-side)
  uiLanguage: UiLanguage;
  // Zuletzt gewähltes Ziel-Konto im Import. Muss Seitenwechsel und Neuladen
  // überleben: der Import läuft als Hintergrundjob, und beim Zurückkehren
  // braucht der Bestätigen-Schritt das Konto wieder.
  importAccountId: string;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setAccent: (accent: Accent) => void;
  setDensity: (density: Density) => void;
  toggleDensity: () => void;
  setRailOpen: (open: boolean) => void;
  toggleRail: () => void;
  setUiLanguage: (lang: UiLanguage) => void;
  setImportAccountId: (id: string) => void;
};

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: "dark",
      accent: "indigo",
      density: "low",
      railOpen: true,
      uiLanguage: "de",
      importAccountId: "",
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set((s) => ({ theme: s.theme === "dark" ? "light" : "dark" })),
      setAccent: (accent) => set({ accent }),
      setDensity: (density) => set({ density }),
      toggleDensity: () => set((s) => ({ density: s.density === "high" ? "low" : "high" })),
      setRailOpen: (railOpen) => set({ railOpen }),
      toggleRail: () => set((s) => ({ railOpen: !s.railOpen })),
      setUiLanguage: (uiLanguage) => set({ uiLanguage }),
      setImportAccountId: (importAccountId) => set({ importAccountId }),
    }),
    { name: "budget-pal-ui-v1" }
  )
);
