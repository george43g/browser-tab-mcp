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
      { url: "https://x/", active: true, windowId: 2 },
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
