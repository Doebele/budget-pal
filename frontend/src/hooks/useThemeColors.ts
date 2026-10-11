/**
 * useThemeColors — theme-bewusste Chart-/JS-Farben.
 * Liest das aktive Theme aus dem UI-Store und liefert die passende Palette.
 */
import { useMemo } from "react";
import { useUiStore } from "@/lib/store";
import { themePalettes, type ThemePalette } from "@/lib/theme";

/** Schrift-Skala in px fuer SVG- und Canvas-Diagramme, die keine CSS-Variablen
 *  lesen: gleiche Werte wie --fs-* in index.css (Komfort = Kompakt + 2 px). */
export type FontScale = { "2xs": number; xs: number; sm: number; base: number };
const FONT_SCALE: Record<"low" | "high", FontScale> = {
  low: { "2xs": 12, xs: 13, sm: 14, base: 16 },
  high: { "2xs": 10, xs: 11, sm: 12, base: 14 },
};

export function useThemeColors(): {
  theme: "dark" | "light";
  colors: ThemePalette;
  fs: FontScale;
} {
  const theme = useUiStore((s) => s.theme);
  const density = useUiStore((s) => s.density);
  return useMemo(
    () => ({
      theme,
      colors: themePalettes[theme],
      fs: FONT_SCALE[density === "high" ? "high" : "low"],
    }),
    [theme, density]
  );
}
