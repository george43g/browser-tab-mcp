import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Snapshot } from "@george43g/shared-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ScreenshotDeps, ShotRateLimiter, screenshot } from "./screenshot.js";
import { ShotStore } from "./shots.js";
import type { StateStore } from "./state.js";
import type { ExtensionServer } from "./ws-server.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bt-shot-unit-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.BROWSER_TAB_WINDOW_CAPTURE;
  delete process.env.BROWSER_TAB_SCREENCAPTURE_BIN;
  delete process.env.BROWSER_TAB_PLATFORM;
});

const DATA_URL = "data:image/jpeg;base64,/9j/AA==";

/** A one-window snapshot with a single tab; overrides tweak active/state. */
function makeStore(tab: { active?: boolean }, win: { state?: string; cgWindowId?: number } = {}) {
  const snapshot = {
    version: 2,
    browsers: [
      {
        browser: "chrome",
        windows: [
          {
            windowId: "w:chrome:x7",
            cgWindowId: win.cgWindowId ?? null,
            activeTabId: "t:chrome:x5",
            ...(win.state ? { state: win.state } : {}),
            tabs: [{ tabId: "t:chrome:x5", active: tab.active ?? true, url: "https://ex.com" }],
          },
        ],
      },
    ],
  } as unknown as Snapshot;
  return { getSnapshot: () => snapshot } as unknown as StateStore;
}

function makeExt(sendCommand = vi.fn().mockResolvedValue({ payload: { dataUrl: DATA_URL } })) {
  return {
    ext: { isConnected: () => true, sendCommand } as unknown as ExtensionServer,
    sendCommand,
  };
}

function deps(
  store: StateStore,
  ext: ExtensionServer,
  limiter = new ShotRateLimiter(),
): ScreenshotDeps {
  return { ext, store, journal: { navEpoch: () => 2 }, shots: new ShotStore(dir), limiter };
}

