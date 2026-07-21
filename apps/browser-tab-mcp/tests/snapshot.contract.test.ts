/**
 * Snapshot contract: `extSnapshotToBrowserState` must emit a shape that
 * validates against the `BrowserState` schema, with window/tab handles that
 * match the extension-generation id grammar (w:<b>:x<id> / t:<b>:x<id>). This
 * pins the daemon's mapping of the extension wire onto the contract.
 */

import { BrowserStateSchema, TAB_ENRICHMENT_FIELDS } from "@george43g/shared-types";
import { makeExtSnapshot, makeExtTab, makeExtTabGroup, makeExtWindow } from "@george43g/test-kit";
import { describe, expect, it } from "vitest";
import { extSnapshotToBrowserState } from "../src/daemon/ws-server.js";
import { parseGroupId, parseTabId, parseWindowId } from "../src/detect/ids.js";

const snap = makeExtSnapshot({
  windows: [
    makeExtWindow({
      id: 812,
      tabs: [
        makeExtTab({ id: 4001, active: true }),
        makeExtTab({ id: 4002, index: 1, active: false }),
      ],
    }),
  ],
});
const state = extSnapshotToBrowserState("chrome", snap);

describe("extSnapshotToBrowserState", () => {
  it("validates against the BrowserState schema", () => {
    const parsed = BrowserStateSchema.safeParse(state);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("emits extension-generation x-handles that parse", () => {
    const win = state.windows[0];
    expect(win?.windowId).toBe("w:chrome:x812");
    const pw = parseWindowId(win?.windowId ?? "");
    expect(pw?.ext).toBe(true);
    expect(pw?.browser).toBe("chrome");

    const tab = win?.tabs[0];
    expect(tab?.tabId).toBe("t:chrome:x4001");
    const pt = parseTabId(tab?.tabId ?? "");
    expect(pt?.ext).toBe(true);
    expect(pt?.nativeId).toBe("4001");
  });

  it("marks the feed extension-sourced with pid left for the poll to backfill", () => {
    expect(state.dataSource).toBe("extension");
    expect(state.extensionConnected).toBe(true);
    expect(state.pid).toBeNull();
  });
});

describe("extSnapshotToBrowserState — v2 enrichments", () => {
  const fullSnap = makeExtSnapshot({
    groups: [makeExtTabGroup({ id: 77, windowId: 812 })],
    windows: [
      makeExtWindow({
        id: 812,
        state: "maximized",
        tabs: [
          makeExtTab({
            id: 4001,
            active: true,
            groupId: 77,
            pinned: true,
            audible: true,
            discarded: true,
            muted: true,
            mutedReason: "user",
            frozen: true,
            lastAccessed: 987654,
            status: "complete",
          }),
        ],
      }),
    ],
  });
  const caps = { tabGroups: true, history: false };
  const full = extSnapshotToBrowserState("chrome", fullSnap, caps);

  it("validates against BrowserState with every field populated", () => {
    const parsed = BrowserStateSchema.safeParse(full);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("surfaces every enrichment field onto the contract tab (parity)", () => {
    const tab = full.windows[0]?.tabs[0];
    expect(tab).toBeDefined();
    for (const field of TAB_ENRICHMENT_FIELDS) {
      expect(tab, `extSnapshotToBrowserState dropped enrichment "${field}"`).toHaveProperty(field);
    }
    expect(tab?.muted).toBe(true);
    expect(tab?.mutedReason).toBe("user");
    expect(tab?.frozen).toBe(true);
    expect(tab?.lastAccessed).toBe(987654);
    expect(tab?.status).toBe("complete");
  });

  it("maps group membership + tab groups to g-handles", () => {
    const win = full.windows[0];
    expect(win?.state).toBe("maximized");
    expect(win?.activeTabId).toBe("t:chrome:x4001");
    expect(win?.tabs[0]?.groupId).toBe("g:chrome:x77");
    const grp = full.tabGroups[0];
    expect(grp?.groupId).toBe("g:chrome:x77");
    expect(parseGroupId(grp?.groupId ?? "")?.nativeId).toBe("77");
    expect(grp?.windowId).toBe("w:chrome:x812");
  });

  it("carries the capability map through unchanged", () => {
    expect(full.capabilities).toEqual(caps);
  });
});
