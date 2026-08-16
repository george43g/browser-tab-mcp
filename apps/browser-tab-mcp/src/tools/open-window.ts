/**
 * open_window — open a new browser window with one or more URLs, optionally
 * placed by explicit bounds or on a specific display, in a given state.
 */

import type { ToolDefinition } from "@george43g/mcp-kit";
import { CommandResultSchema, OpenWindowInputSchema } from "@george43g/shared-types";
import { z } from "zod";
import { navigableUrl } from "./url-policy.js";

const OpenWindowInput = OpenWindowInputSchema.extend({
  urls: z
    .array(navigableUrl("URL to open."))
    .min(1)
    .describe("URLs to open; the first becomes the active tab."),
});

import { openWindow } from "../client/tabs-service.js";

export const openWindowTool: ToolDefinition<typeof OpenWindowInput, typeof CommandResultSchema> = {
  name: "open_window",
  description:
    "Opens a new window with the given http(s) urls (first becomes active). Place it with explicit " +
    "bounds {x,y,w,h} in global screen points, or a 0-based display index (fills that monitor; needs " +
    "the native module), or a state (normal|minimized|maximized|fullscreen). incognito opens a " +
    "private window (Chrome-family). AppleScript supports bounds + normal/minimized only.",
  input: OpenWindowInput,
  output: CommandResultSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  timeoutMs: 15_000,
  handler: async (input, signal) => {
    if (signal?.aborted) throw new Error("Cancelled by client");
    return openWindow(input);
  },
};
