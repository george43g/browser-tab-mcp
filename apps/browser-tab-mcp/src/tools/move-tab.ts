/**
 * move_tab — move a tab to another window (or a new one).
 *
 * Execution pathways, best to worst:
 *   1. Extension (daemon + browser-tab extension connected): true
 *      state-preserving move via tabs.move / windows.create. [M5]
 *   2. Safari AppleScript with allowReload:true — real move, but the page
 *      reloads (loses scroll/form/JS state).
 *   3. Chromium AppleScript: refuses with an actionable hint (close+reopen
 *      is not a move worth doing silently).
 */

import type { ToolDefinition } from "@george43g/mcp-kit";
import { CommandResultSchema, MoveTabInputSchema } from "@george43g/shared-types";
import { moveTab } from "../client/tabs-service.js";

export const moveTabTool: ToolDefinition<typeof MoveTabInputSchema, typeof CommandResultSchema> = {
  name: "move_tab",
  description:
    "Moves a tab to another window (targetWindowId) or into a new window (newWindow:true). " +
    "State-preserving moves require the daemon + browser extension; Safari can move via " +
    "AppleScript with allowReload:true (page reloads). Handles come from list_tabs; a moved " +
    "tab may get a new tabId — re-run list_tabs afterwards.",
  input: MoveTabInputSchema,
  output: CommandResultSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  timeoutMs: 20_000,
  handler: async (input, signal) => {
    if (signal?.aborted) throw new Error("Cancelled by client");
    return moveTab(input);
  },
};
