/**
 * Pure-fixture tests for the cgWindowId bounds-matching core.
 */

import type { CgWindowInfo, Snapshot } from "@george43g/shared-types";
import { makeBrowserState, makeContractWindow, makeSnapshot } from "@george43g/test-kit";
import { describe, expect, it } from "vitest";
import { correlateSnapshot, hasAmbiguousBoundsMatch } from "../src/detect/correlate.js";

function snapshotWith(
  windows: {
    windowId: string;
    bounds: { x: number; y: number; w: number; h: number } | null;
    title?: string;
  }[],
  pid: number | null = 878,
): Snapshot {
  return makeSnapshot({
    source: "osascript-direct",
    browsers: [
      makeBrowserState({
        pid,
        windows: windows.map((w) =>
          makeContractWindow({
            windowId: w.windowId,
            title: w.title ?? "t",
            bounds: w.bounds,
            focused: false,
            activeTabIndex: 0,
            tabCount: 0,
            tabs: [],
          }),
        ),
      }),
    ],
  });
}

function cg(
  windowId: number,
  ownerPid: number,
  x: number,
  y: number,
  w: number,
  h: number,
  layer = 0,
): CgWindowInfo {
  return { windowId, ownerPid, x, y, w, h, layer };
}

describe("correlateSnapshot", () => {
  it("matches exact bounds by pid", () => {
    const snap = snapshotWith([
      { windowId: "w:chrome:1", bounds: { x: 40, y: 50, w: 1996, h: 1269 } },
    ]);
    const out = correlateSnapshot(snap, [cg(236, 878, 40, 50, 1996, 1269)]);
    expect(out.browsers[0]?.windows[0]?.cgWindowId).toBe(236);
  });

  it("matches within the ±2px tolerance", () => {
    const snap = snapshotWith([
      { windowId: "w:chrome:1", bounds: { x: 40, y: 50, w: 1996, h: 1269 } },
    ]);
    const out = correlateSnapshot(snap, [cg(236, 878, 41, 49, 1997, 1268)]);
    expect(out.browsers[0]?.windows[0]?.cgWindowId).toBe(236);
  });

  it("ignores CG windows owned by other pids", () => {
    const snap = snapshotWith([
      { windowId: "w:chrome:1", bounds: { x: 40, y: 50, w: 1996, h: 1269 } },
    ]);
    const out = correlateSnapshot(snap, [cg(999, 1234, 40, 50, 1996, 1269)]);
    expect(out.browsers[0]?.windows[0]?.cgWindowId).toBeNull();
  });

  it("ignores non-zero-layer CG windows (overlays, panels)", () => {
    const snap = snapshotWith([
      { windowId: "w:chrome:1", bounds: { x: 40, y: 50, w: 1996, h: 1269 } },
    ]);
    const out = correlateSnapshot(snap, [cg(500, 878, 40, 50, 1996, 1269, 25)]);
    expect(out.browsers[0]?.windows[0]?.cgWindowId).toBeNull();
  });

  it("yields null on ambiguity (two same-bounds CG windows)", () => {
    const snap = snapshotWith([
      { windowId: "w:chrome:1", bounds: { x: 40, y: 50, w: 1996, h: 1269 } },
    ]);
    const out = correlateSnapshot(snap, [
      cg(236, 878, 40, 50, 1996, 1269),
      cg(237, 878, 40, 50, 1996, 1269),
    ]);
    expect(out.browsers[0]?.windows[0]?.cgWindowId).toBeNull();
  });

  it("yields null when the browser window has no bounds", () => {
    const snap = snapshotWith([{ windowId: "w:chrome:1", bounds: null }]);
    const out = correlateSnapshot(snap, [cg(236, 878, 40, 50, 1996, 1269)]);
    expect(out.browsers[0]?.windows[0]?.cgWindowId).toBeNull();
  });

  it("yields null when the browser has no pid", () => {
    const snap = snapshotWith(
      [{ windowId: "w:chrome:1", bounds: { x: 0, y: 0, w: 10, h: 10 } }],
      null,
    );
    const out = correlateSnapshot(snap, [cg(236, 878, 0, 0, 10, 10)]);
    expect(out.browsers[0]?.windows[0]?.cgWindowId).toBeNull();
  });

  it("correlates multiple windows independently", () => {
    const snap = snapshotWith([
      { windowId: "w:chrome:1", bounds: { x: 0, y: 0, w: 100, h: 100 } },
      { windowId: "w:chrome:2", bounds: { x: 500, y: 0, w: 200, h: 200 } },
      { windowId: "w:chrome:3", bounds: { x: 900, y: 900, w: 50, h: 50 } },
    ]);
    const out = correlateSnapshot(snap, [
      cg(11, 878, 0, 0, 100, 100),
      cg(22, 878, 500, 0, 200, 200),
    ]);
    const ids = out.browsers[0]?.windows.map((w) => w.cgWindowId);
    expect(ids).toEqual([11, 22, null]);
  });

  it("does not stamp focusedBrowser without z-order (yabai tier)", () => {
    const snap = snapshotWith([{ windowId: "w:chrome:1", bounds: { x: 0, y: 0, w: 10, h: 10 } }]);
    const out = correlateSnapshot(snap, [cg(236, 878, 0, 0, 10, 10)]);
    expect(out.focusedBrowser).toBeUndefined();
  });

  it("stamps focusedBrowser from the first layer-0 browser window when z-ordered", () => {
    const snap = snapshotWith([{ windowId: "w:chrome:1", bounds: { x: 0, y: 0, w: 10, h: 10 } }]);
    // Front-to-back: a non-browser window first, then the browser's window.
    const out = correlateSnapshot(
      snap,
      [cg(900, 4321, 0, 0, 800, 600), cg(236, 878, 0, 0, 10, 10)],
      true,
    );
    expect(out.focusedBrowser).toBe("chrome");
  });
});

