/**
 * daemon_status — daemon reachability + per-browser detail.
 *
 * This is deliberately NOT part of health_check (which must never touch
 * I/O); daemon reachability is external state and lives here + doctor.
 */

import type { ToolDefinition } from "@george43g/mcp-kit";
import { DaemonStatusInputSchema, DaemonStatusOutputSchema } from "@george43g/shared-types";
import { daemonStatus } from "../client/tabs-service.js";

export const daemonStatusTool: ToolDefinition<
  typeof DaemonStatusInputSchema,
  typeof DaemonStatusOutputSchema
> = {
  name: "daemon_status",
  description:
    "Reports whether the browser-tab daemon is running (unix socket reachable), its uptime, " +
    "poll interval, cgWindowId correlation tier, and per-browser window/tab counts with " +
    "extension connectivity.",
  input: DaemonStatusInputSchema,
  output: DaemonStatusOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  timeoutMs: 5_000,
  handler: async () => {
    return (await daemonStatus()) as { reachable: boolean };
  },
};
