/**
 * Journal ingest conversion — native ids → handles, url/title denormalization,
 * navEpoch bumps, and the poll-derived (AppleScript) path. Pure logic against
 * a real JournalStore (temp dir) + a StateStore primed with a snapshot.
 */

import { rmSync } from "node:fs";
import type { ExtEvent } from "@george43g/shared-types";
import {
  makeBrowserState,
  makeContractTab,
  makeContractWindow,
  makeSnapshot,
  makeTmpDir,
} from "@george43g/test-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JournalStore } from "./journal.js";
import { buildSeedRecords, ingestExtEvent, ingestStoreEvent } from "./journal-ingest.js";
import type { DaemonEvent } from "./state.js";
import { StateStore } from "./state.js";

let dir: string;
let journal: JournalStore;
let store: StateStore;

beforeEach(() => {
  dir = makeTmpDir("browser-tab-ingest-");
  journal = new JournalStore({ dir, ring: 100 });
  store = new StateStore();
  store.update(
    makeSnapshot({
      browsers: [
        makeBrowserState({
          windows: [
            makeContractWindow({
              windowId: "w:chrome:x812",
              tabs: [
                makeContractTab({ tabId: "t:chrome:x4001", url: "https://tab/", title: "The Tab" }),
              ],
            }),
          ],
        }),
      ],
    }),
  );
});

afterEach(() => {
  journal.stop();
  rmSync(dir, { recursive: true, force: true });
});

function event(over: Partial<ExtEvent>): ExtEvent {
  return { type: "event", ts: 5000, kind: "focus", ...over };
}

describe("ingestExtEvent", () => {
  it("converts a tab-focus frame to x-handles + denormalized url/title", () => {
    ingestExtEvent(journal, store, "chrome", event({ kind: "focus", windowId: 812, tabId: 4001 }));
    const rec = journal.recent(10)[0];
    expect(rec?.kind).toBe("tab-focus");
    expect(rec?.windowId).toBe("w:chrome:x812");
    expect(rec?.tabId).toBe("t:chrome:x4001");
    expect(rec?.url).toBe("https://tab/");
    expect(rec?.title).toBe("The Tab");
    expect(rec?.source).toBe("ext");
  });

  it("converts a window-only focus frame", () => {
    ingestExtEvent(journal, store, "chrome", event({ kind: "focus", windowId: 812 }));
    const rec = journal.recent(10)[0];
    expect(rec?.kind).toBe("window-focus");
    expect(rec?.tabId).toBeUndefined();
  });

  it("converts a nav frame + bumps navEpoch", () => {
    ingestExtEvent(
      journal,
      store,
      "chrome",
      event({ kind: "nav", tabId: 4001, url: "https://gone/", transition: "typed" }),
    );
    const rec = journal.journey("t:chrome:x4001", 10)[0];
    expect(rec?.url).toBe("https://gone/");
    expect(rec?.transition).toBe("typed");
    expect(rec?.navEpoch).toBe(1);
    expect(journal.navEpoch("t:chrome:x4001")).toBe(1);
  });
});

describe("ingestStoreEvent (AppleScript path)", () => {
  const ev = (over: Partial<DaemonEvent>): DaemonEvent => ({
    event: "window-focused",
    ts: 6000,
    ...over,
  });

  it("records a window focus", () => {
    ingestStoreEvent(
      journal,
      store,
      ev({ event: "window-focused", browser: "chrome", windowId: "w:chrome:5" }),
    );
    expect(journal.recent(10)[0]?.source).toBe("applescript");
    expect(journal.recent(10)[0]?.kind).toBe("window-focus");
  });

  it("records a tab activation with denormalized url/title", () => {
    ingestStoreEvent(
      journal,
      store,
      ev({
        event: "tab-activated",
        browser: "chrome",
        windowId: "w:chrome:x812",
        tabId: "t:chrome:x4001",
      }),
    );
    const rec = journal.recent(10)[0];
    expect(rec?.kind).toBe("tab-focus");
    expect(rec?.url).toBe("https://tab/");
  });

  it("records a nav on a url change", () => {
    ingestStoreEvent(
      journal,
      store,
      ev({
        event: "tab-updated",
        browser: "chrome",
        tabId: "t:chrome:9",
        data: { url: "https://new/", title: "New" },
      }),
    );
    const rec = journal.journey("t:chrome:9", 10)[0];
    expect(rec?.url).toBe("https://new/");
    expect(rec?.navEpoch).toBe(1);
  });

  it("ignores events without a browser", () => {
    ingestStoreEvent(journal, store, ev({ event: "window-focused", windowId: "w:chrome:5" }));
    expect(journal.recent(10)).toHaveLength(0);
  });
});

describe("buildSeedRecords", () => {
  it("builds seed focus records from lastAccessed tabs", () => {
    const state = makeBrowserState({
      windows: [
        makeContractWindow({
          windowId: "w:chrome:x1",
          tabs: [
            makeContractTab({ tabId: "t:chrome:x1", lastAccessed: 111 }),
            makeContractTab({ tabId: "t:chrome:x2" }), // no lastAccessed → skipped
          ],
        }),
      ],
    });
    const seeds = buildSeedRecords(state);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({
      tabId: "t:chrome:x1",
      ts: 111,
      source: "seed",
      kind: "tab-focus",
    });
  });
});

describe("ingestExtEvent — stateCapture (blur capture)", () => {
  const captured = {
    dirtyForms: 2,
    focusedEditable: true,
    media: [],
    scrollY: 0,
    scrollPct: 0,
    selectionLength: 0,
    wordCount: 42,
  };

  it("backfills the tab's most recent focus record with the captured state", () => {
    // First a focus establishes the record; then the blur capture enriches it.
    ingestExtEvent(journal, store, "chrome", event({ kind: "focus", windowId: 812, tabId: 4001 }));
    ingestExtEvent(
      journal,
      store,
      "chrome",
      event({ kind: "stateCapture", ts: 6000, tabId: 4001, state: captured }),
    );
    const rec = journal.recent(10).find((r) => r.tabId === "t:chrome:x4001");
    expect(rec?.capture).toEqual(captured);
  });

  it("is a no-op when there is no prior focus record for the tab", () => {
    ingestExtEvent(
      journal,
      store,
      "chrome",
      event({ kind: "stateCapture", ts: 6000, tabId: 9999, state: captured }),
    );
    expect(journal.recent(10)).toHaveLength(0);
  });
});
