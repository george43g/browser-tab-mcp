/**
 * group_tabs — create/add/remove/update/move Chrome tab groups.
 *
 * Extension pathway only (chrome.tabGroups has no AppleScript equivalent);
 * errors with a hint when the target browser's extension isn't connected.
 */

import type { ToolDefinition } from "@george43g/mcp-kit";
import { CommandResultSchema, GroupTabsInputSchema } from "@george43g/shared-types";
import { groupTabs } from "../client/tabs-service.js";

export const groupTabsTool: ToolDefinition<
  typeof GroupTabsInputSchema,
  typeof CommandResultSchema
> = {
  name: "group_tabs",
  description:
    "Manages Chrome tab groups: create a group from tabIds, add/remove tabIds, update a group's " +
    "title/color/collapsed, or move a group to another window/index. Tab/group/window handles come " +
    "from list_tabs. Chrome-family only (requires the connected extension).",
  input: GroupTabsInputSchema,
  output: CommandResultSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  timeoutMs: 15_000,
  handler: async (input, signal) => {
    if (signal?.aborted) throw new Error("Cancelled by client");
    return groupTabs(input);
  },
};
