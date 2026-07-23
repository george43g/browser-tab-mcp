/**
 * Screenshot cache — one jpeg file per shot under shotsDir().
 *
 * Tier "tab" shots are keyed by a filesystem-safe handle + navEpoch, so an
 * unchanged tab (no navigation) serves the same file until it navigates or
 * `force` recaptures. Tier "window" shots have no navigation epoch (a window's
 * pixels change continuously) so they always recapture — they still land here
 * and share the file-count LRU (BROWSER_TAB_SHOT_MAX, default 200).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { envNum, warn } from "@george43g/robustness";
import { shotsDir } from "./paths.js";

const DEFAULT_MAX = 200;

/** Make a handle safe for a filename (drop the `:` handle separators etc.). */
function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

export class ShotStore {
  private readonly dir: string;

  constructor(dir = shotsDir()) {
    this.dir = dir;
  }

  private file(name: string): string {
    return join(this.dir, name);
  }

  private tabName(handle: string, navEpoch: number): string {
    return `t-${safe(handle)}-${navEpoch}.jpg`;
  }

  private windowName(handle: string): string {
    return `w-${safe(handle)}.jpg`;
  }

  /** Existing tab shot at this navEpoch, if any (LRU-touched). Undefined = miss. */
  getTab(handle: string, navEpoch: number): string | undefined {
    const path = this.file(this.tabName(handle, navEpoch));
    if (!existsSync(path)) return undefined;
    try {
      const now = new Date();
      utimesSync(path, now, now);
    } catch {
      // best-effort LRU touch
    }
    return path;
  }

  putTab(handle: string, navEpoch: number, buf: Buffer): string {
    return this.write(this.tabName(handle, navEpoch), buf);
  }

  putWindow(handle: string, buf: Buffer): string {
    return this.write(this.windowName(handle), buf);
  }

  private write(name: string, buf: Buffer): string {
    const path = this.file(name);
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(path, buf);
      this.evict();
    } catch (err) {
      warn("shot_write_failed", { message: (err as Error).message });
    }
    return path;
  }

  private evict(): void {
    const max = envNum("BROWSER_TAB_SHOT_MAX", DEFAULT_MAX);
    let files: { path: string; mtime: number }[];
    try {
      files = readdirSync(this.dir)
        .filter((f) => f.endsWith(".jpg"))
        .map((f) => {
          const path = this.file(f);
          return { path, mtime: statSync(path).mtimeMs };
        });
    } catch {
      return;
    }
    if (files.length <= max) return;
    files.sort((a, b) => a.mtime - b.mtime); // oldest first
    for (const f of files.slice(0, files.length - max)) {
      try {
        unlinkSync(f.path);
      } catch {
        // raced with another writer — ignore
      }
    }
  }
}
