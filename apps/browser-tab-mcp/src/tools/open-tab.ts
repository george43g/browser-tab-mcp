/**
 * open_tab — open an http(s) URL in a new tab (optionally in a specific
 * window / browser, optionally without focusing it).
 */

import type { ToolDefinition } from "@george43g/mcp-kit";
import { CommandResultSchema, OpenTabInputSchema } from "@george43g/shared-types";
import { openTab } from "../client/tabs-service.js";

export const openTabTool: ToolDefinition<typeof OpenTabInputSchema, typeof CommandResultSchema> = {
  name: "open_tab",
  description:
    "Opens an http(s) URL in a new tab. Optionally target a browser (chrome|chromium|brave|safari) " +
    "or a specific windowId from list_tabs; activate=false opens in the background.",
  input: OpenTabInputSchema,
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
    return openTab(input);
  },
};
