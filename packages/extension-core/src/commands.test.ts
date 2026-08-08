/**
 * Command executor unit tests — every kind mapped onto the chrome.* API via a
 * fake, asserting both the returned outcome and the calls made. Covers the
 * branches P1a's move_tab path doesn't reach (focus/close/open + errors).
 */

import { type FakeChrome, installFakeChrome } from "@george43g/test-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeCommand } from "./commands.js";

let fc: FakeChrome;
beforeEach(() => {
  fc = installFakeChrome();
});
afterEach(() => fc.restore());

describe("executeCommand", () => {
  it("focus_tab activates the tab and focuses its window", async () => {
    const out = await executeCommand("focus_tab", { tabId: 5 });
    expect(out.tabId).toBe(5);
    expect(out.windowId).toBe(7); // fake tabs.update reports windowId 7
    expect(fc.calls["tabs.update"]?.[0]).toEqual([5, { active: true }]);
    expect(fc.calls["windows.update"]?.[0]).toEqual([7, { focused: true }]);
  });

  it("close_tab removes the tab", async () => {
    expect(await executeCommand("close_tab", { tabId: 9 })).toEqual({ tabId: 9 });
    expect(fc.calls["tabs.remove"]?.[0]).toEqual([9]);
  });

  it("move_tab into a new window", async () => {
    expect(await executeCommand("move_tab", { tabId: 3, newWindow: true })).toEqual({
      tabId: 3,
      windowId: 900,
      index: 0,
    });
    expect(fc.calls["windows.create"]?.[0]).toEqual([{ tabId: 3 }]);
  });

  it("move_tab to a target window + index", async () => {
    expect(
      await executeCommand("move_tab", { tabId: 3, targetWindowId: 42, targetIndex: 1 }),
    ).toEqual({ tabId: 3, windowId: 42, index: 1 });
    expect(fc.calls["tabs.move"]?.[0]).toEqual([3, { windowId: 42, index: 1 }]);
  });

  it("move_tab without target or newWindow throws", async () => {
    await expect(executeCommand("move_tab", { tabId: 3 })).rejects.toThrow(
      /targetWindowId or newWindow/,
    );
  });

  it("open_tab creates a tab and focuses its window", async () => {
    const out = await executeCommand("open_tab", { url: "https://x/", windowId: 2 });
    expect(out.tabId).toBe(9999);
    expect(out.windowId).toBe(2);
    expect(fc.calls["tabs.create"]?.[0]).toEqual([
      { url: "https://x/", active: true, pinned: false, windowId: 2 },
    ]);
  });

  it("open_tab without url throws", async () => {
    await expect(executeCommand("open_tab", {})).rejects.toThrow(/missing url/);
  });

  it("focus_tab without tabId throws", async () => {
    await expect(executeCommand("focus_tab", {})).rejects.toThrow(/missing tabId/);
  });

  it("unknown kind throws", async () => {
    await expect(executeCommand("bogus", {})).rejects.toThrow(/unknown command/);
  });
});

describe("tab_action", () => {
  it("mute/unmute/pin/unpin map onto tabs.update", async () => {
    for (const [action, expected] of [
      ["mute", { muted: true }],
      ["unmute", { muted: false }],
      ["pin", { pinned: true }],
      ["unpin", { pinned: false }],
    ] as const) {
      const out = await executeCommand("tab_action", { tabId: 5, action });
      expect(out).toEqual({ tabId: 5, payload: { action } });
      expect(fc.calls["tabs.update"]?.at(-1)).toEqual([5, expected]);
    }
  });

  it("reload/back/forward call their tabs.* verbs", async () => {
    await executeCommand("tab_action", { tabId: 5, action: "reload" });
    expect(fc.calls["tabs.reload"]?.[0]).toEqual([5, undefined]);
    await executeCommand("tab_action", { tabId: 5, action: "back" });
    expect(fc.calls["tabs.goBack"]?.[0]).toEqual([5]);
    await executeCommand("tab_action", { tabId: 5, action: "forward" });
    expect(fc.calls["tabs.goForward"]?.[0]).toEqual([5]);
  });

  it("navigate sets the url; missing url throws", async () => {
    await executeCommand("tab_action", { tabId: 5, action: "navigate", url: "https://x/" });
    expect(fc.calls["tabs.update"]?.at(-1)).toEqual([5, { url: "https://x/" }]);
    await expect(executeCommand("tab_action", { tabId: 5, action: "navigate" })).rejects.toThrow(
      /requires url/,
    );
  });

  it("discard and duplicate return the resulting tab", async () => {
    expect(await executeCommand("tab_action", { tabId: 5, action: "discard" })).toEqual({
      tabId: 5,
      payload: { action: "discard" },
    });
    const dup = await executeCommand("tab_action", { tabId: 5, action: "duplicate" });
    expect(dup.tabId).toBe(6); // fake duplicate returns tabId+1
    expect(dup.payload).toEqual({ action: "duplicate" });
  });

  it("unknown action throws", async () => {
    await expect(executeCommand("tab_action", { tabId: 5, action: "nope" })).rejects.toThrow(
      /unknown tab action/,
    );
  });
});

