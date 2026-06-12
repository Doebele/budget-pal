/**
 * useThemeColors — theme-bewusste Chart-/JS-Farben.
 * Liest das aktive Theme aus dem UI-Store und liefert die passende
 * Palette plus ein darauf aufgebautes Nivo-Theme.
 */
import { useMemo } from "react";
import { useUiStore } from "@/lib/store";
import { buildNivoTheme, themePalettes, type ThemePalette } from "@/lib/theme";

export function useThemeColors(): {
  theme: "dark" | "light";
  colors: ThemePalette;
  nivoTheme: ReturnType<typeof buildNivoTheme>;
} {
  const theme = useUiStore((s) => s.theme);
  return useMemo(
    () => ({
      theme,
      colors: themePalettes[theme],
      nivoTheme: buildNivoTheme(themePalettes[theme]),
    }),
    [theme]
  );
}
