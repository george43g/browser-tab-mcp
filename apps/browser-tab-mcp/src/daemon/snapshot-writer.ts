/**
 * Snapshot file writer — the ultra-cheap consumer surface (sketchybar,
 * shell one-liners read a file instead of opening the socket).
 *
 * Atomic (tmp + rename, same pattern as wm-stack's browser_tabs.sh) and
 * debounced to at most one write per second.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { warn } from "@george43g/robustness";
import type { Snapshot } from "@george43g/shared-types";
import { lastScanPath, snapshotPath } from "./paths.js";

const DEBOUNCE_MS = 1_000;

export class SnapshotWriter {
  private pending: Snapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastWriteAt = 0;

  constructor(private readonly getScanDurationMs: () => number) {}

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
  }
}

function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}
