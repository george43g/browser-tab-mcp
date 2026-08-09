/**
 * focus_tab contract — the AppleScript half.
 *
 * The bug these guard: the extension pathway un-minimizes as a side effect of
 * `windows.update({focused:true})`, while the AppleScript pathway only
 * reordered windows — so one call produced a focused tab in a raised window on
 * Chrome-with-extension and a focused tab in a STILL-MINIMIZED window on
 * Chrome-without. The scripts are asserted here rather than only end-to-end
 * because osascript can't run in CI and the ordering is the whole fix.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const runOsa = vi.fn<(script: string, opts?: unknown) => Promise<string>>();

vi.mock("../osascript.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../osascript.js")>()),
  runOsa: (script: string, opts?: unknown) => runOsa(script, opts),
}));

const { CHROMIUM_SPECS, makeChromiumAdapter } = await import("./chromium.js");
const { makeSafariAdapter } = await import("./safari.js");

const RS = "\x1e";
const chrome = makeChromiumAdapter(CHROMIUM_SPECS[0] as (typeof CHROMIUM_SPECS)[number]);
const safari = makeSafariAdapter();

/** The single script the adapter handed osascript. */
const script = (): string => String(runOsa.mock.calls[0]?.[0] ?? "");

beforeEach(() => {
  runOsa.mockReset();
});

describe("chromium focusTab — raiseWindow default (true)", () => {
  beforeEach(() => {
    // ok · window id · 1-based tab index · wasMinimized · isMinimized · window index
    runOsa.mockResolvedValue(["ok", "812", "2", "true", "false", "1"].join(RS));
  });

  it("clears `minimized` BEFORE raising the window", async () => {
    await chrome.focusTab("t:chrome:9931");
    const s = script();
    const unminimize = s.indexOf("set minimized of w to false");
    const raise = s.indexOf("set index of w to 1");
    expect(unminimize).toBeGreaterThanOrEqual(0);
    expect(raise).toBeGreaterThanOrEqual(0);
    // Raising a still-minimized window is a no-op, so this order is the fix.
    expect(unminimize).toBeLessThan(raise);
    expect(s).toContain("activate");
  });

  it("reports the window's before/after state on the result", async () => {
    const out = await chrome.focusTab("t:chrome:9931");
    expect(out).toMatchObject({
      ok: true,
      command: "focus_tab",
      browser: "chrome",
      windowId: "w:chrome:812",
      index: 1,
      wasMinimized: true,
      windowState: "normal",
      windowFocused: true,
    });
  });

  it("omitting opts entirely still raises", async () => {
    await chrome.focusTab("t:chrome:9931", undefined);
    expect(script()).toContain("set minimized of w to false");
  });
});

describe("chromium focusTab — raiseWindow:false", () => {
  it("activates the tab and issues no raise, un-minimize or activate", async () => {
    runOsa.mockResolvedValue(["ok", "812", "2", "true", "true", "3"].join(RS));
    const out = await chrome.focusTab("t:chrome:9931", { raiseWindow: false });
    const s = script();
    expect(s).toContain("set active tab index of w to i");
    expect(s).not.toContain("set minimized of w to false");
    expect(s).not.toContain("set index of w to 1");
    expect(s).not.toContain("activate");
    expect(out.windowState).toBe("minimized");
    expect(out.windowFocused).toBe(false);
  });
});

describe("safari focusTab", () => {
  it("clears `miniaturized` BEFORE raising, and reports post-state", async () => {
    runOsa.mockResolvedValue(["ok", "true", "false", "1"].join(RS));
    const out = await safari.focusTab("t:safari:w1:i3");
    const s = script();
    const unminimize = s.indexOf("set miniaturized of target to false");
    const raise = s.indexOf("set index of target to 1");
    expect(unminimize).toBeGreaterThanOrEqual(0);
    expect(unminimize).toBeLessThan(raise);
    expect(out).toMatchObject({ wasMinimized: true, windowState: "normal", windowFocused: true });
  });

  it("raiseWindow:false leaves the window alone", async () => {
    runOsa.mockResolvedValue(["ok", "false", "false", "2"].join(RS));
    const out = await safari.focusTab("t:safari:w1:i3", { raiseWindow: false });
    const s = script();
    expect(s).toContain("set current tab of target to tab 3 of target");
    expect(s).not.toContain("set miniaturized of target to false");
    expect(s).not.toContain("activate");
    expect(out.windowFocused).toBe(false);
  });
});

describe("focusTab — a pathway that cannot observe stays silent", () => {
  it("omits the window fields rather than guessing when the script reports nothing", async () => {
    // An older/partial script shape: no trailing state fields at all.
    runOsa.mockResolvedValue(["ok", "812", "2"].join(RS));
    const out = await chrome.focusTab("t:chrome:9931");
    expect(out.wasMinimized).toBeUndefined();
    expect(out.windowState).toBeUndefined();
    expect(out.windowFocused).toBeUndefined();
  });
});