/**
 * Under yabai every same-space window of an app carries the identical frame,
 * so bounds alone leave every window ambiguous. Fixtures use the real observed
 * shape: three Chrome windows at 40,50 1996x1269.
 */
describe("correlateSnapshot title tiebreaker (tiled windows)", () => {
  const TILED = { x: 40, y: 50, w: 1996, h: 1269 };
  const tiledSnapshot = () =>
    snapshotWith([
      { windowId: "w:chrome:x1", bounds: TILED, title: "Extensions" },
      { windowId: "w:chrome:x2", bounds: TILED, title: "Credits | OpenRouter" },
      { windowId: "w:chrome:x3", bounds: TILED, title: "Harness engineering | OpenAI" },
    ]);
  const tiledCg = [
    cg(542247, 878, 40, 50, 1996, 1269),
    cg(349035, 878, 40, 50, 1996, 1269),
    cg(382150, 878, 40, 50, 1996, 1269),
  ];
  const ids = (snap: Snapshot) => snap.browsers[0]?.windows.map((w) => w.cgWindowId);

  it("resolves identical-bounds windows by their yabai titles", () => {
    // yabai appends " - Google Chrome - <profile>" to the tab title.
    const titles = new Map([
      [349035, "Extensions - Google Chrome - George (Main G)"],
      [542247, "Credits | OpenRouter - Google Chrome - George (Main G)"],
      [382150, "Harness engineering | OpenAI - Google Chrome - George (Main G)"],
    ]);
    expect(ids(correlateSnapshot(tiledSnapshot(), tiledCg, false, titles))).toEqual([
      349035, 542247, 382150,
    ]);
  });

  it("stays null when no title map is available (no yabai)", () => {
    expect(ids(correlateSnapshot(tiledSnapshot(), tiledCg))).toEqual([null, null, null]);
  });

  it("stays null for windows whose titles tie", () => {
    const titles = new Map([
      [349035, "Extensions - Google Chrome - George (Main G)"],
      [542247, "Extensions - Google Chrome - George (Main G)"],
      [382150, "Harness engineering | OpenAI - Google Chrome - George (Main G)"],
    ]);
    const out = ids(correlateSnapshot(tiledSnapshot(), tiledCg, false, titles));
    // "Extensions" matches two candidates; the other two still resolve.
    expect(out).toEqual([null, null, 382150]);
  });

  it("stays null when the snapshot window has no title to match on", () => {
    // Exactly one candidate is named, so an empty title would sail through the
    // "manager title starts with ours" tier and win on no evidence at all.
    const snap = snapshotWith([
      { windowId: "w:chrome:x1", bounds: TILED, title: "" },
      { windowId: "w:chrome:x2", bounds: TILED, title: "Credits | OpenRouter" },
    ]);
    const titles = new Map([[349035, "Extensions - Google Chrome"]]);
    const out = correlateSnapshot(snap, tiledCg.slice(0, 2), false, titles);
    expect(ids(out)).toEqual([null, null]);
  });

  it("ignores candidates the window manager did not name", () => {
    // An unnamed candidate's empty title is a substring of everything, so it
    // would become the unique "match" for a window it has nothing to do with.
    const snap = snapshotWith([
      { windowId: "w:chrome:x1", bounds: TILED, title: "Credits | OpenRouter" },
    ]);
    const titles = new Map([[349035, "Extensions - Google Chrome"]]);
    const out = correlateSnapshot(snap, tiledCg.slice(0, 2), false, titles);
    expect(ids(out)).toEqual([null]);
  });

  it("matches a title the window manager PREFIXES (the Safari profile shape)", () => {
    const snap = snapshotWith([
      { windowId: "w:safari:x1", bounds: TILED, title: "browser-tab connector — settings" },
      { windowId: "w:safari:x2", bounds: TILED, title: "Hacker News" },
    ]);
    const titles = new Map([
      [349035, "Work — Hacker News"],
      [542247, "Personal — browser-tab connector — settings"],
    ]);
    const out = correlateSnapshot(snap, tiledCg.slice(0, 2), false, titles);
    expect(ids(out)).toEqual([542247, 349035]);
  });

  it("ignores case and whitespace differences between the two titles", () => {
    const snap = snapshotWith([
      { windowId: "w:chrome:x1", bounds: TILED, title: "  Credits  |  OpenRouter " },
      { windowId: "w:chrome:x2", bounds: TILED, title: "Extensions" },
    ]);
    const titles = new Map([
      [349035, "EXTENSIONS - Google Chrome"],
      [542247, "credits | openrouter - Google Chrome"],
    ]);
    const out = correlateSnapshot(snap, tiledCg.slice(0, 2), false, titles);
    expect(ids(out)).toEqual([542247, 349035]);
  });

  it("prefers a boundary match over a bare substring match", () => {
    // "Inbox" is a suffix of one title and buried mid-string in the other.
    const snap = snapshotWith([{ windowId: "w:chrome:x1", bounds: TILED, title: "Inbox" }]);
    const titles = new Map([
      [349035, "Notes about Inbox zero - Google Chrome"],
      [542247, "Inbox - Google Chrome"],
    ]);
    const out = correlateSnapshot(snap, tiledCg.slice(0, 2), false, titles);
    expect(ids(out)).toEqual([542247]);
  });

  it("drops an id two windows both claim rather than assigning it twice", () => {
    // One CG window, two same-bounds snapshot windows: the bounds path alone
    // would hand the same id to both.
    const snap = snapshotWith([
      { windowId: "w:chrome:x1", bounds: TILED, title: "Extensions" },
      { windowId: "w:chrome:x2", bounds: TILED, title: "Extensions" },
    ]);
    expect(ids(correlateSnapshot(snap, [cg(349035, 878, 40, 50, 1996, 1269)]))).toEqual([
      null,
      null,
    ]);
  });

  it("leaves an already-unique bounds match alone when titles disagree", () => {
    // Fast path must not regress: distinct bounds resolve without consulting
    // titles, even a stale title map that would have matched nothing.
    const snap = snapshotWith([
      { windowId: "w:chrome:x1", bounds: { x: 0, y: 0, w: 100, h: 100 }, title: "Extensions" },
    ]);
    const titles = new Map([[11, "something else entirely"]]);
    const out = correlateSnapshot(snap, [cg(11, 878, 0, 0, 100, 100)], false, titles);
    expect(ids(out)).toEqual([11]);
  });
});

