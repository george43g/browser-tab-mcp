/**
 * cgWindowId correlation — the yabai join key.
 *
 * yabai window ids ARE CGWindowIDs, so enriching each browser window with
 * its CGWindowID lets wm-stack join on id instead of title matching.
 *
 * Matching: group CG windows by the browser's pid, then match AppleScript
 * window bounds against CG bounds within a small tolerance. Ambiguity
 * (two same-bounds windows) yields cgWindowId: null — never a guess.
 *
 * Source chain:
 *   1. rust-accel native listCgWindows()   (CGWindowListCopyWindowInfo)
 *   2. `yabai -m query --windows`          (yabai already knows ids+frames)
 *   3. none — cgWindowId stays null
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { warn } from "@george43g/robustness";
import type { CgWindowInfo, Snapshot } from "@george43g/shared-types";
import { tryLoadNative } from "../native-bridge.js";

const execFileAsync = promisify(execFile);

const BOUNDS_TOLERANCE_PX = 2;

export type CorrelationTier = "native" | "yabai" | "none";

export function nativeCgAvailable(): boolean {
  const native = tryLoadNative();
  if (!native || typeof native.listCgWindows !== "function") return false;
  try {
    native.listCgWindows();
    return true;
  } catch {
    return false;
  }
}

const YABAI_CANDIDATES = ["/opt/homebrew/bin/yabai", "/usr/local/bin/yabai", "yabai"];

interface YabaiWindow {
  id: number;
  pid: number;
  frame: { x: number; y: number; w: number; h: number };
}

async function readYabaiWindows(signal?: AbortSignal): Promise<CgWindowInfo[] | null> {
  for (const bin of YABAI_CANDIDATES) {
    try {
      const { stdout } = await execFileAsync(bin, ["-m", "query", "--windows"], {
        timeout: 2_000,
        maxBuffer: 8 * 1024 * 1024,
        ...(signal ? { signal } : {}),
      });
      const rows = JSON.parse(stdout) as YabaiWindow[];
      return rows.map((r) => ({
        windowId: r.id,
        ownerPid: r.pid,
        x: r.frame.x,
        y: r.frame.y,
        w: r.frame.w,
        h: r.frame.h,
        layer: 0,
      }));
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Which correlation source is currently usable (for doctor / daemon_status). */
export async function correlationTier(): Promise<CorrelationTier> {
  if (nativeCgAvailable()) return "native";
  if ((await readYabaiWindows()) !== null) return "yabai";
  return "none";
}

async function readCgWindows(signal?: AbortSignal): Promise<CgWindowInfo[] | null> {
  const native = tryLoadNative();
  if (native && typeof native.listCgWindows === "function") {
    try {
      return native.listCgWindows();
    } catch (err) {
      warn("cg_native_failed", { message: (err as Error).message });
    }
  }
  return readYabaiWindows(signal);
}

function boundsMatch(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return (
    Math.abs(a.x - b.x) <= BOUNDS_TOLERANCE_PX &&
    Math.abs(a.y - b.y) <= BOUNDS_TOLERANCE_PX &&
    Math.abs(a.w - b.w) <= BOUNDS_TOLERANCE_PX &&
    Math.abs(a.h - b.h) <= BOUNDS_TOLERANCE_PX
  );
}

/**
 * Pure matching core (unit-testable): for each browser window, find the CG
 * window owned by the browser's pid whose bounds match within tolerance.
 * Multiple candidates → null (ambiguous). No pid → null.
 */
export function correlateSnapshot(snapshot: Snapshot, cgWindows: CgWindowInfo[]): Snapshot {
  return {
    ...snapshot,
    browsers: snapshot.browsers.map((b) => {
      if (b.pid === null || b.windows.length === 0) return b;
      const candidates = cgWindows.filter((cg) => cg.ownerPid === b.pid && cg.layer === 0);
      if (candidates.length === 0) return b;
      return {
        ...b,
        windows: b.windows.map((w) => {
          if (!w.bounds) return w;
          const bounds = w.bounds;
          const matches = candidates.filter((cg) => boundsMatch(bounds, cg));
          const first = matches[0];
          return {
            ...w,
            cgWindowId: matches.length === 1 && first !== undefined ? first.windowId : null,
          };
        }),
      };
    }),
  };
}

/** Enrich a snapshot with cgWindowIds. Failures degrade to null ids, never throw. */
export async function enrichWithCgWindowIds(
  snapshot: Snapshot,
  signal?: AbortSignal,
): Promise<Snapshot> {
  try {
    const cgWindows = await readCgWindows(signal);
    if (!cgWindows) return snapshot;
    return correlateSnapshot(snapshot, cgWindows);
  } catch (err) {
    warn("cg_correlation_failed", { message: (err as Error).message });
    return snapshot;
  }
}
