/**
 * Local dispatcher — instantiated once at startup, exported as
 * `callMcpTool` so the CLI / TUI / tests can drive it in-process without
 * spawning a child stdio server.
 *
 * DISPATCHER INVARIANTS (encoded by @george43g/mcp-kit's buildDispatcher):
 *  1. Every tool runs through withTimeout (per-tool ms or default 30s).
 *  2. noteActivity() fires per dispatch (feeds idle watchdog).
 *  3. perf() span around every handler.
 *  4. Errors wrapped with actionable hint + tool name.
 *  5. AbortSignal honored — handlers check signal?.aborted in long loops.
 *  6. NEVER console.log after StdioServerTransport.connect() — JSON-RPC
 *     owns stdout. Log via @george43g/robustness/logger.
 *  7. Tool responses include structuredContent + _meta footer.
 *  8. `devOnly` tools are unreachable unless dev mode is on — for EVERY
 *     caller, not just the MCP `tools/list` surface.
 */

import { buildDispatcher, type Dispatch } from "@george43g/mcp-kit";
import { recordToolCall, recordToolError } from "./counters.js";
import { engineLabel } from "./native-bridge.js";
import { devModeEnabled, makeAppRegistry } from "./tools/registry.js";

let _dispatch: Dispatch | null = null;

export function getDispatcher(): Dispatch {
  if (!_dispatch) {
    _dispatch = buildDispatcher({
      registry: makeAppRegistry(),
      onCall: () => recordToolCall(),
      onError: () => recordToolError(),
      engineLabel,
      // Invariant 8: `devOnly` is enforced HERE, not only by `toMcpTools()`.
      // Hiding get_logs from tools/list left it callable by name — and by the
      // CLI and REPL, which never consult that filter at all.
      devOnlyEnabled: devModeEnabled,
    });
  }
  return _dispatch;
}

/**
 * Call a tool by name with structured arguments, in-process.
 * Used by CLI subcommands, TUI hooks, and integration tests so we don't
 * spawn a child MCP per call.
 */
export async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  return getDispatcher()(name, args, signal);
}
