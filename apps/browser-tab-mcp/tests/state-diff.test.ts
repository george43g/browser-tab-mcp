/**
 * diffSnapshots — the daemon's event emitter. Pins exactly which changes
 * surface as events, and (the trap) which do NOT: `lastAccessed` and the
 * boolean enrichments (audible/muted/pinned/…) deliberately don't emit, or
 * every focus/audio blip would spam `tab-updated`. The diff compares only
 * url/title (tab-updated), index (tab-moved), active (tab-activated), and
 * window focus.
 *
 * Sabotage guard: make `lastAccessed` (or an enrichment) part of the diff
 * equality → the "emits nothing" cases redden.
 */

import {
  makeBrowserState,
  makeContractTab,
  makeContractWindow,
  makeSnapshot,
} from "@george43g/test-kit";
import { describe, expect, it } from "vitest";
import { type DaemonEvent, diffSnapshots } from "../src/daemon/state.js";

const kinds = (events: DaemonEvent[]): string[] => events.map((e) => e.event);

/** One chrome window with a single tab, parameterized by tab/window overrides. */
const snap = (tab: Parameters<typeof makeContractTab>[0] = {}, win = {}) =>
  makeSnapshot({
    browsers: [
      makeBrowserState({ windows: [makeContractWindow({ tabs: [makeContractTab(tab)], ...win })] }),
    ],
  });

/** Two-tab window helper for create/remove cases. */
const twoTabs = () =>
  makeSnapshot({
    browsers: [
      makeBrowserState({
        windows: [
          makeContractWindow({
            tabs: [
              makeContractTab(),
              makeContractTab({ tabId: "t:chrome:102", index: 1, active: false }),
            ],
          }),
        ],
      }),
    ],
  });

describe("diffSnapshots — emits nothing", () => {
  it("for identical snapshots", () => {
    expect(diffSnapshots(snap(), snap())).toEqual([]);
  });

  it("when only lastAccessed changes (the focus-spam trap)", () => {
    expect(diffSnapshots(snap({ lastAccessed: 1000 }), snap({ lastAccessed: 9999 }))).toEqual([]);
  });

  it("when only boolean enrichments change (audible/muted/pinned)", () => {
    const prev = snap({ audible: false, muted: false, pinned: false });
    const next = snap({ audible: true, muted: true, pinned: true });
    expect(diffSnapshots(prev, next)).toEqual([]);
  });

  it("when a tab deactivates (active true→false is not a tab-activated)", () => {
    expect(diffSnapshots(snap({ active: true }), snap({ active: false }))).toEqual([]);
  });
});

describe("diffSnapshots — tab events", () => {
  it("url change → tab-updated with url+title", () => {
    const events = diffSnapshots(
      snap({ url: "https://a.test/" }),
      snap({ url: "https://b.test/" }),
    );
    expect(kinds(events)).toEqual(["tab-updated"]);
    expect(events[0]?.data).toEqual({ url: "https://b.test/", title: "Example" });
  });

  it("title change → tab-updated", () => {
    expect(kinds(diffSnapshots(snap({ title: "Old" }), snap({ title: "New" })))).toEqual([
      "tab-updated",
    ]);
  });

  it("index change → tab-moved with from/to", () => {
    const events = diffSnapshots(snap({ index: 0 }), snap({ index: 3 }));
    expect(kinds(events)).toEqual(["tab-moved"]);
    expect(events[0]?.data).toEqual({ from: 0, to: 3 });
  });

  it("activation (active false→true) → tab-activated", () => {
    expect(kinds(diffSnapshots(snap({ active: false }), snap({ active: true })))).toEqual([
      "tab-activated",
    ]);
  });

  it("a new tab → tab-created (carrying the tab id)", () => {
    const events = diffSnapshots(snap(), twoTabs());
    expect(kinds(events)).toEqual(["tab-created"]);
    expect(events[0]?.tabId).toBe("t:chrome:102");
  });

  it("a removed tab → tab-removed", () => {
    const events = diffSnapshots(twoTabs(), snap());
    expect(kinds(events)).toEqual(["tab-removed"]);
    expect(events[0]?.tabId).toBe("t:chrome:102");
  });
});

describe("diffSnapshots — window events", () => {
  it("a new window → window-created (not per-tab-created)", () => {
    const prev = makeSnapshot({ browsers: [makeBrowserState({ windows: [] })] });
    expect(kinds(diffSnapshots(prev, snap()))).toEqual(["window-created"]);
  });

  it("a removed window → window-removed", () => {
    const next = makeSnapshot({ browsers: [makeBrowserState({ windows: [] })] });
    expect(kinds(diffSnapshots(snap(), next))).toEqual(["window-removed"]);
  });

  it("window focus (false→true) → window-focused", () => {
    expect(kinds(diffSnapshots(snap({}, { focused: false }), snap({}, { focused: true })))).toEqual(
      ["window-focused"],
    );
  });
});
