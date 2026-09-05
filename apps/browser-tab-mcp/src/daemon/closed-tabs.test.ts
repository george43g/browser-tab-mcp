/**
 * detectClosures — the three ways a snapshot diff lies about a closure.
 *
 * Each guard here corresponds to a real mechanism in this codebase, not a
 * hypothetical: cross-window moves keep the tab id (the existing tab-removed
 * DaemonEvent is per-window and would be wrong), an authority switch reissues
 * every handle (merge.ts flips a browser between extension and AppleScript
 * sourcing), and a browser quitting empties its window list wholesale.
 */
import {
  makeBrowserState,
  makeContractTab,
  makeContractWindow,
  makeSnapshot,
} from "@george43g/test-kit";
import { describe, expect, it } from "vitest";
import { ClosedTabStore, detectClosures } from "./closed-tabs.js";

const chrome = (windows: ReturnType<typeof makeContractWindow>[], over = {}) =>
  makeBrowserState({
    browser: "chrome",
    extensionConnected: true,
    dataSource: "extension",
    windows,
    ...over,
  });

const win = (windowId: string, tabs: ReturnType<typeof makeContractTab>[]) =>
  makeContractWindow({ windowId, focused: true, tabs });

const tab = (tabId: string, index: number, over = {}) =>
  makeContractTab({ tabId, index, url: `https://x/${tabId}`, title: tabId, ...over });

describe("detectClosures", () => {
  it("records a tab that left the snapshot, with the state a reopen needs", () => {
    const prev = makeSnapshot({
      browsers: [chrome([win("w:chrome:x1", [tab("a", 0, { pinned: true }), tab("b", 1)])])],
    });
    const next = makeSnapshot({ browsers: [chrome([win("w:chrome:x1", [tab("a", 0)])])] });
    const out = detectClosures(prev, next, 1000);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      tabId: "b",
      browser: "chrome",
      url: "https://x/b",
      title: "b",
      index: 1,
      windowId: "w:chrome:x1",
      windowGone: false,
      closedAt: 1000,
    });
    expect(out[0]?.closedTabId, "each record is addressable for reopen").toMatch(/^[0-9a-f]{8}$/);
  });

  it("does NOT record a cross-window move — the tab is still in the snapshot", () => {
    // The failure this prevents: `tab-removed` is emitted per WINDOW, so a
    // drag from w1 to w2 looks exactly like a close if you only ask whether
    // the tab left its old window.
    const prev = makeSnapshot({
      browsers: [chrome([win("w:chrome:x1", [tab("a", 0)]), win("w:chrome:x2", [])])],
    });
    const next = makeSnapshot({
      browsers: [chrome([win("w:chrome:x1", []), win("w:chrome:x2", [tab("a", 0)])])],
    });
    expect(detectClosures(prev, next)).toEqual([]);
  });

  it("does NOT record anything when the browser's authority flipped", () => {
    // extension → AppleScript reissues every handle (x-ids become plain ids),
    // so every tab looks closed and a whole new set looks created.
    const prev = makeSnapshot({
      browsers: [chrome([win("w:chrome:x1", [tab("a", 0), tab("b", 1)])])],
    });
    const next = makeSnapshot({
      browsers: [
        makeBrowserState({
          browser: "chrome",
          extensionConnected: false,
          dataSource: "applescript",
          windows: [win("w:chrome:1", [tab("1", 0), tab("2", 1)])],
        }),
      ],
    });
    expect(detectClosures(prev, next)).toEqual([]);
  });

  it("does NOT record a session's worth of tabs when the browser quits", () => {
    const prev = makeSnapshot({
      browsers: [chrome([win("w:chrome:x1", [tab("a", 0), tab("b", 1), tab("c", 2)])])],
    });
    const stopped = makeSnapshot({
      browsers: [
        makeBrowserState({
          browser: "chrome",
          extensionConnected: true,
          dataSource: "extension",
          windows: [],
          running: false,
        }),
      ],
    });
    expect(detectClosures(prev, stopped)).toEqual([]);
    // …and the same when the browser leaves the snapshot entirely.
    expect(detectClosures(prev, makeSnapshot({ browsers: [] }))).toEqual([]);
  });

  it("marks windowGone when the window went with the tab, and carries group identity", () => {
    const grouped = chrome([win("w:chrome:x1", [tab("a", 0, { groupId: "g:chrome:x7" })])], {
      tabGroups: [
        {
          groupId: "g:chrome:x7",
          windowId: "w:chrome:x1",
          title: "Reading",
          color: "cyan",
          collapsed: false,
          tabCount: 1,
        },
      ],
    });
    const prev = makeSnapshot({ browsers: [grouped] });
    const next = makeSnapshot({ browsers: [chrome([])] });
    const out = detectClosures(prev, next);
    expect(out).toHaveLength(1);
    // The group's title and colour die with its last member; a reopen that
    // wanted to restore the group could not read them from anywhere else.
    expect(out[0]).toMatchObject({
      windowGone: true,
      groupId: "g:chrome:x7",
      groupTitle: "Reading",
      groupColor: "cyan",
    });
  });
});

describe("ClosedTabStore", () => {
  const rec = (id: string, closedAt: number) => ({
    closedTabId: id,
    tabId: `t:${id}`,
    browser: "chrome" as const,
    url: "https://x/",
    title: id,
    index: 0,
    windowId: "w:chrome:x1",
    windowGone: false,
    pinned: false,
    muted: false,
    closedAt,
  });

  it("evicts by age — 'for a while' is a policy, not forever", () => {
    let now = 10_000;
    const store = new ClosedTabStore({ dir: "/nonexistent", ttlMs: 5_000, now: () => now });
    store.record([rec("old", 1_000), rec("new", 9_000)]);
    expect(store.list().map((r) => r.closedTabId)).toEqual(["new"]);
    now = 20_000;
    expect(store.list(), "everything ages out eventually").toEqual([]);
  });

  it("caps the ring and returns newest first", () => {
    // `now` is pinned: closedAt values of 1/2/3 are 1970, so a real clock
    // would age every record out and the ring cap would look broken.
    const store = new ClosedTabStore({
      dir: "/nonexistent",
      ringSize: 2,
      ttlMs: 1e9,
      now: () => 10,
    });
    store.record([rec("a", 1), rec("b", 2), rec("c", 3)]);
    expect(store.list().map((r) => r.closedTabId)).toEqual(["c", "b"]);
  });

  it("survives an unwritable directory rather than taking the daemon down", () => {
    const store = new ClosedTabStore({ dir: "/nonexistent/nope", ttlMs: 1e9, now: () => 10 });
    expect(() => store.record([rec("a", 1)])).not.toThrow();
    expect(store.get("a")?.tabId).toBe("t:a");
  });
});