describe("hasAmbiguousBoundsMatch", () => {
  it("is true when two CG windows share a browser window's bounds", () => {
    const snap = snapshotWith([
      { windowId: "w:chrome:x1", bounds: { x: 40, y: 50, w: 1996, h: 1269 } },
    ]);
    expect(
      hasAmbiguousBoundsMatch(snap, [
        cg(1, 878, 40, 50, 1996, 1269),
        cg(2, 878, 40, 50, 1996, 1269),
      ]),
    ).toBe(true);
  });

  it("is false when every window matches at most one CG window", () => {
    const snap = snapshotWith([
      { windowId: "w:chrome:x1", bounds: { x: 0, y: 0, w: 100, h: 100 } },
      { windowId: "w:chrome:x2", bounds: { x: 500, y: 0, w: 200, h: 200 } },
    ]);
    expect(
      hasAmbiguousBoundsMatch(snap, [cg(1, 878, 0, 0, 100, 100), cg(2, 878, 500, 0, 200, 200)]),
    ).toBe(false);
  });

  it("is false when the duplicate-bounds CG windows belong to another pid", () => {
    const snap = snapshotWith([
      { windowId: "w:chrome:x1", bounds: { x: 40, y: 50, w: 1996, h: 1269 } },
    ]);
    expect(
      hasAmbiguousBoundsMatch(snap, [
        cg(1, 878, 40, 50, 1996, 1269),
        cg(2, 4321, 40, 50, 1996, 1269),
      ]),
    ).toBe(false);
  });
});
