/**
 * MCP server entry — stdio transport.
 *
 * This file is BOTH a library entry (exports `runMcpServer`, `callMcpTool`
 * for in-process consumers) AND a direct-invocation entry (the stress
 * harness and other tooling spawns `tsx src/index.ts` directly, falling
 * through to the `isMain` block below).
 *
 * The single bin (`dist/cli.js`) does NOT route through this file — it
 * imports `runMcpServer` and calls it directly.
 *
 * INVARIANT: never console.log after the stdio transport opens. All output
 * goes through @george43g/robustness/logger.
 *
 * To remove the dev-only get_logs tool: drop it from src/tools/registry.ts.
 */

import { buildResourcesHandler, startStdio } from "@george43g/mcp-kit";
import { envBool, setLogFilePrefix } from "@george43g/robustness";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getDispatcher } from "./dispatcher.js";
import { APP_NAME, APP_VERSION } from "./meta.js";
import { makeResourcesProvider } from "./resources/registry.js";
import { devModeEnabled, makeAppRegistry } from "./tools/registry.js";

export async function runMcpServer(): Promise<void> {
  // Brand the log directory so different tools' logs don't collide.
  const slug = APP_NAME.replace(/^@[^/]+\//, "");
  setLogFilePrefix(slug);

  const includeDevOnly = devModeEnabled();
  const registry = makeAppRegistry();

  const resourcesEnabled = process.env.MCP_DISABLE_RESOURCES !== "1";
  const server = new Server(
    { name: APP_NAME, version: APP_VERSION },
    { capabilities: { tools: {}, ...(resourcesEnabled ? { resources: {} } : {}) } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.toMcpTools(includeDevOnly),
  }));

  const dispatch = getDispatcher();
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const result = await dispatch(name, args ?? {}, extra?.signal);
    return result;
  });

  if (resourcesEnabled) {
    const { onList, onListTemplates, onRead } = buildResourcesHandler({
      provider: makeResourcesProvider(),
    });
    server.setRequestHandler(ListResourcesRequestSchema, onList);
    server.setRequestHandler(ListResourceTemplatesRequestSchema, onListTemplates);
    server.setRequestHandler(ReadResourceRequestSchema, onRead);
  }

  await startStdio({ server, entrypoint: APP_NAME });
}

// Run when invoked directly (stress harness, manual node invocation).
// The bin (dist/cli.js) goes through cli.ts and never trips this branch.
//
// THE SAME WINDOWS BUG cli.ts's isEntryPoint FIXED (#64), in its second home:
// process.argv[1] uses backslashes on Windows, so an unnormalized
// endsWith("/src/index.ts") was false there — the module loaded as a library
// and exited 0 instead of serving. The stress harness's child died cleanly at
// import time, which its phantom-pass bug (fixed alongside this) then hid.
export function isDirectInvocation(argv1: string | undefined): boolean {
  const arg = (argv1 ?? "").replace(/\\/g, "/");
  return arg.endsWith("/dist/index.js") || arg.endsWith("/src/index.ts");
}

const isMain = (() => {
  try {
    return isDirectInvocation(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMain) {
  runMcpServer().catch((err) => {
    process.stderr.write(`${APP_NAME}: ${(err as Error).message}\n`);
    process.exit(1);
  });
}

export { callMcpTool } from "./dispatcher.js";

// Suppress unused-import warning while keeping the env helper available
// for tools that read MCP_DEV etc. before main runs.
void envBool;
