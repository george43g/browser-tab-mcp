/**
 * Demo MCP Resources provider.
 *
 * Most MCP servers ship Tools-only because the SDK examples focus on
 * Tools. Resources are the second handler shape — read-only addressable
 * state. Hosts (Claude Desktop, Cursor, etc.) can browse and subscribe
 * to resources without re-invoking tools.
 *
 * This demo exposes two:
 *   - `health://`             → the existing snapshotHealth() JSON
 *   - `logs://recent/{n}`     → last N NDJSON log entries (dev-gated)
 *
 * Both are pure-data — no IO beyond what the robustness layer already
 * provides. Add your own by extending `list()` / `listTemplates()` /
 * the `read()` URI dispatch.
 *
 * To disable Resources entirely (e.g. for compliance): set the env var
 * MCP_DISABLE_RESOURCES=1 — index.ts checks this before wiring handlers.
 */

import type { ResourcesProvider } from "@george43g/mcp-kit";
import { getLogs, snapshotHealth } from "@george43g/robustness";
import { getCounters } from "../counters.js";

const HEALTH_URI = "health://";
const LOGS_TEMPLATE = "logs://recent/{n}";
const LOGS_PREFIX = "logs://recent/";

function devModeEnabled(): boolean {
  return process.env.MCP_DEV === "1" || process.env.NODE_ENV === "development";
}

export function makeResourcesProvider(): ResourcesProvider {
  return {
    list: () => [
      {
        uri: HEALTH_URI,
        name: "Health snapshot",
        description: "Current event-loop lag, RSS, heap, uptime, and watchdog status.",
        mimeType: "application/json",
      },
    ],
    listTemplates: () =>
      devModeEnabled()
        ? [
            {
              uriTemplate: LOGS_TEMPLATE,
              name: "Recent log lines",
              description:
                "Last N NDJSON log entries from the in-memory ring buffer. Dev-only (gated by MCP_DEV=1).",
              mimeType: "application/x-ndjson",
            },
          ]
        : [],
    read: (uri) => {
      if (uri === HEALTH_URI) {
        return {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(snapshotHealth(getCounters()), null, 2),
        };
      }
      if (uri.startsWith(LOGS_PREFIX)) {
        if (!devModeEnabled()) {
          throw new Error("logs:// resources are dev-only — set MCP_DEV=1 to enable");
        }
        const rest = uri.slice(LOGS_PREFIX.length);
        const n = Number.parseInt(rest, 10);
        if (!Number.isFinite(n) || n <= 0 || n > 500) {
          throw new Error(`expected logs://recent/<1..500>, got "${uri}"`);
        }
        return {
          uri,
          mimeType: "application/x-ndjson",
          text: getLogs(n).join("\n"),
        };
      }
      throw new Error(`unknown resource URI "${uri}"`);
    },
  };
}
