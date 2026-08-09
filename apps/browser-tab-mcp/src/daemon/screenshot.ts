/**
 * Screenshot orchestration — the daemon half of the `screenshot` tool.
 *
 * Tier "tab" (a tabId): preflight the tab is its window's active tab (or
 * focus:true to activate it), rate-limit per browser (captureVisibleTab is
 * throttled ~2/s by Chrome), serve a navEpoch-keyed cache hit, else ask the
 * extension to captureVisibleTab and cache the jpeg.
 *
 * Tier "window" (a windowId): opt-in `screencapture -l <cgWindowId>` for any
 * visible window. No navigation epoch, so it always recaptures.
 *
 * Both tiers write the jpeg to the daemon shot cache and return its path +
 * size; the MCP tool reads the file back into an image content block.
 */

import { statSync } from "node:fs";
import { envNum } from "@george43g/robustness";
import type { BrowserId, BrowserWindow, ScreenshotOutput, Tab } from "@george43g/shared-types";
import { type ParsedTabId, type ParsedWindowId, parseTabId, parseWindowId } from "../detect/ids.js";
import type { ShotStore } from "./shots.js";
import type { StateStore } from "./state.js";
import { captureWindow, windowCaptureEnabled } from "./window-shot.js";
import type { ExtensionServer } from "./ws-server.js";

const RATE_RPS = 2;
const RATE_BURST = 2;

/**
 * Non-blocking token bucket. robustness's `TokenBucket` only offers the
 * BLOCKING `acquire()`, and the screenshot path must fail fast with a
 * "retry in Nms" hint instead of queuing — so the non-blocking variant lives
 * here until a `tryAcquire` ships upstream. With rps=0 the bucket never
 * refills, so once exhausted it reports `retryMs: 0` (caller decides).
 */
class ShotBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly rps: number,
    private readonly clock: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefill = clock();
  }

  tryAcquire(n = 1): { ok: boolean; retryMs: number } {
    if (n <= 0) return { ok: true, retryMs: 0 };
    const now = this.clock();
    if (this.rps > 0) {
      const elapsedSec = Math.max(0, (now - this.lastRefill) / 1000);
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.rps);
      this.lastRefill = now;
    }
    if (this.tokens >= n) {
      this.tokens -= n;
      return { ok: true, retryMs: 0 };
    }
    if (this.rps <= 0) return { ok: false, retryMs: 0 };
    const needed = n - this.tokens;
    return { ok: false, retryMs: Math.max(1, Math.ceil((needed / this.rps) * 1000)) };
  }
}

/** Per-browser token buckets — captureVisibleTab / screencapture fail fast. */
export class ShotRateLimiter {
  private readonly buckets = new Map<BrowserId, ShotBucket>();

  constructor(
    private readonly rps = RATE_RPS,
    private readonly burst = RATE_BURST,
    private readonly clock: () => number = Date.now,
  ) {}

  check(browser: BrowserId): { ok: boolean; retryMs: number } {
    let bucket = this.buckets.get(browser);
    if (!bucket) {
      bucket = new ShotBucket(this.burst, this.rps, this.clock);
      this.buckets.set(browser, bucket);
    }
    return bucket.tryAcquire(1);
  }
}

export interface ScreenshotDeps {
  ext: ExtensionServer | null;
  store: StateStore;
  journal: { navEpoch(tabId: string): number };
  shots: ShotStore;
  limiter: ShotRateLimiter;
}

function parseHandle(id: string | undefined): ParsedTabId | ParsedWindowId {
  if (!id) throw new Error("Missing tabId/windowId.");
  const parsed = parseTabId(id) ?? parseWindowId(id);
  if (!parsed) throw new Error(`Malformed handle "${id}" — use handles from list_tabs.`);
  return parsed;
}

function extNum(parsed: ParsedTabId | ParsedWindowId, what: string): number {
  if (!parsed.ext || !("nativeId" in parsed) || parsed.nativeId === undefined) {
    throw new Error(
      `${what} is an AppleScript-generation handle but screenshots run over the extension — ` +
        `re-run list_tabs and use the fresh x-handles.`,
    );
  }
  return Number.parseInt(parsed.nativeId, 10);
}

function notConnectedHint(handle: string, browser: BrowserId): string {
  return (
    `Handle "${handle}" belongs to the ${browser} extension session, which is not connected. ` +
    `Re-run list_tabs for current handles.`
  );
}

function findTab(store: StateStore, tabId: string): { tab: Tab; window: BrowserWindow } | null {
  for (const b of store.getSnapshot().browsers) {
    for (const w of b.windows) {
      for (const t of w.tabs) {
        if (t.tabId === tabId) return { tab: t, window: w };
      }
    }
  }
  return null;
}

function findWindow(store: StateStore, windowId: string): BrowserWindow | null {
  for (const b of store.getSnapshot().browsers) {
    for (const w of b.windows) {
      if (w.windowId === windowId) return w;
    }
  }
  return null;
}

function shotQuality(): number {
  const q = envNum("BROWSER_TAB_SHOT_QUALITY", 70);
  return Math.min(100, Math.max(0, q));
}