describe("group_tabs", () => {
  it("create groups tabIds and applies title/color", async () => {
    const out = await executeCommand("group_tabs", {
      action: "create",
      tabIds: [1, 2],
      title: "Work",
      color: "blue",
    });
    expect(out).toEqual({ groupId: 700, payload: { action: "create" } });
    expect(fc.calls["tabs.group"]?.[0]).toEqual([{ tabIds: [1, 2] }]);
    expect(fc.calls["tabGroups.update"]?.[0]).toEqual([700, { title: "Work", color: "blue" }]);
  });

  it("add joins an existing group; remove ungroups", async () => {
    expect(await executeCommand("group_tabs", { action: "add", groupId: 77, tabIds: [3] })).toEqual(
      {
        groupId: 77,
        payload: { action: "add" },
      },
    );
    expect(fc.calls["tabs.group"]?.at(-1)).toEqual([{ tabIds: [3], groupId: 77 }]);
    await executeCommand("group_tabs", { action: "remove", tabIds: [3] });
    expect(fc.calls["tabs.ungroup"]?.[0]).toEqual([[3]]);
  });

  it("update requires at least one property; move calls tabGroups.move", async () => {
    await expect(executeCommand("group_tabs", { action: "update", groupId: 77 })).rejects.toThrow(
      /title\/color\/collapsed/,
    );
    await executeCommand("group_tabs", {
      action: "move",
      groupId: 77,
      targetWindowId: 9,
      index: 0,
    });
    expect(fc.calls["tabGroups.move"]?.[0]).toEqual([77, { index: 0, windowId: 9 }]);
  });
});

