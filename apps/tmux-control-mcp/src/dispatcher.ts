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
 *  8. devOnly tools are gated on the CALL path, not just hidden from
 *     tools/list. Filtering the listing alone leaves them callable by name —
 *     see the devOnlyEnabled note below.
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
      // REQUIRED, not optional. index.ts filters tools/list by devModeEnabled(),
      // but the listing is cosmetic — a client that already knows the name can
      // still call it. Without this predicate the dev gate does nothing, and the
      // failure is silent: no type error, no test failure, the tool just answers.
      // A dev-only tool that is not enabled must be INDISTINGUISHABLE from one
      // that does not exist.
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
