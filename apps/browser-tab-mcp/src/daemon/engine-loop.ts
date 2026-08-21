/**
 * Polling loop over the detection engine.
 *
 * Every tick: AppleScript-read all enabled browsers, merge with extension
 * feeds, push into the StateStore (which diffs + emits events), and call
 * noteActivity() so the idle watchdog treats a quietly-polling daemon as
 * alive.
 *
 * Interval: BROWSER_TAB_POLL_MS (default 5000). A browser with a live
 * extension feed is polled on a relaxed verification cadence instead
 * (every EXT_VERIFY_EVERY_TICKS ticks) — events already flow push-style.
 */

import { envNum, info, error as logError, noteActivity } from "@george43g/robustness";
import type { BrowserId, Snapshot } from "@george43g/shared-types";
import { cgDiagEnabled } from "../detect/correlate.js";
import { enabledBrowsers, readSnapshot } from "../detect/engine.js";
import type { SourceMerger } from "./merge.js";
import type { StateStore } from "./state.js";

const EXT_VERIFY_EVERY_TICKS = 6; // with 5s polls: verify extension browsers every 30s

export function pollMs(): number {
  return envNum("BROWSER_TAB_POLL_MS", 5_000);
}

/**
 * How long an extension feed stays authoritative without a fresh frame. The
 * WS server touches the feed on every pong (≤20s cadence), so this only has
 * to comfortably exceed one ping interval — floored at 60s so a fast poll
 * (default 5s) can't collapse it to the old 10s window where an idle-but-
 * connected browser silently reverted to AppleScript handles.
 */
export function extFeedTtlMs(): number {
  return Math.max(pollMs() * 2, 60_000);
}

export class EngineLoop {
  private timer: NodeJS.Timeout | null = null;
  private tickCount = 0;
  private scanning = false;
  /** Serializes scans — AppleScript reads must never overlap. */
  private queue: Promise<void> = Promise.resolve();
  private lastScanDurationMs = 0;
  private lastPolled: Snapshot | null = null;
  /** When `lastPolled` was last (re)assigned — the staleness clock `cg_merge_trigger` reports. */
  private lastPolledAt = 0;
  private onTick: (() => void) | null = null;

  constructor(
    private readonly store: StateStore,
    private readonly merger: SourceMerger,
  ) {}

  /**
   * Run `fn` after every tick that completes without throwing. This is the
   * liveness signal the heartbeat file rides on: a tick that wedges or throws
   * never fires it, so a stalled read loop stops the beat instead of faking it.
   * Settable (not constructor-injected) because the writer needs the loop.
   */
  setOnTick(fn: () => void): void {
    this.onTick = fn;
  }

  start(): void {
    if (this.timer) return;
    const interval = pollMs();
    this.timer = setInterval(() => {
      // Interval ticks are skippable — if a scan is already running,
      // there'll be another tick shortly anyway.
      if (!this.scanning) void this.enqueueTick(false);
    }, interval);
    this.timer.unref();
    void this.enqueueTick(false); // immediate first scan
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  lastScanDuration(): number {
    return this.lastScanDurationMs;
  }

  /** Force an immediate rescan (IPC `refresh`, post-command reconciliation). */
  async refresh(): Promise<Snapshot> {
    await this.enqueueTick(true);
    return this.store.getSnapshot();
  }

  /**
   * Re-merge without an AppleScript rescan — used when an extension pushes
   * a fresh snapshot (event latency must not pay the osascript tax).
   */
  async remerge(): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        if (!this.lastPolled) return;
        // Gated: this fires on every extension event, so unconditional logging
        // would be noisy. M1's fingerprint is trigger:"event" with a large
        // lastPolledAgeMs alongside exact:0 in the adjacent cg_correlate line.
        if (cgDiagEnabled()) {
          info("cg_merge_trigger", {
            trigger: "event",
            lastPolledAgeMs: Date.now() - this.lastPolledAt,
          });
        }
        const merged = await this.merger.merge(this.lastPolled, extFeedTtlMs());
        this.store.update(merged);
      })
      .catch(() => {});
    return this.queue;
  }

  /** Explicit refreshes queue behind any in-flight scan and always run. */
  private enqueueTick(force: boolean): Promise<void> {
    this.queue = this.queue.then(() => this.tick(force)).catch(() => {});
    return this.queue;
  }

  private async tick(force: boolean): Promise<void> {
    this.scanning = true;
    const started = Date.now();
    try {
      noteActivity();
      this.tickCount++;
      const browsers = this.browsersToPoll(force);
      if (browsers.length > 0) {
        const polled = await readSnapshot({ browsers });
        this.lastPolled = this.mergePolled(this.lastPolled, polled);
        this.lastPolledAt = Date.now();
      }
      if (this.lastPolled) {
        // Note: browsersToPoll skips extension-connected browsers most ticks
        // (verified every EXT_VERIFY_EVERY_TICKS), so ages up to ~30s here are
        // normal — the diagnostic question is whether nulls correlate with age.
        if (cgDiagEnabled()) {
          info("cg_merge_trigger", {
            trigger: "poll",
            lastPolledAgeMs: Date.now() - this.lastPolledAt,
          });
        }
        const merged = await this.merger.merge(this.lastPolled, extFeedTtlMs());
        this.store.update(merged);
      }
      this.lastScanDurationMs = Date.now() - started;
      // Last thing in the happy path — see setOnTick.
      this.onTick?.();
    } catch (err) {
      logError("engine_loop_tick_failed", { message: (err as Error).message });
    } finally {
      this.scanning = false;
    }
  }

  /** Extension-fed browsers get a relaxed verification cadence. */
  private browsersToPoll(force: boolean): BrowserId[] {
    const all = enabledBrowsers();
    if (force || this.tickCount % EXT_VERIFY_EVERY_TICKS === 1) return all;
    return all.filter((b) => !this.merger.extensionConnected(b));
  }

  /** Keep the last known state for browsers skipped this tick. */
  private mergePolled(prev: Snapshot | null, next: Snapshot): Snapshot {
    if (!prev) return next;
    const polledBrowsers = new Set(next.browsers.map((b) => b.browser));
    return {
      ...next,
      browsers: [
        ...next.browsers,
        ...prev.browsers.filter((b) => !polledBrowsers.has(b.browser)),
      ].sort((a, b) => a.browser.localeCompare(b.browser)),
    };
  }
}
