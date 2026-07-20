/**
 * Snapshot contract: `extSnapshotToBrowserState` must emit a shape that
 * validates against the `BrowserState` schema, with window/tab handles that
 * match the extension-generation id grammar (w:<b>:x<id> / t:<b>:x<id>). This
 * pins the daemon's mapping of the extension wire onto the contract.
 */

import { BrowserStateSchema } from "@george43g/shared-types";
import { makeExtSnapshot, makeExtTab, makeExtWindow } from "@george43g/test-kit";
import { describe, expect, it } from "vitest";
import { extSnapshotToBrowserState } from "../src/daemon/ws-server.js";
import { parseTabId, parseWindowId } from "../src/detect/ids.js";

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
