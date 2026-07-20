/**
 * focus_tab — activate a tab and raise its window (AppleScript-able in
 * every supported browser; routed through the daemon when it's up).
 */

import type { ToolDefinition } from "@george43g/mcp-kit";
import { CommandResultSchema, FocusTabInputSchema } from "@george43g/shared-types";
import { focusTab } from "../client/tabs-service.js";

export const focusTabTool: ToolDefinition<typeof FocusTabInputSchema, typeof CommandResultSchema> =
  {
    name: "focus_tab",
    description:
      "Activates the given tab and raises its browser window. Use tabId handles from list_tabs. " +
      "Safari handles are index-based and go stale when tabs reorder — re-run list_tabs on failure.",
    input: FocusTabInputSchema,
    output: CommandResultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    timeoutMs: 15_000,
    handler: async (input, signal) => {
      if (signal?.aborted) throw new Error("Cancelled by client");
      return focusTab(input.tabId);
    },
  };
