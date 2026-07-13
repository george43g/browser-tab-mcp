/**
 * Accent-driven palette derivation.
 *
 * Given a single accent hex (default `#1982FC`, a friendly blue), derive
 * a coherent ~25-color palette: foreground/background tiers, semantic
 * status colors, dim/muted variants. All variants stay in the accent's
 * "color family" via HSL rotation; semantic colors (success/warning/
 * danger/info) are anchored to canonical hues so they remain readable
 * across all accents.
 */

import { contrastRatio, hslToHex, tint, withL } from "./color.js";

export interface Palette {
  // Backgrounds
  bg: string;
  bgAlt: string;
  bgRaised: string;

  // Foregrounds
  fg: string;
  fgMuted: string;
  fgDim: string;

  // Accent variants
  accent: string;
  accentMuted: string;
  accentBg: string;

  // Borders
  border: string;
  borderDim: string;

  // Semantic
  success: string;
  warning: string;
  danger: string;
  info: string;

  // Status text helpers
  ok: string;
  pending: string;
  error: string;
}

/** Pick fg color (dark vs light) that maximizes contrast against given bg. */
export function fgFor(bg: string): string {
  const candDark = "#111111";
  const candLight = "#f5f5f5";
  return contrastRatio(candLight, bg) >= contrastRatio(candDark, bg) ? candLight : candDark;
}

export function derivePalette(accent: string): Palette {
  return {
    bg: "#0e1116",
    bgAlt: "#161a20",
    bgRaised: "#1d2229",
    fg: "#e6e8ed",
    fgMuted: "#a0a8b3",
    fgDim: "#6c7480",
    accent,
    accentMuted: tint(accent, 0.55, 0.5),
    accentBg: tint(accent, 0.2, 0.3),
    border: tint(accent, 0.25, 0.35),
    borderDim: tint(accent, 0.18, 0.2),
    success: hslToHex({ h: 140, s: 0.5, l: 0.55 }),
    warning: hslToHex({ h: 40, s: 0.85, l: 0.6 }),
    danger: hslToHex({ h: 0, s: 0.75, l: 0.6 }),
    info: hslToHex({ h: 210, s: 0.7, l: 0.65 }),
    ok: hslToHex({ h: 140, s: 0.5, l: 0.55 }),
    pending: hslToHex({ h: 40, s: 0.85, l: 0.6 }),
    error: hslToHex({ h: 0, s: 0.75, l: 0.6 }),
  };
}

export const DEFAULT_ACCENT = "#1982FC";

/** Brighten a hex by N "stops" (HSL lightness +N*0.05). Used by hover states. */
export function brighten(hex: string, stops = 1): string {
  return withL(hex, Math.min(0.95, 0.5 + stops * 0.05));
}
