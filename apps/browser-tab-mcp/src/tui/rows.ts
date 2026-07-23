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
export function tabBadges(tab: Tab, groups: readonly TabGroup[]): string {
  const parts: string[] = [];
  if (tab.pinned) parts.push("📌");
  if (tab.status === "loading") parts.push("⏳");
  if (tab.muted) parts.push("🔇");
  else if (tab.audible) parts.push("🔊");
  if (tab.frozen) parts.push("🧊");
  if (tab.discarded) parts.push("💤");
  if (tab.groupId) {
    const title = groups.find((g) => g.groupId === tab.groupId)?.title?.trim();
    parts.push(title ? `⊞${title.slice(0, 16)}` : "⊞");
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
