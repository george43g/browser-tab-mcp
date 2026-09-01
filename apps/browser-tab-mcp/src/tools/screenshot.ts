/**
 * screenshot — capture a tab or a window as a jpeg (needs the daemon).
 *
 * Two tiers, picked by which id you pass:
 *   - tabId    → tier "tab": the extension's captureVisibleTab (the active tab
 *     of that window; pass focus:true to activate a background tab first).
 *     Rate-limited ~2/s per browser; cached per navEpoch.
 *   - windowId → tier "window": the daemon's `screencapture -l <cgWindowId>`
 *     for any visible window (opt-in via BROWSER_TAB_WINDOW_CAPTURE + Screen
 *     Recording permission).
 *
 * The image rides back as an MCP image content block (base64 jpeg); the
 * structured result carries the on-disk path, byte size, cache flag and (tier
 * "tab") the navEpoch it was taken at.
 */

import { readFileSync } from "node:fs";
import type { ContentBlock, ToolDefinition } from "@george43g/mcp-kit";
import {
  ScreenshotInputSchema,
  type ScreenshotOutput,
  ScreenshotOutputSchema,
} from "@george43g/shared-types";
import { screenshot } from "../client/tabs-service.js";

export const screenshotTool: ToolDefinition<
  typeof ScreenshotInputSchema,
  typeof ScreenshotOutputSchema
> = {
  name: "screenshot",
  description:
    "Capture a screenshot (needs the daemon). Pass tabId for tier 'tab' (extension captureVisibleTab — " +
    "the active tab of its window; add focus:true to activate a background tab first, which changes what " +
    "the user sees) or windowId for tier 'window' (daemon screencapture of any visible window; opt-in via " +
    "BROWSER_TAB_WINDOW_CAPTURE + Screen Recording permission). Exactly one of tabId/windowId. Tab shots " +
    "are cached per navEpoch (pass force:true to recapture) and rate-limited ~2/s per browser. The image " +
    "returns as a base64 jpeg content block; the structured result has its cache path, byte size and navEpoch.",
  input: ScreenshotInputSchema,
  output: ScreenshotOutputSchema,
  annotations: {
    title: "Capture screenshot",
    readOnlyHint: false, // focus:true activates a tab
    destructiveHint: false,
    idempotentHint: false,
    // Captures what the browser has already rendered; no network interaction.
    openWorldHint: false,
  },
  timeoutMs: 15_000,
  handler: async (input, signal) => {
    if (signal?.aborted) throw new Error("Cancelled by client");
    return screenshot(input);
  },
  // Emit the captured jpeg as an image block alongside the JSON summary. Reads
  // the file the daemon just wrote; a throw here degrades to text-only.
  toContent: (result: ScreenshotOutput): ContentBlock[] => [
    { type: "image", data: readFileSync(result.path).toString("base64"), mimeType: "image/jpeg" },
  ],
};