describe("screenshot — tier 'tab'", () => {
  it("captures the active tab and caches by navEpoch", async () => {
    const { ext, sendCommand } = makeExt();
    const out = await screenshot({ tabId: "t:chrome:x5" }, deps(makeStore({ active: true }), ext));
    expect(out.tier).toBe("tab");
    expect(out.cached).toBe(false);
    expect(out.navEpoch).toBe(2);
    expect(out.bytes).toBeGreaterThan(0);
    expect(sendCommand).toHaveBeenCalledWith(
      "chrome",
      "capture_tab",
      expect.objectContaining({ tabId: 5, windowId: 7 }),
    );
  });

  it("second call at the same navEpoch is a cache hit (no capture)", async () => {
    const { ext, sendCommand } = makeExt();
    const d = deps(makeStore({ active: true }), ext);
    await screenshot({ tabId: "t:chrome:x5" }, d);
    const out = await screenshot({ tabId: "t:chrome:x5" }, d);
    expect(out.cached).toBe(true);
    expect(sendCommand).toHaveBeenCalledTimes(1); // only the first captured
  });

  it("errors when the tab isn't its window's active tab (preflight)", async () => {
    const { ext } = makeExt();
    await expect(
      screenshot({ tabId: "t:chrome:x5" }, deps(makeStore({ active: false }), ext)),
    ).rejects.toThrow(/not its window's active tab/i);
  });

  it("focus:true captures a background tab (activates it first)", async () => {
    const { ext, sendCommand } = makeExt();
    const out = await screenshot(
      { tabId: "t:chrome:x5", focus: true },
      deps(makeStore({ active: false }), ext),
    );
    expect(out.cached).toBe(false);
    expect(sendCommand).toHaveBeenCalledWith(
      "chrome",
      "capture_tab",
      expect.objectContaining({ activate: true }),
    );
  });

  it("errors when the window is minimized", async () => {
    const { ext } = makeExt();
    await expect(
      screenshot(
        { tabId: "t:chrome:x5" },
        deps(makeStore({ active: true }, { state: "minimized" }), ext),
      ),
    ).rejects.toThrow(/minimized/i);
  });

  it("rate-limits per browser and fails fast with a retry hint", async () => {
    const { ext } = makeExt();
    const limiter = new ShotRateLimiter(2, 2, () => 0); // frozen clock, 2 tokens
    const d = deps(makeStore({ active: true }), ext);
    d.limiter = limiter;
    await screenshot({ tabId: "t:chrome:x5", force: true }, d);
    await screenshot({ tabId: "t:chrome:x5", force: true }, d);
    await expect(screenshot({ tabId: "t:chrome:x5", force: true }, d)).rejects.toThrow(
      /rate limit hit for chrome.*Retry in \d+ms/i,
    );
  });

  it("refills tokens as the clock advances — a rejected caller can retry after the hint", async () => {
    let now = 0;
    const limiter = new ShotRateLimiter(2, 2, () => now); // 2 rps, burst 2
    expect(limiter.check("chrome").ok).toBe(true);
    expect(limiter.check("chrome").ok).toBe(true);
    const denied = limiter.check("chrome");
    expect(denied.ok).toBe(false);
    expect(denied.retryMs).toBeGreaterThan(0);
    now += denied.retryMs; // wait exactly as long as the hint said
    expect(limiter.check("chrome").ok).toBe(true);
  });

  it("rejects an AppleScript-generation handle with a hint", async () => {
    const { ext } = makeExt();
    await expect(
      screenshot({ tabId: "t:chrome:123" }, deps(makeStore({ active: true }), ext)),
    ).rejects.toThrow(/extension/i);
  });
});

describe("screenshot — argument validation", () => {
  it("requires exactly one of tabId / windowId", async () => {
    const { ext } = makeExt();
    await expect(screenshot({}, deps(makeStore({}), ext))).rejects.toThrow(/exactly one/i);
    await expect(
      screenshot({ tabId: "t:chrome:x5", windowId: "w:chrome:x7" }, deps(makeStore({}), ext)),
    ).rejects.toThrow(/exactly one/i);
  });

  it("tier 'window' is off unless BROWSER_TAB_WINDOW_CAPTURE=1", async () => {
    delete process.env.BROWSER_TAB_WINDOW_CAPTURE;
    const { ext } = makeExt();
    await expect(
      screenshot({ windowId: "w:chrome:x7" }, deps(makeStore({}, { cgWindowId: 42 }), ext)),
    ).rejects.toThrow(/BROWSER_TAB_WINDOW_CAPTURE/);
  });
});

describe("screenshot — tier 'window'", () => {
  // Tier 2 is macOS-only twice over: `/usr/bin/screencapture`, and a CGWindowID
  // that only CoreGraphics issues. These tests shim the binary, so they can
  // exercise the LOGIC anywhere — but `windowCaptureEnabled()` now refuses off
  // macOS before the env opt-in is even read, which is correct in production
  // and would make this suite platform-dependent (it failed on the Linux CI leg
  // and passed on macOS — the exact split the matrix exists to expose).
  // Declaring the platform is what the override is for.
  beforeEach(() => {
    process.env.BROWSER_TAB_PLATFORM = "macos";
  });

  /** A fake `screencapture` that writes a 4-byte jpeg to its last-positional out path. */
  function shimScreencapture(): string {
    const bin = join(dir, "fake-screencapture.sh");
    writeFileSync(
      bin,
      "#!/bin/sh\nfor out; do :; done\nprintf '\\377\\330\\377\\331' > \"$out\"\n",
      {
        mode: 0o755,
      },
    );
    return bin;
  }

  it("captures a window via screencapture when enabled", async () => {
    process.env.BROWSER_TAB_WINDOW_CAPTURE = "1";
    process.env.BROWSER_TAB_SCREENCAPTURE_BIN = shimScreencapture();
    const { ext } = makeExt();
    const out = await screenshot(
      { windowId: "w:chrome:x7" },
      deps(makeStore({}, { cgWindowId: 42 }), ext),
    );
    expect(out.tier).toBe("window");
    expect(out.cached).toBe(false);
    expect(out.bytes).toBe(4);
  });

  it("errors when the window has no cgWindowId (correlation unavailable)", async () => {
    process.env.BROWSER_TAB_WINDOW_CAPTURE = "1";
    const { ext } = makeExt();
    // makeStore defaults cgWindowId to null when omitted (correlation unavailable).
    await expect(
      screenshot({ windowId: "w:chrome:x7" }, deps(makeStore({}, {}), ext)),
    ).rejects.toThrow(/cgWindowId/i);
  });
});