/** Decode a `data:image/jpeg;base64,…` URL into raw bytes. */
function decodeDataUrl(dataUrl: unknown): Buffer {
  if (typeof dataUrl !== "string" || !dataUrl) {
    throw new Error("Extension returned no image data for the capture.");
  }
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const buf = Buffer.from(b64, "base64");
  if (buf.length === 0) throw new Error("Capture produced an empty image.");
  return buf;
}

export async function screenshot(
  params: Record<string, unknown>,
  deps: ScreenshotDeps,
): Promise<ScreenshotOutput> {
  const tabId = params.tabId as string | undefined;
  const windowId = params.windowId as string | undefined;
  if ((tabId === undefined) === (windowId === undefined)) {
    throw new Error("Pass exactly one of tabId (tier 'tab') or windowId (tier 'window').");
  }
  return tabId !== undefined
    ? captureTab(tabId, params, deps)
    : windowShot(windowId as string, deps);
}

async function captureTab(
  tabId: string,
  params: Record<string, unknown>,
  deps: ScreenshotDeps,
): Promise<ScreenshotOutput> {
  const parsed = parseHandle(tabId);
  if (!parsed.ext) {
    throw new Error(
      `Screenshots need the browser extension — "${tabId}" is an AppleScript-generation handle. ` +
        `Connect the extension and re-run list_tabs for x-handles.`,
    );
  }
  const browser = parsed.browser;
  if (!deps.ext?.isConnected(browser)) throw new Error(notConnectedHint(tabId, browser));

  const found = findTab(deps.store, tabId);
  if (!found) throw new Error(`Tab "${tabId}" is not in the current snapshot — re-run list_tabs.`);
  const { tab, window } = found;
  const focus = (params.focus as boolean | undefined) ?? false;

  if (window.state === "minimized") {
    throw new Error(
      `Window "${window.windowId}" is minimized — captureVisibleTab can't see it. ` +
        `Restore it first (set_window state:"normal").`,
    );
  }
  if (!tab.active && !focus) {
    const activeHint = window.activeTabId ? ` (currently "${window.activeTabId}")` : "";
    throw new Error(
      `Tab "${tabId}" is not its window's active tab, and captureVisibleTab only sees the active tab. ` +
        `Re-call with focus:true (activates this tab — changes what the user sees), or screenshot the ` +
        `active tab${activeHint} instead.`,
    );
  }

  const navEpoch = deps.journal.navEpoch(tabId);
  if (!(params.force as boolean | undefined)) {
    const hit = deps.shots.getTab(tabId, navEpoch);
    if (hit) {
      return {
        tier: "tab",
        path: hit,
        bytes: statSync(hit).size,
        format: "jpeg",
        cached: true,
        navEpoch,
      };
    }
  }

  // Only a real capture consumes the rate limit (cache hits don't hit Chrome).
  const rl = deps.limiter.check(browser);
  if (!rl.ok) {
    throw new Error(
      `Screenshot rate limit hit for ${browser} (${RATE_RPS}/s). Retry in ${rl.retryMs}ms.`,
    );
  }

  const raw = await deps.ext.sendCommand(browser, "capture_tab", {
    tabId: extNum(parsed, "tabId"),
    windowId: extNum(parseHandle(window.windowId), "windowId"),
    activate: focus && !tab.active,
    quality: shotQuality(),
  });
  const buf = decodeDataUrl((raw as { payload?: { dataUrl?: string } }).payload?.dataUrl);
  const path = deps.shots.putTab(tabId, navEpoch, buf);
  return { tier: "tab", path, bytes: buf.length, format: "jpeg", cached: false, navEpoch };
}

async function windowShot(windowId: string, deps: ScreenshotDeps): Promise<ScreenshotOutput> {
  if (!windowCaptureEnabled()) {
    throw new Error(
      "Tier-2 window capture is disabled. Set BROWSER_TAB_WINDOW_CAPTURE=1 to enable it — it needs " +
        "Screen Recording permission (check with `browser-tab doctor`).",
    );
  }
  const parsed = parseHandle(windowId);
  const window = findWindow(deps.store, windowId);
  if (!window) {
    throw new Error(`Window "${windowId}" is not in the current snapshot — re-run list_tabs.`);
  }
  if (window.cgWindowId === null || window.cgWindowId === undefined) {
    throw new Error(
      `Window "${windowId}" has no cgWindowId — CG window correlation is unavailable, so screencapture ` +
        `can't target it. See \`browser-tab doctor\` (build the native module or install yabai).`,
    );
  }

  const rl = deps.limiter.check(parsed.browser);
  if (!rl.ok) {
    throw new Error(
      `Screenshot rate limit hit for ${parsed.browser} (${RATE_RPS}/s). Retry in ${rl.retryMs}ms.`,
    );
  }

  const buf = await captureWindow(window.cgWindowId);
  if (buf.length === 0) throw new Error("screencapture produced an empty image.");
  const path = deps.shots.putWindow(windowId, buf);
  return { tier: "window", path, bytes: buf.length, format: "jpeg", cached: false };
}
