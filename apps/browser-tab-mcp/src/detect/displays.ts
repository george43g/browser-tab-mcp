/**
 * Display targeting — translate a `display` index into global-screen bounds.
 *
 * `open_window`/`set_window` accept either explicit `bounds` (global
 * coordinates, used verbatim) or a `display` index. A display target fills
 * that display's frame; the actual geometry rarely matters for the wm-stack
 * consumer (yabai tiles the window afterward) — what matters is which monitor.
 *
 * Reads the active-display list from the rust-accel native module. When the
 * module is absent (CI, no toolchain), display targeting errors with an
 * actionable hint while explicit `bounds` keeps working.
 */

import type { DisplayInfo, WindowBounds } from "@george43g/shared-types";
import { tryLoadNative } from "../native-bridge.js";

export function listDisplays(): DisplayInfo[] {
  return tryLoadNative()?.listDisplays() ?? [];
}

export interface DisplayTarget {
  bounds?: WindowBounds | undefined;
  display?: number | undefined;
}

/**
 * Resolve a {bounds?, display?} target into explicit bounds. Explicit bounds
 * win. A `display` index resolves to that display's full frame; throws with a
 * hint when the native module is missing or the index is out of range.
 * Returns undefined when neither is specified (caller leaves geometry as-is).
 */
export function resolveWindowBounds(target: DisplayTarget): WindowBounds | undefined {
  if (target.bounds) return target.bounds;
  if (target.display === undefined) return undefined;
  const displays = listDisplays();
  if (displays.length === 0) {
    throw new Error(
      "Display targeting needs the native module, which isn't loaded. " +
        "Build it (`pnpm --filter rust-accel build`) or pass explicit `bounds` in global coordinates.",
    );
  }
  const d = displays[target.display];
  if (!d) {
    throw new Error(
      `Display ${target.display} not found — ${displays.length} active display(s) (indices 0..${displays.length - 1}).`,
    );
  }
  return { x: d.x, y: d.y, w: d.w, h: d.h };
}
