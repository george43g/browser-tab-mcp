/**
 * The `summary` projection exists because a real 103-tab session made even
 * the `core` projection exceed an MCP client's token budget (~52KB) — the
 * fix is structural (no tab rows), so the test asserts structure.
 */

import type { Snapshot } from "@george43g/shared-types";
import { SnapshotSchema } from "@george43g/shared-types";
import { describe, expect, it, vi } from "vitest";

// Reach the projection through the tool's own handler contract rather than
// exporting internals: the fake snapshot goes through the real code path.
import * as service from "../client/tabs-service.js";
import { listTabsTool } from "./list-tabs.js";

function fakeSnapshot(): Snapshot {
  const tab = (id: string, groupId?: string) => ({
    tabId: id,
    index: 0,
    url: "https://example.com/",
    title: "t",
    active: false,
    pinned: false,
    audible: false,
    discarded: false,
    muted: false,
    frozen: false,
    ...(groupId ? { groupId } : {}),
  });
  return SnapshotSchema.parse({
    version: 2,
    generatedAt: 1755700000000,
    source: "daemon",
    browsers: [
      {
        browser: "chrome",
        bundleId: "com.google.Chrome",
        pid: 1,
        running: true,
        extensionConnected: true,
        dataSource: "extension",
        tabGroups: [
          { groupId: "g:chrome:x7", windowId: "w:chrome:x1", title: "Work", color: "blue" },
        ],
        windows: [
          {
            windowId: "w:chrome:x1",
            cgWindowId: 42,
            title: "win",
            bounds: null,
            focused: true,
            incognito: false,
            activeTabIndex: 0,
            activeTabId: "t:chrome:x1",
            tabCount: 3,
            tabs: [
              tab("t:chrome:x1", "g:chrome:x7"),
              tab("t:chrome:x2", "g:chrome:x7"),
              tab("t:chrome:x3"),
            ],
          },
        ],
      },
    ],
  });
}

describe("list_tabs fields:'summary'", () => {
  it("returns the shape with ZERO tab rows, keeping counts and the active tab", async () => {
    vi.spyOn(service, "getSnapshot").mockResolvedValue(fakeSnapshot());
    const out = (await listTabsTool.handler({ fields: "summary" }, undefined)) as Snapshot;
    const win = out.browsers[0]?.windows[0];
    expect(win?.tabs).toEqual([]); // the projection's whole point
    expect(win?.tabCount).toBe(3); // the count survives the dropped rows
    expect(win?.activeTabId).toBe("t:chrome:x1");
    // groups carry a tabCount computed from exactly the rows being elided
    expect(out.browsers[0]?.tabGroups[0]?.tabCount).toBe(2);
    // and the result still parses as a Snapshot — no second wire shape
    expect(() => SnapshotSchema.parse(out)).not.toThrow();
    vi.restoreAllMocks();
  });

  it("core remains the default and keeps tab rows", async () => {
    vi.spyOn(service, "getSnapshot").mockResolvedValue(fakeSnapshot());
    const out = (await listTabsTool.handler({ fields: "core" }, undefined)) as Snapshot;
    expect(out.browsers[0]?.windows[0]?.tabs).toHaveLength(3);
    vi.restoreAllMocks();
  });
});
