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

  // raiseWindow defaults TRUE — the flag exists to make the raise opt-OUTable,
  // not to change what focus_tab has always done.
  it("focus_tab raises by default and reports the window post-state", async () => {
    fc.setWindows([{ id: 7, focused: false, incognito: false, state: "minimized" }]);
    const out = await executeCommand("focus_tab", { tabId: 5 });
    expect(fc.calls["windows.update"]?.[0]).toEqual([7, { focused: true }]);
    // wasMinimized is a BEFORE-state; no later read can recover it.
    expect(out.wasMinimized).toBe(true);
    expect(out.windowFocused).toBe(true);
  });

  it("focus_tab with raiseWindow:false activates the tab and touches the window not at all", async () => {
    fc.setWindows([{ id: 7, focused: false, incognito: false, state: "minimized" }]);
    const out = await executeCommand("focus_tab", { tabId: 5, raiseWindow: false });
    expect(fc.calls["tabs.update"]?.[0]).toEqual([5, { active: true }]);
    expect(fc.calls["windows.update"]).toBeUndefined();
    expect(out.wasMinimized).toBe(true);
    // Still minimized, still unfocused — the caller opted out of changing that.
    expect(out.windowState).toBe("minimized");
    expect(out.windowFocused).toBe(false);
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

  it("move_tab reports the tab's ACTUAL final index, not tabs.move's echo", async () => {
    // The fake's tabs.move echoes the REQUESTED index — including -1 for
    // "append", which is exactly the misleading value real Chrome has
    // returned (indices 80-85 in a 41-tab window, dogfood 2026-08-20). The
    // final tabs.get read is what makes the result honest.
    fc = installFakeChrome({
      windows: [{ id: 42, tabs: [{ id: 3, windowId: 42, index: 5 }] }],
    });
    const out = await executeCommand("move_tab", {
      tabId: 3,
      targetWindowId: 42,
      targetIndex: -1,
    });
    expect(out.index).toBe(5); // from tabs.get, not the echoed -1
    expect(out.windowId).toBe(42);
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
  // Group commands validate per-id against real tabs, so these tests seed
  // them. Tabs 1/2 live in window 40, tab 3 in window 50 — and window 50 is
  // listed FIRST so any implementation that grouped into "the current
  // window" instead of the tabs' own window would be caught by the
  // windowId assertion below.
  const seedTwoWindows = () => {
    fc = installFakeChrome({
      windows: [
        { id: 50, focused: true, tabs: [{ id: 3, windowId: 50, index: 0 }] },
        {
          id: 40,
          focused: false,
          tabs: [
            { id: 1, windowId: 40, index: 0 },
            { id: 2, windowId: 40, index: 1 },
          ],
        },
      ],
    });
  };

  it("create groups tabIds IN THEIR OWN WINDOW and applies title/color", async () => {
    seedTwoWindows();
    const out = await executeCommand("group_tabs", {
      action: "create",
      tabIds: [1, 2],
      title: "Work",
      color: "blue",
    });
    expect(out).toEqual({ groupId: 700, payload: { action: "create" } });
    // THE dogfood bug: without createProperties.windowId Chrome creates the
    // group in the FOCUSED window (50 here) and moves the tabs into it — a
    // grouping op silently became a mass cross-window move of ~40 tabs.
    expect(fc.calls["tabs.group"]?.[0]).toEqual([
      { tabIds: [1, 2], createProperties: { windowId: 40 } },
    ]);
    expect(fc.calls["tabGroups.update"]?.[0]).toEqual([700, { title: "Work", color: "blue" }]);
  });

  it("create skips stale ids, still groups the live ones, and says so", async () => {
    seedTwoWindows();
    const out = await executeCommand("group_tabs", {
      action: "create",
      tabIds: [1, 999, 2],
    });
    expect(out.payload).toEqual({ action: "create", skippedTabIds: [999] });
    expect(fc.calls["tabs.group"]?.[0]).toEqual([
      { tabIds: [1, 2], createProperties: { windowId: 40 } },
    ]);
  });

  it("create with ONLY stale ids errors instead of succeeding at nothing", async () => {
    seedTwoWindows();
    await expect(
      executeCommand("group_tabs", { action: "create", tabIds: [888, 999] }),
    ).rejects.toThrow(/none of the 2 tabs exist/);
    expect(fc.calls["tabs.group"]).toBeUndefined();
  });

  it("add joins an existing group; remove ungroups", async () => {
    seedTwoWindows();
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

  // Regression, found live THREE times, each fix wrong in an instructive way.
  //   1. `bounds` silently discarded `state` outright.
  //   2. state-then-bounds with a windows.get poll — still came back minimized.
  //   3. bounds-then-state — ALSO still came back minimized.
  //
  // The actual behaviour: a geometry update on a minimised window is applied
  // asynchronously and re-asserts `minimized` when it completes, so it clobbers
  // a nearby state change in EITHER order. Ordering alone cannot fix it.
  // `windows.get().state` is accurate (verified against AppleScript on a real
  // window), so the fix verifies and re-applies instead of guessing a delay.
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

  it("set_window RESTORES a minimized window before touching geometry", async () => {
    // The poison: geometry sent to a minimized window is applied async and
    // re-asserts the old state — the window pops up, then drops back a second
    // later. Restoring first and letting it finish avoids it entirely.
    fc.restore();
    fc = installFakeChrome({ initialWindowState: "minimized" });
    await executeCommand("set_window", {
      windowId: 3,
      state: "normal",
      bounds: { x: 10, y: 20, w: 30, h: 40 },
    });
    expect(fc.calls["windows.update"]).toEqual([
      [3, { state: "normal" }], // restore FIRST
      [3, { left: 10, top: 20, width: 30, height: 40 }], // then place
      [3, { state: "normal" }], // then the caller's target state
    ]);
  });

  it("set_window skips the restore when the window is already normal", async () => {
    fc.restore();
    fc = installFakeChrome({ initialWindowState: "normal" });
    await executeCommand("set_window", {
      windowId: 3,
      bounds: { x: 10, y: 20, w: 30, h: 40 },
    });
    // One probe, no restore, no delay — the common path stays cheap.
    expect(fc.calls["windows.get"]).toHaveLength(1);
    expect(fc.calls["windows.update"]).toEqual([[3, { left: 10, top: 20, width: 30, height: 40 }]]);
  });

  it("set_window restores before geometry even when the TARGET is minimized", async () => {
    // Still must not send geometry to a minimized window; the caller's
    // minimize lands last.
    fc.restore();
    fc = installFakeChrome({ initialWindowState: "minimized" });
    await executeCommand("set_window", {
      windowId: 3,
      state: "minimized",
      bounds: { x: 10, y: 20, w: 30, h: 40 },
    });
    expect(fc.calls["windows.update"]).toEqual([
      [3, { state: "normal" }],
      [3, { left: 10, top: 20, width: 30, height: 40 }],
      [3, { state: "minimized" }],
    ]);
  });

  it("set_window survives a state clobber: the restore absorbs it and the target state still lands", async () => {
    // `stateClobbers` models the measured Chrome failure: a state update is
    // accepted and then silently reverted by an in-flight geometry op. The
    // sequence tests above pin HOW the fix works; this pins THAT it works —
    // the end state must be the caller's target even when one state update is
    // eaten. The pre-#27 implementation (bounds then state, no restore) spends
    // its only state update on the clobber and ends minimized.
    fc.restore();
    fc = installFakeChrome({ initialWindowState: "minimized", stateClobbers: 1 });
    await executeCommand("set_window", {
      windowId: 3,
      state: "normal",
      bounds: { x: 10, y: 20, w: 30, h: 40 },
    });
    const windows = (fc.chrome as typeof chrome).windows;
    const win = (await windows.get(3)) as { state?: string };
    expect(win.state).toBe("normal");
  });

  it("set_window never probes when there is no geometry to protect", async () => {
    fc.restore();
    fc = installFakeChrome({ initialWindowState: "minimized" });
    await executeCommand("set_window", { windowId: 3, state: "normal" });
    expect(fc.calls["windows.get"]).toBeUndefined();
    expect(fc.calls["windows.update"]).toEqual([[3, { state: "normal" }]]);
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

/**
 * The ack-before-reload ordering is the entire correctness of this command.
 *
 * `runtime.reload()` tears the background context down immediately, so calling
 * it inline would kill the extension before the result frame reaches the
 * daemon — every SUCCESSFUL reload would be reported as a command timeout.
 * These tests pin the ordering, not the reload itself.
 */
describe("reload_extension", () => {
  it("returns BEFORE reloading, so the ack can reach the daemon", async () => {
    const outcome = await executeCommand("reload_extension", {});
    // Resolved, and the reload has NOT fired yet.
    expect(fc.calls["runtime.reload"]).toBeUndefined();
    expect((outcome.payload as { scheduled?: boolean }).scheduled).toBe(true);
  });

  it("does reload, on a later turn of the event loop", async () => {
    await executeCommand("reload_extension", {});
    await new Promise((r) => setTimeout(r, 300));
    expect(fc.calls["runtime.reload"]?.length).toBe(1);
  });
});
