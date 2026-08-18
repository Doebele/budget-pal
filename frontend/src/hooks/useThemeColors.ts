/**
 * useThemeColors — theme-bewusste Chart-/JS-Farben.
 * Liest das aktive Theme aus dem UI-Store und liefert die passende Palette.
 */
import { useMemo } from "react";
import { useUiStore } from "@/lib/store";
import { themePalettes, type ThemePalette } from "@/lib/theme";

export function useThemeColors(): {
  theme: "dark" | "light";
  colors: ThemePalette;
} {
  const theme = useUiStore((s) => s.theme);
  return useMemo(
    () => ({
      theme,
      colors: themePalettes[theme],
    }),
    [theme]
  );
}
