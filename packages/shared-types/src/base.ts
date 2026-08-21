/**
 * Primitives shared across the whole contract — browser ids, window bounds,
 * and the per-browser capability map. These are the lowest layer: every other
 * shared-types module may import from here; this module imports only `zod`.
 */

import { z } from "zod";

/** Browsers the detection engine knows how to talk to. */
export const BrowserIdSchema = z
  .enum(["chrome", "chromium", "brave", "edge", "safari"])
  .describe("Browser identifier.");
export type BrowserId = z.infer<typeof BrowserIdSchema>;

export const WindowBoundsSchema = z
  .object({
    x: z.number().describe("Left edge in screen points."),
    y: z.number().describe("Top edge in screen points."),
    w: z.number().describe("Width in points."),
    h: z.number().describe("Height in points."),
  })
  .describe("Window frame in global screen coordinates.");
export type WindowBounds = z.infer<typeof WindowBoundsSchema>;

// ── capabilities ──────────────────────────────────────────────────────
//
// Per-browser feature availability. The extension probes it at runtime
// (API/field existence) and reports it in `hello`; AppleScript-mode
// browsers get a static daemon-side map. A record, so adding a capability
// key is never a schema change. Consumers gate optional behavior on these
// instead of hardcoding browser/version compat.

export const CapabilitiesSchema = z
  .record(z.string(), z.boolean())
  .describe("Per-browser feature availability (runtime-probed; AppleScript gets a static map).");
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/** Canonical capability keys the extension probes and the daemon reports. */
export const CAPABILITY_KEYS = [
  "audible",
  "muted",
  "discarded",
  "frozen",
  "tabGroups",
  "lastAccessed",
  "navigate",
  "reload",
  "backForward",
  "duplicate",
  "discard",
  "openWindow",
  "setWindowBounds",
  "closeWindow",
  "focusEvents",
  "navEvents",
  "bookmarks",
  "contentExtraction",
  "captureVisibleTab",
  "history",
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/**
 * Strip HTTP basic-auth userinfo (`user:pass@`) out of a URL.
 *
 * Tab URLs are recorded into snapshots, journals, history results and logs —
 * and a URL like `http://admin:secret@192.168.1.1/` carries a live credential
 * into every one of those places, including an agent's context window (found
 * in the wild during the 2026-08-20 dogfood run: two router-admin tabs).
 * Redaction happens AT THE MAPPERS, so the credential never exists in any
 * stored or transmitted record; this helper is in shared-types because both
 * the extension bundle and the daemon need the identical behaviour.
 *
 * Fast path first: URLs without "@" (approximately all of them) return
 * unchanged without paying for URL parsing. Unparseable strings also return
 * unchanged — a snapshot field is not the place to throw.
 */
export function redactUrlUserinfo(url: string): string {
  if (!url.includes("@")) return url;
  try {
    const u = new URL(url);
    if (u.username === "" && u.password === "") return url;
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return url;
  }
}
