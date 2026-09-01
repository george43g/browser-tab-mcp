/**
 * focus_tab — activate a tab and (by default) raise its window.
 *
 * AppleScript-able in every supported browser; routed through the daemon when
 * it's up. `raiseWindow:false` activates the tab in place, for callers that own
 * window placement themselves. The result carries the window's post-state
 * (`cgWindowId`/`windowState`/`wasMinimized`/`windowFocused`) so a window
 * manager can act on it without a second `list_tabs` — browser-tab reports,
 * the WM decides.
 */

import type { ToolDefinition } from "@george43g/mcp-kit";
import { CommandResultSchema, FocusTabInputSchema } from "@george43g/shared-types";
import { focusTab } from "../client/tabs-service.js";

export const focusTabTool: ToolDefinition<typeof FocusTabInputSchema, typeof CommandResultSchema> =
  {
    name: "focus_tab",
    description:
      "Activates the given tab and, unless raiseWindow is false, un-minimizes and raises its " +
      "browser window. Returns the window's post-state — cgWindowId (the yabai join key), " +
      "windowState, wasMinimized, windowFocused — so a window manager can act without a second " +
      "list_tabs. Use tabId handles from list_tabs. Safari handles are index-based and go stale " +
      "when tabs reorder — re-run list_tabs on failure.",
    input: FocusTabInputSchema,
    output: CommandResultSchema,
    annotations: {
      title: "Focus tab",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    timeoutMs: 15_000,
    handler: async (input, signal) => {
      if (signal?.aborted) throw new Error("Cancelled by client");
      return focusTab(input);
    },
  };
