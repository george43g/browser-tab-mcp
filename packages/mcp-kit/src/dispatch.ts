/**
 * Dispatcher — the single place every MCP tool call passes through.
 *
 * DISPATCHER INVARIANTS (do not weaken without consulting AGENTS.md):
 *  1. Every tool runs through withTimeout — declare a per-tool timeout
 *     in ToolDefinition.timeoutMs or rely on MCP_TOOL_TIMEOUT_DEFAULT_MS.
 *  2. noteActivity() fires on every dispatch (feeds the idle watchdog).
 *  3. perf() span around every handler.
 *  4. Errors wrapped with actionable hint + tool name (never bare error.message).
 *  5. AbortSignal honored — long-running handlers check signal?.aborted
 *     between iterations and return early with a structured error.
 *  6. NEVER console.log after StdioServerTransport.connect() — JSON-RPC owns
 *     stdout. Log via @george43g/robustness/logger.
 *  7. Tool responses return { content, structuredContent } per the MCP spec,
 *     plus a perf footer (engine + dur_ms) in `_meta`.
 *
 * The exported `buildDispatcher` returns a function whose shape matches the
 * SDK's `CallToolRequest` handler.
 */

import {
  envNum,
  error as logError,
  noteActivity,
  perf,
  ToolTimeoutError,
  withTimeout,
} from "@george43g/robustness";
import type { ZodError } from "zod";
import { wrapToolError } from "./prompt-injection.js";
import type { ToolRegistry } from "./tool-registry.js";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface DispatcherCounters {
  /** Total successful + failed tool calls. */
  toolCalls: number;
  /** Errors in the last 5 minutes (caller maintains via dispatcher hook). */
  recentErrors: number;
}

export interface BuildDispatcherOptions {
  registry: ToolRegistry;
  /** Called with the ToolTimeoutError / handler-thrown error to bump counters. */
  onError?: (toolName: string, err: unknown) => void;
  /** Called per dispatch (success or failure) to bump call counters. */
  onCall?: (toolName: string) => void;
  /** Engine label, e.g. "rust" or "ts". Surfaced in `_meta` and dev stats. */
  engineLabel?: () => string;
}

export type Dispatch = (name: string, args: unknown, signal?: AbortSignal) => Promise<ToolResult>;

function defaultTimeoutMs(): number {
  return envNum("MCP_TOOL_TIMEOUT_DEFAULT_MS", 30_000);
}

function formatZodError(err: ZodError): string {
  return err.errors.map((e) => `  - ${e.path.join(".") || "(root)"}: ${e.message}`).join("\n");
}

export function buildDispatcher(opts: BuildDispatcherOptions): Dispatch {
  const fallback = defaultTimeoutMs();
  return async (name, args, signal) => {
    noteActivity();
    opts.onCall?.(name);
    const def = opts.registry.get(name);

    if (!def) {
      opts.onError?.(name, new Error("unknown_tool"));
      return {
        content: [
          {
            type: "text",
            text: wrapToolError(name, "Unknown tool name.", "Check the result of tools/list."),
          },
        ],
        isError: true,
      };
    }

    const parsed = def.input.safeParse(args ?? {});
    if (!parsed.success) {
      opts.onError?.(name, parsed.error);
      return {
        content: [
          {
            type: "text",
            text: wrapToolError(
              name,
              "Invalid arguments:",
              `\n${formatZodError(parsed.error as ZodError)}`,
            ),
          },
        ],
        isError: true,
      };
    }

    const span = perf(`dispatch.${name}`);
    const timeoutMs = def.timeoutMs ?? fallback;

    try {
      const result = await withTimeout(name, () => def.handler(parsed.data, signal), timeoutMs);
      const dur = span.end({ engine: opts.engineLabel?.() ?? "ts" });
      return {
        content: [
          {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          },
        ],
        structuredContent: result,
        _meta: {
          engine: opts.engineLabel?.() ?? "ts",
          duration_ms: Math.round(dur * 10) / 10,
        },
      };
    } catch (err) {
      span.end({ error: true });
      opts.onError?.(name, err);
      logError(`dispatch_error: ${name}`, {
        message: (err as Error)?.message,
        stack: (err as Error)?.stack,
      });
      const message =
        err instanceof ToolTimeoutError
          ? `Timed out after ${err.timeoutMs}ms. The server has unblocked; the underlying work may still be running.`
          : ((err as Error)?.message ?? String(err));
      return {
        content: [{ type: "text", text: wrapToolError(name, message) }],
        isError: true,
      };
    }
  };
}
