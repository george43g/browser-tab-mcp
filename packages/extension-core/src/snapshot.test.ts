/**
 * Pure mapper tests — fixture chrome API shapes, no browser needed.
 */

import { describe, expect, it } from "vitest";
import { debounce } from "./events.js";
import { mapTab, mapWindow, mapWindows } from "./snapshot.js";

const tab = (over: Partial<Parameters<typeof mapTab>[0]> = {}) => ({
  id: 42,
  windowId: 7,
  index: 0,
  url: "https://example.com/",
  title: "Example",
  active: true,
  pinned: false,
  audible: false,
  discarded: false,
  ...over,
});

const win = (over: Partial<Parameters<typeof mapWindow>[0]> = {}) => ({
  id: 7,
  focused: true,
  incognito: false,
  left: 0,
  top: 25,
  width: 1440,
  height: 875,
  type: "normal",
  tabs: [tab()],
  ...over,
});

describe("mapTab", () => {
  it("maps a full tab", () => {
    expect(mapTab(tab())).toEqual({
      id: 42,
      windowId: 7,
      index: 0,
      url: "https://example.com/",
      title: "Example",
      active: true,
      pinned: false,
      audible: false,
      discarded: false,
    });
  });

  it("falls back to pendingUrl and empty strings", () => {
    const t = mapTab(
      tab({ url: undefined, pendingUrl: "https://pending.test/", title: undefined }),
    );
    expect(t?.url).toBe("https://pending.test/");
    expect(t?.title).toBe("");
  });

  it("drops idless tabs (devtools)", () => {
    expect(mapTab(tab({ id: undefined }))).toBeNull();
  });
});

describe("mapWindow", () => {
  it("maps bounds from left/top/width/height", () => {
    expect(mapWindow(win())?.bounds).toEqual({ x: 0, y: 25, w: 1440, h: 875 });
  });

  it("nulls bounds when geometry is missing", () => {
    expect(mapWindow(win({ left: undefined }))?.bounds).toBeNull();
  });

  it("drops non-normal windows (popups, devtools)", () => {
    expect(mapWindow(win({ type: "popup" }))).toBeNull();
  });

  it("drops idless windows", () => {
    expect(mapWindow(win({ id: undefined }))).toBeNull();
  });
});

describe("mapWindows", () => {
  it("produces the ExtSnapshot wire shape", () => {
    const snap = mapWindows([win(), win({ id: 8, type: "popup" })]);
    expect(snap.type).toBe("snapshot");
    expect(snap.windows).toHaveLength(1);
    expect(snap.windows[0]?.tabs).toHaveLength(1);
  });
});

describe("debounce", () => {
  it("coalesces rapid calls", async () => {
    let calls = 0;
    const fn = debounce(() => {
      calls++;
    }, 10);
    fn();
    fn();
    fn();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(1);
  });
});
