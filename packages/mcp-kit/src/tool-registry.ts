/**
 * Tool registry — types and helpers for declaring MCP tools.
 *
 * Convention: each tool ships its own file with three exports:
 *   - the Zod input schema (for runtime validation)
 *   - the Zod output schema (for structuredContent shape)
 *   - the ToolDefinition (registration metadata)
 *
 * The registry collects ToolDefinitions and converts them to the SDK's
 * `Tool[]` shape via `toMcpTools()`.
 */

import type { Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ZodTypeAny, z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export interface ToolDefinition<
  TInput extends ZodTypeAny = ZodTypeAny,
  TOutput extends ZodTypeAny = ZodTypeAny,
> {
  /** Snake_case tool name, e.g. "health_check". */
  name: string;
  /** One-paragraph description shown to the LLM. */
  description: string;
  /** Zod schema for tool arguments. */
  input: TInput;
  /** Zod schema for tool result (structuredContent). */
  output: TOutput;
  /** MCP annotations: read-only / destructive / idempotent / open-world hints. */
  annotations: ToolAnnotations;
  /**
   * Per-tool timeout in ms. Set to 0 to disable the wrapper for this tool.
   * Resolved against `MCP_TOOL_TIMEOUT_DEFAULT_MS` if omitted (default 30s).
   */
  timeoutMs?: number;
  /** When true, only register the tool if `MCP_DEV=1`. Used for `get_logs`. */
  devOnly?: boolean;
  /** Handler: receives parsed input + AbortSignal, returns structured output. */
  handler: (input: z.infer<TInput>, signal?: AbortSignal) => Promise<z.infer<TOutput>>;
}

// AnyToolDefinition widens both Zod generic params so the registry can hold
// tools with narrow input/output schemas under a single uniform array type.
// Tool authors keep their narrow types at the declaration site; this is the
// boundary alias used internally.
export type AnyToolDefinition = ToolDefinition<any, any>;

export interface ToolRegistry {
  readonly tools: readonly AnyToolDefinition[];
  get(name: string): AnyToolDefinition | undefined;
  /** Convert all tools (or just enabled ones) to MCP SDK shape. */
  toMcpTools(includeDevOnly?: boolean): Tool[];
}

export function makeRegistry(defs: AnyToolDefinition[]): ToolRegistry {
  const byName = new Map(defs.map((d) => [d.name, d]));
  return {
    tools: defs,
    get(name) {
      return byName.get(name);
    },
    toMcpTools(includeDevOnly = false): Tool[] {
      return defs
        .filter((d) => includeDevOnly || !d.devOnly)
        .map(
          (d) =>
            // The SDK Tool type narrows inputSchema/outputSchema to a JSON-
            // schema with `type: "object"` literal; zodToJsonSchema returns
            // the broader JsonSchema7Type union. Cast is safe because we
            // only ever build Zod object schemas as tool I/O.
            ({
              name: d.name,
              description: d.description,
              annotations: d.annotations,
              inputSchema: zodToJsonSchema(d.input),
              outputSchema: zodToJsonSchema(d.output),
            }) as unknown as Tool,
        );
    },
  };
}
