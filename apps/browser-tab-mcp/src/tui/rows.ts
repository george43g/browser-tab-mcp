/**
 * Flattened row model for the browser > window > tab tree (pure — unit
 * testable without ink).
 */

import type { BrowserState, BrowserWindow, Snapshot, Tab } from "@george43g/shared-types";

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
