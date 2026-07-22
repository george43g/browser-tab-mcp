/**
 * close_window — close an entire window (and every tab in it). Destructive:
 * unsaved form state in those tabs is lost.
 */

import type { ToolDefinition } from "@george43g/mcp-kit";
import { CloseWindowInputSchema, CommandResultSchema } from "@george43g/shared-types";
import { closeWindow } from "../client/tabs-service.js";

export const closeWindowTool: ToolDefinition<
  typeof CloseWindowInputSchema,
  typeof CommandResultSchema
> = {
  name: "close_window",
  description:
    "Closes an entire window and all its tabs (windowId from list_tabs). Destructive — unsaved " +
    "state in those tabs is lost.",
  input: CloseWindowInputSchema,
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
    return closeWindow(input);
  },
};
