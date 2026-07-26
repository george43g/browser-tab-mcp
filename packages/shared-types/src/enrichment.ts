/**
 * Tab / window enrichments — the single authoring point.
 *
 * The pass-through fields shared by the extension wire (ExtTab/ExtWindow) and
 * the contract (Tab/BrowserWindow). Declared ONCE here and merged into both,
 * so adding a field can't drift the two shapes apart. Both mappers copy these
 * via pickEnrichment(); the field-parity contract test enforces it.
 *
 * Also home to the favicon sanitizer (a tab transform, not an enrichment
 * passthrough) and the shared window-state enum, since both belong to the
 * same low layer that contract.ts, wire.ts and tools.ts build on.
 */

import { z } from "zod";

export const TabEnrichmentSchema = z.object({
  pinned: z
    .boolean()
    .default(false)
    .describe("Pinned tab. Extension-sourced; false under AppleScript."),
  audible: z.boolean().default(false).describe("Tab is producing sound. Extension-sourced."),
  discarded: z
    .boolean()
    .default(false)
    .describe("Tab unloaded from memory (asleep). Chrome-family extension only."),
  muted: z.boolean().default(false).describe("Tab audio muted. Extension-sourced."),
  mutedReason: z
    .string()
    .optional()
    .describe("Why the tab is muted (user|capture|extension). Chrome only; absent on Safari."),
  frozen: z
    .boolean()
    .default(false)
    .describe("Tab frozen to save resources (Chrome 132+). Chrome-family only."),
  lastAccessed: z
    .number()
    .optional()
    .describe("Epoch ms the tab was last activated (Chrome 121+). Absent on Safari/AppleScript."),
  status: z
    .enum(["loading", "complete", "unloaded"])
    .optional()
    .describe("Load status. Extension-sourced."),
});
export type TabEnrichment = z.infer<typeof TabEnrichmentSchema>;

/** The enrichment field names — the copy list both tab mappers iterate. */
export const TAB_ENRICHMENT_FIELDS = Object.keys(
  TabEnrichmentSchema.shape,
) as (keyof TabEnrichment)[];

/**
 * Normalize the enrichment fields off a raw ExtTab (or a pre-flattened
 * chrome tab) into a full TabEnrichment (defaults applied, unknown keys
 * dropped). The single point both tab mappers share, so a new enrichment
 * field flows to the contract without editing either mapper.
 */
export function pickEnrichment(src: Record<string, unknown>): TabEnrichment {
  return TabEnrichmentSchema.parse(src);
}

/** Max bytes for an inline `data:` favicon before it's dropped from the snapshot. */
export const FAVICON_MAX_BYTES = 4096;

/**
 * Bound a tab's favicon for the snapshot. An http(s) URL passes through; a
 * `data:` URI is kept only when ≤ `maxBytes` (large inline icons would bloat
 * every debounced push, so they're dropped); every other scheme (chrome:,
 * file:, javascript:, …) and empty/non-string input yields `undefined`.
 * Applied at the extension source so oversized icons never cross the WS; the
 * daemon re-applies it with the env cap and can only tighten. Browser-safe
 * (TextEncoder, no Node `Buffer`).
 */
export function sanitizeFavicon(
  raw: unknown,
  maxBytes: number = FAVICON_MAX_BYTES,
): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (s === "") return undefined;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^data:/i.test(s)) return new TextEncoder().encode(s).length <= maxBytes ? s : undefined;
  return undefined;
}

/** Canonical window states, shared by the enrichment field and the window-op inputs. */
export const WindowStateSchema = z.enum(["normal", "minimized", "maximized", "fullscreen"]);
export type WindowState = z.infer<typeof WindowStateSchema>;

export const WindowEnrichmentSchema = z.object({
  state: WindowStateSchema.optional().describe(
    "Window state. Extension-sourced; absent under AppleScript.",
  ),
});
export type WindowEnrichment = z.infer<typeof WindowEnrichmentSchema>;
export const WINDOW_ENRICHMENT_FIELDS = Object.keys(
  WindowEnrichmentSchema.shape,
) as (keyof WindowEnrichment)[];
