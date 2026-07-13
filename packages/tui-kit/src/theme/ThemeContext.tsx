import { createContext, type ReactNode, useContext, useMemo } from "react";
import { GLYPH_PRESETS, type GlyphPreset, type GlyphSet } from "./glyphs.js";
import { DEFAULT_ACCENT, derivePalette, type Palette } from "./palette.js";

export interface Theme {
  palette: Palette;
  glyphs: GlyphSet;
  preset: GlyphPreset;
  accent: string;
}

export interface MakeThemeArgs {
  preset?: GlyphPreset;
  accent?: string;
}

export function makeTheme({ preset = "safe", accent = DEFAULT_ACCENT }: MakeThemeArgs = {}): Theme {
  return {
    palette: derivePalette(accent),
    glyphs: GLYPH_PRESETS[preset],
    preset,
    accent,
  };
}

const ThemeContext = createContext<Theme | null>(null);

export function ThemeProvider({
  children,
  preset,
  accent,
}: {
  children: ReactNode;
  preset?: GlyphPreset;
  accent?: string;
}) {
  const theme = useMemo(() => {
    const args: MakeThemeArgs = {};
    if (preset !== undefined) args.preset = preset;
    if (accent !== undefined) args.accent = accent;
    return makeTheme(args);
  }, [preset, accent]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const t = useContext(ThemeContext);
  if (!t) {
    throw new Error(
      "useTheme() called outside <ThemeProvider>. Wrap your TUI root with ThemeProvider.",
    );
  }
  return t;
}