describe("window commands", () => {
  it("open_window creates a window with url list + reports tabCount", async () => {
    const out = await executeCommand("open_window", { urls: ["https://a/", "https://b/"] });
    expect(out.windowId).toBe(900); // fake windows.create id
    expect(out.payload).toEqual({ tabCount: 2 });
    const created = fc.calls["windows.create"]?.[0]?.[0] as { url: string[] } | undefined;
    expect(created?.url).toEqual(["https://a/", "https://b/"]);
  });

  it("open_window with bounds creates with geometry, then defers the state", async () => {
    // chrome.windows.create forbids maximized/minimized/fullscreen alongside
    // left/top/width/height — so the state must follow as its own update
    // rather than being silently dropped.
    await executeCommand("open_window", {
      urls: ["https://a/"],
      bounds: { x: 5, y: 6, w: 700, h: 500 },
      state: "maximized",
    });
    const data = fc.calls["windows.create"]?.[0]?.[0] as Record<string, unknown>;
    expect(data).toMatchObject({ left: 5, top: 6, width: 700, height: 500 });
    expect(data.state).toBeUndefined();
    expect(fc.calls["windows.update"]?.[0]).toEqual([900, { state: "maximized" }]);
  });

  it("open_window with bounds + state normal needs no follow-up update", async () => {
    await executeCommand("open_window", {
      urls: ["https://a/"],
      bounds: { x: 5, y: 6, w: 700, h: 500 },
      state: "normal",
    });
    expect(fc.calls["windows.update"]).toBeUndefined();
  });

  it("set_window applies bounds; close_window removes it", async () => {
    await executeCommand("set_window", { windowId: 3, bounds: { x: 1, y: 2, w: 3, h: 4 } });
    expect(fc.calls["windows.update"]?.[0]).toEqual([3, { left: 1, top: 2, width: 3, height: 4 }]);
    expect(await executeCommand("close_window", { windowId: 3 })).toEqual({
      windowId: 3,
      payload: {},
    });
    expect(fc.calls["windows.remove"]?.[0]).toEqual([3]);
  });

  // Regression, found live twice. First `bounds` silently discarded `state`.
  // Then a state-first ordering LOOKED right but still came back minimized: the
  // geometry update landed mid-restore and cancelled it, because
  // chrome.windows.update resolves on ACCEPT, not on completion. Polling
  // windows.get cannot fix that — Chrome reports the requested state
  // optimistically, so the poll returned instantly and changed nothing.
  //
  // Hence the invariant these two tests pin: geometry FIRST, state LAST, so
  // nothing is ever issued after a state change that could cancel it.
  it("set_window puts bounds BEFORE state so the state cannot be cancelled", async () => {
    await executeCommand("set_window", {
      windowId: 3,
      state: "normal",
      bounds: { x: 10, y: 20, w: 30, h: 40 },
    });
    expect(fc.calls["windows.update"]).toEqual([
      [3, { left: 10, top: 20, width: 30, height: 40 }],
      [3, { state: "normal" }],
    ]);
  });

  it("set_window orders bounds before EVERY state, not just normal", async () => {
    await executeCommand("set_window", {
      windowId: 3,
      state: "minimized",
      bounds: { x: 10, y: 20, w: 30, h: 40 },
    });
    expect(fc.calls["windows.update"]).toEqual([
      [3, { left: 10, top: 20, width: 30, height: 40 }],
      [3, { state: "minimized" }],
    ]);
  });

  it("set_window never pairs focused with a minimized state", async () => {
    await executeCommand("set_window", { windowId: 3, state: "minimized", focused: true });
    expect(fc.calls["windows.update"]).toEqual([[3, { state: "minimized" }]]);
  });

  it("set_window with only focused still updates", async () => {
    await executeCommand("set_window", { windowId: 3, focused: true });
    expect(fc.calls["windows.update"]).toEqual([[3, { focused: true }]]);
  });

  it("set_window with nothing to change throws", async () => {
    await expect(executeCommand("set_window", { windowId: 3 })).rejects.toThrow(/at least one/);
  });
});

describe("open_tab / move_tab group extensions", () => {
  it("open_tab honors pinned/index and groups the new tab", async () => {
    const out = await executeCommand("open_tab", {
      url: "https://x/",
      windowId: 2,
      index: 1,
      pinned: true,
      groupId: 77,
    });
    expect(out.groupId).toBe(77);
    expect(fc.calls["tabs.create"]?.[0]).toEqual([
      { url: "https://x/", active: true, pinned: true, windowId: 2, index: 1 },
    ]);
    expect(fc.calls["tabs.group"]?.at(-1)).toEqual([{ tabIds: [9999], groupId: 77 }]);
  });

  it("move_tab re-groups after moving when targetGroupId is set", async () => {
    const out = await executeCommand("move_tab", {
      tabId: 3,
      targetWindowId: 42,
      targetGroupId: 88,
    });
    expect(out.groupId).toBe(88);
    expect(fc.calls["tabs.group"]?.at(-1)).toEqual([{ tabIds: [3], groupId: 88 }]);
  });
});

describe("safari profile lacks tab groups", () => {
  it("group_tabs create throws (chrome.tabs.group is undefined)", async () => {
    const safari = installFakeChrome({ profile: "safari", namespace: "chrome" });
    try {
      await expect(
        executeCommand("group_tabs", { action: "create", tabIds: [1] }),
      ).rejects.toThrow();
    } finally {
      safari.restore();
    }
  });
});
