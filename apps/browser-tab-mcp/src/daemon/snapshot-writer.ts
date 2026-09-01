/**
 * Snapshot file writer — the ultra-cheap consumer surface (sketchybar,
 * shell one-liners read a file instead of opening the socket).
 *
 * Atomic (tmp + rename, same pattern as wm-stack's browser_tabs.sh) and
 * debounced to at most one write per second.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { warn } from "@george43g/robustness";
import type { Snapshot } from "@george43g/shared-types";
import { buildStamp } from "../meta.js";
import { heartbeatPath, lastScanPath, snapshotPath } from "./paths.js";

const DEBOUNCE_MS = 1_000;

export class SnapshotWriter {
  private pending: Snapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastWriteAt = 0;

  constructor(
    private readonly getScanDurationMs: () => number,
    /** Current StateStore revision, so one heartbeat read answers "which state". */
    private readonly getRevision: () => number = () => 0,
  ) {}

  /**
   * Liveness beacon — one `stat` tells a shell consumer the daemon is alive.
   *
   * Called at the END of a completed engine tick, never on a bare timer: a
   * timer keeps beating while the read loop is wedged on a hung osascript,
   * which is precisely the failure a consumer is trying to detect. Cadence is
   * therefore BROWSER_TAB_POLL_MS (5s default); a reader should treat anything
   * younger than ~60-90s as alive.
   *
   * `snapshotChangedAt` is carried here so one read answers both "is the daemon
   * alive?" and "is my snapshot current, or merely unchanged?" — `snapshot.json`
   * is only rewritten on a diff, so its own mtime can be hours old and correct.
   */
  heartbeat(): void {
    try {
      writeAtomic(
        heartbeatPath(),
        JSON.stringify({
          ts: Date.now(),
          pid: process.pid,
          build: buildStamp(),
          contractVersion: 2,
          snapshotChangedAt: this.lastWriteAt,
          revision: this.getRevision(),
        }),
      );
    } catch (err) {
      // Never fatal: a daemon that can't write its beacon still serves reads.
      warn("heartbeat_write_failed", { message: (err as Error).message });
    }
  }

  schedule(snapshot: Snapshot): void {
    this.pending = snapshot;
    if (this.timer) return;
    const wait = Math.max(0, DEBOUNCE_MS - (Date.now() - this.lastWriteAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
    this.timer.unref();
  }

  flush(): void {
    if (!this.pending) return;
    const snapshot = this.pending;
    this.pending = null;
    this.lastWriteAt = Date.now();
    try {
      writeAtomic(snapshotPath(), JSON.stringify(snapshot));
      const windowCount = snapshot.browsers.reduce((a, b) => a + b.windows.length, 0);
      const totalTabs = snapshot.browsers.reduce(
        (a, b) => a + b.windows.reduce((x, w) => x + w.tabCount, 0),
        0,
      );
      writeAtomic(
        lastScanPath(),
        JSON.stringify({
          ts: Math.floor(Date.now() / 1000),
          durationMs: this.getScanDurationMs(),
          windowCount,
          totalTabs,
          source: "daemon",
        }),
      );
    } catch (err) {
      warn("snapshot_write_failed", { message: (err as Error).message });
    }
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flush();
    // Remove the beacon on a CLEAN stop so consumers detect the daemon is down
    // immediately instead of waiting out the staleness window. A crash leaves
    // it behind — which is exactly what the age check is for.
    try {
      rmSync(heartbeatPath(), { force: true });
    } catch (err) {
      warn("heartbeat_unlink_failed", { message: (err as Error).message });
    }
  }
}

function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}
