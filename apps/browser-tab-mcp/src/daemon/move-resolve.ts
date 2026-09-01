/**
 * Signed-position resolution for move_tab (`to` / `by` / bare same-window).
 *
 * The public language is signed and one-based (spec §5: 1 = first, -1 = last,
 * 0 invalid, out-of-range clamps); browsers speak mutable 0-based indexes.
 * Translation happens HERE, in the daemon, against a snapshot taken at
 * resolve time — never in the schema and never in the extension, so the
 * already-deployed extension bundle keeps working unchanged (the wire carries
 * only the absolute form it has always carried).
 *
 * The snapshot can lag the browser by design; the executor's settled
 * `tabs.get` read at the end of the extension pathway is what reports the
 * tab's ACTUAL final position, so a stale resolve degrades to an off-by-a-bit
 * landing that the result reports honestly — not to a lie.
 */

import type { Snapshot } from "@george43g/shared-types";

/** Where a tab currently sits, per the resolve-time snapshot. */
export interface TabLocation {
  windowId: string;
  /** 0-based index within its window. */
  index: number;
  /** Tabs currently in that window. */
  windowTabCount: number;
}

export function findTabLocation(snapshot: Snapshot, tabId: string): TabLocation | null {
  for (const b of snapshot.browsers) {
    for (const w of b.windows) {
      const tab = w.tabs.find((t) => t.tabId === tabId);
      if (tab) return { windowId: w.windowId, index: tab.index, windowTabCount: w.tabs.length };
    }
  }
  return null;
}

export function findWindowTabCount(snapshot: Snapshot, windowId: string): number | null {
  for (const b of snapshot.browsers) {
    for (const w of b.windows) {
      if (w.windowId === windowId) return w.tabs.length;
    }
  }
  return null;
}

export interface SignedMoveArgs {
  to?: number | undefined;
  by?: number | undefined;
  /** The tab's current 0-based index (used only by `by`). */
  currentIndex: number;
  /** True when the destination window is the tab's own window. */
  sameWindow: boolean;
  /** Tabs currently in the destination window (before the move). */
  destTabCount: number;
}

/**
 * Resolve `to`/`by` to a 0-based browser index, or `undefined` for
 * "append at the end".
 *
 * "End" is deliberately normalized to `undefined` rather than a concrete
 * number: the extension executor maps it to `chrome.tabs.move`'s `-1`
 * (append), and Safari's AppleScript pathway only supports appending — a
 * concrete index would turn `to: -1` into a refusal on a pathway that can in
 * fact do exactly what was asked.
 *
 * For a cross-window `to`, positions address the destination as it will be
 * AFTER insertion (N = destTabCount + 1 slots): `to: -1` is "last",
 * `to: -2` is "second-last after the move". Same-window keeps N = destTabCount
 * because the moving tab already occupies one of the positions.
 */
export function resolveSignedIndex(args: SignedMoveArgs): number | undefined {
  const { to, by, currentIndex, sameWindow, destTabCount } = args;
  if (by !== undefined) {
    // Relative: clamp at the window edges (spec §5.2 — offsets clip, never wrap).
    const last = Math.max(destTabCount - 1, 0);
    const idx = Math.min(Math.max(currentIndex + by, 0), last);
    return idx === last ? undefined : idx;
  }
  if (to !== undefined) {
    const n = sameWindow ? Math.max(destTabCount, 1) : destTabCount + 1;
    const pos = to > 0 ? Math.min(to, n) : Math.max(n + to + 1, 1);
    const idx = pos - 1;
    return idx === n - 1 ? undefined : idx;
  }
  return undefined;
}
