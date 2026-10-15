/**
 * Tool registry — single source of truth for which tools this MCP exposes.
 *
 * Adding a tool:
 *   1. Create `src/tools/<name>.ts` matching the noop pattern.
 *   2. Import it here and add to the array below.
 *   3. Add an integration test in `tests/integration.test.ts`.
 *   4. If lifecycle-affecting, add a stress case in `scripts/stress-mcp.ts`.
 */

import { makeRegistry, type ToolRegistry } from "@george43g/mcp-kit";
import { envBool } from "@george43g/robustness";
import { getLogsTool } from "./get-logs.js";
import { healthCheckTool } from "./health-check.js";
import { listTool } from "./list.js";
import { noopTool } from "./noop.js";

/**
 * Drop the top-level `$schema` dialect label from a tool schema.
 *
 * The published @george43g/mcp-kit stamps `"$schema": "http://json-schema.org/draft-07/schema#"`
 * on every schema. eqstack reported (their PR #184, telephony `server.ts`
 * `withoutSchemaDialect`) that Claude Code 2.1.292 rejects draft-07-labelled
 * tool schemas; not reproduced on 2.1.300, so this is a cheap guard. The vendored
 * kit in browser-tab-mcp does the same inside `makeRegistry`.
 */
function withoutSchemaDialect<T>(schema: T): T {
  const { $schema: _dialect, ...rest } = schema as Record<string, unknown>;
  return rest as T;
}

export function makeAppRegistry(): ToolRegistry {
  const registry = makeRegistry([healthCheckTool, listTool, noopTool, getLogsTool]);
  return {
    ...registry,
    toMcpTools(includeDevOnly = false) {
      return registry.toMcpTools(includeDevOnly).map((t) => ({
        ...t,
        inputSchema: withoutSchemaDialect(t.inputSchema),
        ...(t.outputSchema ? { outputSchema: withoutSchemaDialect(t.outputSchema) } : {}),
      }));
    },
  };
}

export function devModeEnabled(): boolean {
  return envBool("MCP_DEV", false);
}
