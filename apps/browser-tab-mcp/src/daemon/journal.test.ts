/**
 * JournalStore unit tests — rings, MRU folding, dedupe, navEpoch, seeding,
 * and the ndjson persistence/rotation/warm round-trip (temp dir, no daemon).
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { FocusRecord, NavRecord } from "@george43g/shared-types";
import { makeTmpDir } from "@george43g/test-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JournalStore } from "./journal.js";

let dir: string;
let store: JournalStore;

beforeEach(() => {
  dir = makeTmpDir("browser-tab-journal-");
  store = new JournalStore({ dir, ring: 100 });
});

afterEach(() => {
  store.stop();
  rmSync(dir, { recursive: true, force: true });
});

function focus(over: Partial<FocusRecord> = {}): FocusRecord {
  return {
    ts: 1000,
    browser: "chrome",
    kind: "tab-focus",
    windowId: "w:chrome:x1",
    tabId: "t:chrome:x1",
    source: "ext",
    ...over,
  };
}
function nav(over: Partial<NavRecord> = {}): NavRecord {
  return {
    ts: 1000,
    browser: "chrome",
    tabId: "t:chrome:x1",
    url: "https://a/",
    navEpoch: 1,
    source: "ext",
    ...over,
  };
}

describe("windowMru", () => {
  it("returns windows newest-first, one entry per window", () => {
    store.appendFocus(
      focus({ ts: 1, windowId: "w:chrome:x1", kind: "window-focus", tabId: undefined }),
    );
    store.appendFocus(
      focus({ ts: 2, windowId: "w:chrome:x2", kind: "window-focus", tabId: undefined }),
    );
    store.appendFocus(
      focus({ ts: 3, windowId: "w:chrome:x1", kind: "window-focus", tabId: undefined }),
    );
    expect(store.windowMru(10).map((r) => r.windowId)).toEqual(["w:chrome:x1", "w:chrome:x2"]);
  });

  it("filters by browser", () => {
    store.appendFocus(focus({ ts: 1, browser: "chrome", windowId: "w:chrome:x1" }));
    store.appendFocus(focus({ ts: 2, browser: "safari", windowId: "w:safari:x1" }));
    expect(store.windowMru(10, "safari").map((r) => r.windowId)).toEqual(["w:safari:x1"]);
  });
});

describe("tabMru", () => {
  it("returns a window's tabs newest-first, deduped", () => {
    store.appendFocus(focus({ ts: 1, windowId: "w:chrome:x1", tabId: "t:chrome:x1" }));
    store.appendFocus(focus({ ts: 2, windowId: "w:chrome:x1", tabId: "t:chrome:x2" }));
    store.appendFocus(focus({ ts: 3, windowId: "w:chrome:x1", tabId: "t:chrome:x1" }));
    store.appendFocus(focus({ ts: 4, windowId: "w:chrome:x9", tabId: "t:chrome:x9" }));
    expect(store.tabMru("w:chrome:x1", 10).map((r) => r.tabId)).toEqual([
      "t:chrome:x1",
      "t:chrome:x2",
    ]);
  });
});

describe("journey", () => {
  it("returns a tab's nav chain newest-first", () => {
    store.appendNav(nav({ ts: 1, tabId: "t:chrome:x1", url: "https://a/" }));
    store.appendNav(nav({ ts: 2, tabId: "t:chrome:x2", url: "https://x/" }));
    store.appendNav(nav({ ts: 3, tabId: "t:chrome:x1", url: "https://b/" }));
    expect(store.journey("t:chrome:x1", 10).map((r) => r.url)).toEqual([
      "https://b/",
      "https://a/",
    ]);
  });
});

describe("dedupe", () => {
  it("drops an identical focus within 2s, keeps one outside the window", () => {
    store.appendFocus(focus({ ts: 1000 }));
    store.appendFocus(focus({ ts: 1500 })); // within 2s → dropped
    store.appendFocus(focus({ ts: 4000 })); // outside 2s → kept
    expect(store.recent(10)).toHaveLength(2);
  });
});

describe("navEpoch", () => {
  it("bumps on URL change, stays put on the same URL", () => {
    expect(store.bumpNavEpoch("t:chrome:x1", "https://a/")).toBe(1);
    expect(store.bumpNavEpoch("t:chrome:x1", "https://a/")).toBe(1);
    expect(store.bumpNavEpoch("t:chrome:x1", "https://b/")).toBe(2);
    expect(store.navEpoch("t:chrome:x1")).toBe(2);
  });
});

describe("seedTabMru", () => {
  it("seeds once per browser and stays chronological", () => {
    store.seedTabMru("chrome", [
      focus({ ts: 50, tabId: "t:chrome:x1", source: "seed" }),
      focus({ ts: 10, tabId: "t:chrome:x2", source: "seed" }),
    ]);
    store.seedTabMru("chrome", [focus({ ts: 99, tabId: "t:chrome:x9", source: "seed" })]); // ignored
    expect(store.isSeeded("chrome")).toBe(true);
    // Newest-first tabMru → the ts:50 tab leads the ts:10 tab; the second seed was ignored.
    expect(store.tabMru("w:chrome:x1", 10).map((r) => r.tabId)).toEqual([
      "t:chrome:x1",
      "t:chrome:x2",
    ]);
  });

  it("re-seeds after clearSeed (reconnect)", () => {
    store.seedTabMru("chrome", [focus()]);
    store.clearSeed("chrome");
    expect(store.isSeeded("chrome")).toBe(false);
  });
});

describe("persistence", () => {
  it("round-trips through ndjson (flush → warmFromDisk)", () => {
    store.appendFocus(focus({ ts: 7, tabId: "t:chrome:x7" }));
    store.appendNav(nav({ ts: 8, tabId: "t:chrome:x7", url: "https://seven/" }));
    store.flush();
    const reopened = new JournalStore({ dir, ring: 100 });
    reopened.warmFromDisk();
    expect(reopened.recent(10).map((r) => r.tabId)).toEqual(["t:chrome:x7"]);
    expect(reopened.journey("t:chrome:x7", 10).map((r) => r.url)).toEqual(["https://seven/"]);
    // navEpoch is rebuilt from the persisted nav records.
    expect(reopened.navEpoch("t:chrome:x7")).toBe(1);
  });

  it("rotates the ndjson file past the size cap and warms from the survivor", () => {
    const prev = process.env.BROWSER_TAB_JOURNAL_MAX_BYTES;
    // Cap below one record → each flush rotates; keep-1-generation means the
    // latest record survives in the .1 file (a degenerate cap; real is 5MiB).
    process.env.BROWSER_TAB_JOURNAL_MAX_BYTES = "20";
    try {
      store.appendFocus(focus({ ts: 4000, tabId: "t:chrome:xA" }));
      store.flush();
      store.appendFocus(focus({ ts: 8000, tabId: "t:chrome:xB" }));
      store.flush();
      expect(existsSync(join(dir, "focus.ndjson.1"))).toBe(true);
      const reopened = new JournalStore({ dir, ring: 100 });
      reopened.warmFromDisk();
      // The most recent focus is recoverable after rotation.
      expect(reopened.recent(10).map((r) => r.tabId)).toContain("t:chrome:xB");
    } finally {
      if (prev === undefined) delete process.env.BROWSER_TAB_JOURNAL_MAX_BYTES;
      else process.env.BROWSER_TAB_JOURNAL_MAX_BYTES = prev;
    }
  });
});
