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
import { noopTool } from "./noop.js";

export function makeAppRegistry(): ToolRegistry {
  return makeRegistry([healthCheckTool, noopTool, getLogsTool]);
}

export function devModeEnabled(): boolean {
  return envBool("MCP_DEV", false);
}
