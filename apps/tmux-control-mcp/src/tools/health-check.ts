/**
 * health_check — the canary tool.
 *
 * MUST never touch external I/O. Returns instantly even when:
 *   - the network is down
 *   - other tools are wedged on long SQL
 *   - the LLM is hammering this server with parallel requests
 *
 * This is the tool a host uses to verify the server is alive when other
 * tools hang. Cap timeout at 5s.
 */

import type { ToolDefinition } from "@george43g/mcp-kit";
import { snapshotHealth } from "@george43g/robustness";
import { HealthCheckInputSchema, HealthSnapshotSchema } from "@george43g/shared-types";
import { getCounters } from "../counters.js";

export const healthCheckTool: ToolDefinition<
  typeof HealthCheckInputSchema,
  typeof HealthSnapshotSchema
> = {
  name: "health_check",
  description:
    "Returns server health metrics (uptime, memory, event-loop p99, tool call count, recent errors). Does not call any external service. Use this to verify the server is alive when other tools hang.",
  input: HealthCheckInputSchema,
  output: HealthSnapshotSchema,
  annotations: {
    title: "Health check",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  timeoutMs: 5000,
  handler: async () => {
    const snap = snapshotHealth(getCounters());
    return {
      status: snap.status,
      issues: snap.issues,
      uptimeS: snap.uptime_s,
      pid: snap.pid,
      node: snap.node,
      heapMb: snap.heap_mb,
      rssMb: snap.rss_mb,
      eventLoopP99Ms: snap.event_loop_p99_ms,
      eventLoopMaxMs: snap.event_loop_max_ms,
      toolCalls: snap.tool_calls,
      recentErrors: snap.recent_errors,
      lastActivityAgeS: snap.last_activity_age_s,
    };
  },
};
