/**
 * Glyph presets — the user-selectable "theme" axis.
 *
 * - "safe" (default): only universally-renderable glyphs. Geometric Shapes
 *   (▶ ◀ ●), ASCII separators (─), emoji where every modern OS font has
 *   them (✉ 💬). Renders correctly in Apple Terminal, Warp, iTerm2, VS
 *   Code's integrated terminal, Alacritty/kitty with default fonts.
 *
 * - "powerline": Powerline arrows + Nerd Font icons. Looks better but
 *   requires the user's terminal font to be a Nerd-Font-patched build
 *   (FiraCode Nerd Font, JetBrainsMono Nerd Font, etc.).
 *
 * Generic glyphs only — domain-specific glyphs (like iMessage/SMS icons)
 * should be defined per-tool, not in the shared kit.
 */

export interface GlyphSet {
  /** Powerline arrow separators. */
  arrowRight: string;
  arrowRightThin: string;
  arrowLeft: string;
  arrowLeftThin: string;

  /** Status dots */
  unreadDot: string;
  bullet: string;

  /** Action / state */
  check: string;
  cross: string;
  warn: string;
  info: string;

  /** Misc UI */
  search: string;
  refresh: string;
  pencil: string;
  separator: string;
  ellipsis: string;
}

const SAFE: GlyphSet = {
  // Powerline-style arrows aren't safe; fall back to vertical bar.
  arrowRight: "│",
  arrowRightThin: "│",
  arrowLeft: "│",
  arrowLeftThin: "│",
  unreadDot: "●",
  bullet: "•",
  check: "✓",
  cross: "✗",
  warn: "⚠",
  info: "ℹ",
  search: "⌕",
  refresh: "↻",
  pencil: "✎",
  separator: "─",
  ellipsis: "…",
};

const POWERLINE: GlyphSet = {
  arrowRight: "",
  arrowRightThin: "",
  arrowLeft: "",
  arrowLeftThin: "",
  unreadDot: "●",
  bullet: "•",
  check: "",
  cross: "",
  warn: "",
  info: "",
  search: "",
  refresh: "",
  pencil: "",
  separator: "─",
  ellipsis: "…",
};

export const GLYPH_PRESETS = {
  safe: SAFE,
  powerline: POWERLINE,
} as const;

export type GlyphPreset = keyof typeof GLYPH_PRESETS;
