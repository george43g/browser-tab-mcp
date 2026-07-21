/**
 * Static capability map for AppleScript-mode browsers (no extension
 * connected). The extension pathway reports a runtime-probed map in its
 * hello; this is the honest fallback for what AppleScript can do today.
 *
 * PR1 ships reads only, so every v2 feature is false here; later phases
 * flip the write-side keys (navigate/reload/back-forward/window ops) for
 * the Chromium AppleScript path as those commands land.
 */

import type { BrowserId, Capabilities } from "@george43g/shared-types";
import { CAPABILITY_KEYS } from "@george43g/shared-types";

export function applescriptCaps(_browser: BrowserId): Capabilities {
  return Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, false])) as Capabilities;
}
