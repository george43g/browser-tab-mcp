/**
 * Flattened row model for the browser > window > tab tree (pure — unit
 * testable without ink).
 */

import type { BrowserState, BrowserWindow, Snapshot, Tab, TabGroup } from "@george43g/shared-types";

/**
 * Compact status badges shown at the end of a tab's row — full coverage of the
 * contract-v2 tab enrichment already in the snapshot (no extra fetch), in a
 * stable left-to-right order:
 *
 *   📌 pinned · ⏳ loading (status) · 🔇 muted / 🔊 audible · 🧊 frozen ·
 *   💤 discarded (asleep) · ⊞<name> tab group
 *
 * Muted wins over audible (a playing-but-silenced tab reads as silenced).
 * Grouped tabs show the group title when known (▸ is already the fold/browser
 * marker, so groups get their own ⊞ glyph). `active` is the row's leading
 * ●/· marker, not a trailing badge; `mutedReason` folds into 🔇 and
 * `lastAccessed` is MRU data (surfaced via `journal`/sort), so neither gets a
 * glyph. Pure — unit-testable without ink.
 */
/** Chrome's tab-group palette → a coloured disc. Unknown names fall back to `⊞`. */
const GROUP_DISC: Record<string, string> = {
  grey: "⚪",
  blue: "🔵",
  red: "🔴",
  yellow: "🟡",
  green: "🟢",
  pink: "🩷",
  purple: "🟣",
  cyan: "🩵",
  orange: "🟠",
};

export function tabBadges(tab: Tab, groups: readonly TabGroup[]): string {
  const parts: string[] = [];
  if (tab.pinned) parts.push("📌");
  if (tab.status === "loading") parts.push("⏳");
  if (tab.muted) parts.push("🔇");
  else if (tab.audible) parts.push("🔊");
  if (tab.frozen) parts.push("🧊");
  if (tab.discarded) parts.push("💤");
  if (tab.groupId) {
    const group = groups.find((g) => g.groupId === tab.groupId);
    const title = group?.title?.trim();
    // The group's COLOUR is the property Chrome shows and this TUI never did.
    // A coloured disc carries it without an ANSI escape — which matters here
    // because this string is measured by `visualWidth` before it is printed,
    // and colour bytes would corrupt that arithmetic (the CLI can paint
    // instead, because layoutRow separates text from paint).
    //
    // An unknown colour falls back to the plain `⊞`, so a palette Chrome adds
    // later degrades rather than rendering a stray glyph. If a font lacks one
    // of these, it renders NARROWER than the width maths assumed — which
    // leaves the row short, never overflowing.
    const disc = group?.color ? GROUP_DISC[group.color] : undefined;
    const glyph = disc ?? "⊞";
    parts.push(title ? `${glyph}${title.slice(0, 16)}` : glyph);
  }
  return parts.join(" ");
}

export type Row =
  | { kind: "browser"; key: string; browser: BrowserState }
  | { kind: "window"; key: string; browser: BrowserState; window: BrowserWindow }
  | { kind: "tab"; key: string; browser: BrowserState; window: BrowserWindow; tab: Tab };

export function buildRows(snapshot: Snapshot | null, folded: ReadonlySet<string>): Row[] {
  if (!snapshot) return [];
  const rows: Row[] = [];
  for (const browser of snapshot.browsers) {
    if (!browser.running && browser.windows.length === 0) continue;
    rows.push({ kind: "browser", key: `b:${browser.browser}`, browser });
    for (const window of browser.windows) {
      rows.push({ kind: "window", key: window.windowId, browser, window });
      if (folded.has(window.windowId)) continue;
      for (const tab of window.tabs) {
        rows.push({ kind: "tab", key: tab.tabId, browser, window, tab });
      }
    }
  }
  return rows;
}
