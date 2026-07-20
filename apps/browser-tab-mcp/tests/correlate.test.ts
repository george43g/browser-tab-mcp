/**
 * Pure-fixture tests for the cgWindowId bounds-matching core.
 */

import type { CgWindowInfo, Snapshot } from "@george43g/shared-types";
import { describe, expect, it } from "vitest";
import { correlateSnapshot } from "../src/detect/correlate.js";

function snapshotWith(
  windows: { windowId: string; bounds: { x: number; y: number; w: number; h: number } | null }[],
  pid: number | null = 878,
): Snapshot {
  return {
    version: 1,
    generatedAt: 0,
    source: "osascript-direct",
    browsers: [
      {
        browser: "chrome",
        bundleId: "com.google.Chrome",
        pid,
        running: true,
        extensionConnected: false,
        dataSource: "applescript",
        windows: windows.map((w) => ({
          windowId: w.windowId,
          cgWindowId: null,
          title: "t",
          bounds: w.bounds,
          focused: false,
          incognito: false,
          activeTabIndex: 0,
          tabCount: 0,
          tabs: [],
        })),
      },
    ],
  };
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
});
