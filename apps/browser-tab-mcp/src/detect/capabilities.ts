/**
 * Static capability map for AppleScript-mode browsers (no extension
 * connected). The extension pathway reports a runtime-probed map in its
 * hello; this is the honest fallback for what AppleScript can do today.
 *
 * Reads stay false (enrichments are extension-only). The write-side keys
 * that AppleScript CAN drive are flipped on here per browser family:
 * Chromium can navigate/reload/back-forward + open/close/resize windows;
 * Safari can do the same minus history back/forward (no AppleScript verb).
 * Grouping, discard, duplicate, mute/pin remain extension-only everywhere.
 */

import type { BrowserId, Capabilities } from "@george43g/shared-types";
import { CAPABILITY_KEYS } from "@george43g/shared-types";

export function applescriptCaps(browser: BrowserId): Capabilities {
  const caps = Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, false])) as Record<
    string,
    boolean
  >;
  // Window ops + navigation are AppleScript-able for every supported browser.
  caps.navigate = true;
  caps.reload = true;
  caps.openWindow = true;
  caps.setWindowBounds = true;
  caps.closeWindow = true;
  // Chromium's dictionary has `go back`/`go forward`; Safari's does not.
  caps.backForward = browser !== "safari";
  return caps as Capabilities;
}

/**
 * The safe capability map for an extension that connected but reported no
 * `capabilities` — a legacy/stale build from before the v2 handshake. Every
 * key is false: consumers gate the v2 write-side + perception ops on this map,
 * so all-false makes them *gracefully refuse* (with an actionable hint) instead
 * of the raw "unknown command kind" pass-through error a stale extension throws.
 * Baseline focus/close/move aren't in the map, so they're unaffected.
 */
export function conservativeCaps(): Capabilities {
  return Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, false])) as Capabilities;
}
