/**
 * close_tab — close a tab. Destructive (unsaved page state is gone), so
 * annotated accordingly for MCP hosts that gate destructive tools.
 */

import type { ToolDefinition } from "@george43g/mcp-kit";
import { CloseTabInputSchema, CommandResultSchema } from "@george43g/shared-types";
import { closeTab } from "../client/tabs-service.js";

export const closeTabTool: ToolDefinition<typeof CloseTabInputSchema, typeof CommandResultSchema> =
  {
    name: "close_tab",
    description:
      "Closes the given tab. Destructive — the page (and any unsaved state) is gone. " +
      "Use tabId handles from list_tabs. Chromium x-handles stay valid after a close; only " +
      "Safari's index-based handles shift, so re-run list_tabs before further SAFARI calls.",
    input: CloseTabInputSchema,
    output: CommandResultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    timeoutMs: 15_000,
    handler: async (input, signal) => {
      if (signal?.aborted) throw new Error("Cancelled by client");
      return closeTab(input.tabId);
    },
  };
