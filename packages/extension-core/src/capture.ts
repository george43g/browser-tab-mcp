/**
 * Capture-on-blur — when the user switches tabs, snapshot the state of the
 * tab they just LEFT (dirty forms, playing media, scroll depth) so
 * "left this tab mid-edit" lands in the daemon's focus journal.
 *
 * Constraints (all here, all testable):
 *  - module-level prev-active map per window — a SW death loses it → one
 *    missed capture, acceptable (the daemon is the system of record);
 *  - 300ms settle delay, cancelled if the tab is re-activated (kills alt-tab
 *    churn — you flick past a tab, no capture);
 *  - 5s per-tab cooldown; at most 2 concurrent injections;
 *  - skip discarded / non-http(s) / incognito tabs;
 *  - failures are logged-and-swallowed — capture is best-effort telemetry.
 *
 * Enabled by daemon policy (`helloAck.config.blurCapture`); disabled by
 * default so an old daemon never triggers injections.
 */

import { injectExtract } from "./inject.js";
import { logError } from "./log.js";
import { api } from "./runtime.js";

export interface ActivatedInfo {
  tabId: number;
  windowId: number;
}

export interface StateCaptureFrame {
  kind: "stateCapture";
  tabId: number;
  state: unknown;
}

interface TabLike {
  discarded?: boolean;
  incognito?: boolean;
  url?: string;
}

const SETTLE_MS = 300;
const COOLDOWN_MS = 5_000;
const MAX_CONCURRENT = 2;

export class BlurCapturer {
  private enabled = false;
  private readonly prevActive = new Map<number, number>(); // windowId → tabId
  private readonly cooldown = new Map<number, number>(); // tabId → last-capture ts
  private readonly pending = new Map<number, ReturnType<typeof setTimeout>>(); // tabId → settle timer
  private inFlight = 0;

  constructor(
    private readonly emit: (frame: StateCaptureFrame) => void,
    private readonly now: () => number = () => Date.now(),
    private readonly getTab: (tabId: number) => Promise<TabLike | undefined> = defaultGetTab,
    private readonly inject: (tabId: number, mode: string) => Promise<unknown> = (tabId, mode) =>
      injectExtract(tabId, mode),
  ) {}

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.clearPending();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Wire onto tabs.onActivated. Tracks prev-active always; schedules a
   *  capture of the departed tab only when enabled. */
  onActivated(info: ActivatedInfo): void {
    // Re-activating a tab we were about to capture cancels it (alt-tab churn).
    const settling = this.pending.get(info.tabId);
    if (settling) {
      clearTimeout(settling);
      this.pending.delete(info.tabId);
    }
    const prev = this.prevActive.get(info.windowId);
    this.prevActive.set(info.windowId, info.tabId);
    if (!this.enabled) return;
    if (prev === undefined || prev === info.tabId) return;
    this.schedule(prev);
  }

  private schedule(tabId: number): void {
    const last = this.cooldown.get(tabId);
    if (last !== undefined && this.now() - last < COOLDOWN_MS) return;
    if (this.pending.has(tabId)) return;
    const timer = setTimeout(() => {
      this.pending.delete(tabId);
      void this.capture(tabId);
    }, SETTLE_MS);
    (timer as { unref?: () => void }).unref?.();
    this.pending.set(tabId, timer);
  }

  private async capture(tabId: number): Promise<void> {
    if (this.inFlight >= MAX_CONCURRENT) return; // shed load — next switch retries
    let tab: TabLike | undefined;
    try {
      tab = await this.getTab(tabId);
    } catch {
      return;
    }
    if (!tab || tab.discarded || tab.incognito) return;
    if (!/^https?:/i.test(tab.url ?? "")) return;
    this.cooldown.set(tabId, this.now());
    this.inFlight++;
    try {
      const state = await this.inject(tabId, "state");
      const pageState = (state as { state?: unknown } | null)?.state ?? state;
      if (pageState) this.emit({ kind: "stateCapture", tabId, state: pageState });
    } catch (err) {
      logError(`blur capture failed for tab ${tabId}: ${(err as Error).message}`);
    } finally {
      this.inFlight--;
    }
  }

  private clearPending(): void {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }
}

function defaultGetTab(tabId: number): Promise<TabLike | undefined> {
  const tabs = api.tabs as unknown as { get: (id: number) => Promise<TabLike> };
  return tabs.get(tabId);
}
