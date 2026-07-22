/**
 * tab_action — a single imperative action on one tab: mute/unmute, pin/unpin,
 * discard (unload), reload, navigate, back/forward, duplicate.
 *
 * AppleScript covers navigate/reload for every browser and back/forward on
 * Chromium; mute/pin/discard/duplicate need the extension and error with an
 * actionable hint when it isn't connected.
 */

import type { ToolDefinition } from "@george43g/mcp-kit";
import { CommandResultSchema, TabActionInputSchema } from "@george43g/shared-types";
import { tabAction } from "../client/tabs-service.js";

export const tabActionTool: ToolDefinition<
  typeof TabActionInputSchema,
  typeof CommandResultSchema
> = {
  name: "tab_action",
  description:
    "Runs one action on a tab: mute|unmute, pin|unpin, discard (unload from memory), reload, " +
    "navigate (needs url), back|forward, duplicate. Handles come from list_tabs. Actions beyond " +
    "navigate/reload (and back/forward on Chromium) need the browser extension.",
  input: TabActionInputSchema,
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
    return tabAction(input);
  },
};
