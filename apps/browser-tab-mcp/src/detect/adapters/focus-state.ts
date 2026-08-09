/**
 * Shared decoder for the window post-state an AppleScript `focusTab` returns.
 *
 * Both adapters emit the same three trailing fields (pre-minimized,
 * post-minimized, window index) from otherwise browser-specific scripts —
 * Chromium calls the property `minimized`, Safari `miniaturized` — so the
 * decoding lives here rather than being written twice and drifting.
 *
 * AppleScript can only express `normal` and `minimized` (maximized/fullscreen
 * are not scriptable for either browser), so `windowState` is deliberately one
 * of those two. Anything the script could not report is simply omitted: the
 * fields are optional precisely so a pathway may be honest about not knowing.
 */

import type { CommandResult } from "@george43g/shared-types";

/** AppleScript booleans come back as the literal text "true"/"false". */
function osaBool(raw: string | undefined): boolean | undefined {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

export function focusWindowState(raw: {
  wasMin: string | undefined;
  isMin: string | undefined;
  winIndex: string | undefined;
}): Pick<CommandResult, "windowState" | "wasMinimized" | "windowFocused"> {
  const wasMinimized = osaBool(raw.wasMin);
  const isMinimized = osaBool(raw.isMin);
  // AppleScript orders windows front-to-back, so index 1 IS "the browser's
  // frontmost window" — the same thing `focused` means on a snapshot window.
  const index = raw.winIndex ? Number.parseInt(raw.winIndex, 10) : Number.NaN;
  return {
    ...(wasMinimized !== undefined ? { wasMinimized } : {}),
    ...(isMinimized !== undefined
      ? { windowState: isMinimized ? ("minimized" as const) : ("normal" as const) }
      : {}),
    ...(Number.isFinite(index) ? { windowFocused: index === 1 } : {}),
  };
}
