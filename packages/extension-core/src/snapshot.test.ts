/**
 * Pure mapper tests — fixture chrome API shapes, no browser needed.
 */

import { TAB_ENRICHMENT_FIELDS } from "@george43g/shared-types";
import {
  makeChromeTabGroup as group,
  makeChromeTab as tab,
  makeChromeWindow as win,
} from "@george43g/test-kit";
import { describe, expect, it } from "vitest";
import { debounce } from "./events.js";
import { mapTab, mapWindow, mapWindows } from "./snapshot.js";

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
      muted: false,
      frozen: false,
    });
  });

  it("surfaces every enrichment field from a fully-populated tab (parity)", () => {
    const t = mapTab(
      tab({
        pinned: true,
        audible: true,
        discarded: true,
        mutedInfo: { muted: true, reason: "user" },
        frozen: true,
        lastAccessed: 123456,
        status: "complete",
        groupId: 5,
      }),
    );
    expect(t).not.toBeNull();
    if (!t) return;
    // If a new enrichment field is added to the schema but mapTab forgets to
    // read it, this loop goes red.
    for (const field of TAB_ENRICHMENT_FIELDS) {
      expect(t, `mapTab dropped enrichment field "${field}"`).toHaveProperty(field);
    }
    expect(t.muted).toBe(true);
    expect(t.mutedReason).toBe("user");
    expect(t.frozen).toBe(true);
    expect(t.lastAccessed).toBe(123456);
    expect(t.status).toBe("complete");
    expect(t.groupId).toBe(5);
  });

  it("omits groupId when ungrouped (chrome -1 sentinel)", () => {
    expect(mapTab(tab({ groupId: -1 }))?.groupId).toBeUndefined();
  });

  it("carries an http(s) favicon but drops an oversized inline data: URI at the source", () => {
    expect(mapTab(tab({ favIconUrl: "https://example.com/favicon.ico" }))?.favicon).toBe(
      "https://example.com/favicon.ico",
    );
    const big = `data:image/png;base64,${"A".repeat(9000)}`;
    expect(mapTab(tab({ favIconUrl: big }))?.favicon).toBeUndefined();
    // No favIconUrl at all → field simply absent.
    expect(mapTab(tab())).not.toHaveProperty("favicon");
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

  it("carries window state when present", () => {
    expect(mapWindow(win({ state: "minimized" }))?.state).toBe("minimized");
    expect(mapWindow(win())?.state).toBeUndefined();
  });
});

describe("mapWindows", () => {
  it("produces the ExtSnapshot wire shape", () => {
    const snap = mapWindows([win(), win({ id: 8, type: "popup" })]);
    expect(snap.type).toBe("snapshot");
    expect(snap.windows).toHaveLength(1);
    expect(snap.windows[0]?.tabs).toHaveLength(1);
    expect(snap.groups).toEqual([]);
  });

  it("carries tab groups", () => {
    const snap = mapWindows([win()], [group({ id: 3, windowId: 7 })]);
    expect(snap.groups).toEqual([
      { id: 3, windowId: 7, title: "Work", color: "blue", collapsed: false },
    ]);
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

describe("URL hygiene at the mapper", () => {
  it("strips basic-auth userinfo before a tab URL leaves the browser", () => {
    // Redaction MUST happen here, at the source: past this point the URL
    // rides the WS frame into daemon snapshots, journals, logs and agent
    // context. Two live router-admin tabs carried credentials in the
    // 2026-08-20 dogfood run.
    const mapped = mapWindow({
      id: 1,
      focused: true,
      tabs: [
        {
          id: 10,
          windowId: 1,
          index: 0,
          active: true,
          url: "http://admin:hunter2@192.168.1.225/net",
          title: "Router",
        },
      ],
    });
    expect(mapped?.tabs[0]?.url).toBe("http://192.168.1.225/net");
  });
});
