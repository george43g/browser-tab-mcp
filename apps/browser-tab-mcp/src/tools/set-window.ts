/**
 * set_window — move/resize/minimize/foreground an existing window. Geometry
 * is expressed as explicit bounds or a display index; bounds/display and
 * state are mutually exclusive (bounds win).
 */

import type { ToolDefinition } from "@george43g/mcp-kit";
import { CommandResultSchema, SetWindowInputSchema } from "@george43g/shared-types";
import { setWindow } from "../client/tabs-service.js";

export const setWindowTool: ToolDefinition<
  typeof SetWindowInputSchema,
  typeof CommandResultSchema
> = {
  name: "set_window",
  description:
    "Repositions/resizes/minimizes/foregrounds a window (windowId from list_tabs). Give bounds " +
    "{x,y,w,h} in global screen points, or a 0-based display index (fills that monitor), or a state " +
    "(normal|minimized|maximized|fullscreen), and/or focused. AppleScript supports bounds + " +
    "normal/minimized only.",
  input: SetWindowInputSchema,
  output: CommandResultSchema,
  annotations: {
    title: "Set window state",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  timeoutMs: 15_000,
  handler: async (input, signal) => {
    if (signal?.aborted) throw new Error("Cancelled by client");
    return setWindow(input);
  },
};
