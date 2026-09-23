/**
 * MCP server entry — stdio by default, --http delegates to commands/http.ts.
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
 * To remove HTTP support: see `src/commands/http.ts` (delete-this-file header).
 * To remove the dev-only get_logs tool: drop it from src/tools/registry.ts.
 */

// MUST be first — brands the log directory at module scope, before anything
// that can log is imported. See src/log-brand.ts.
import "./log-brand.js";
import { buildResourcesHandler, startStdio } from "@george43g/mcp-kit";
import { envBool, setStderrMirror } from "@george43g/robustness";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { runHttpMcp } from "./commands/http.js";
import { getDispatcher } from "./dispatcher.js";
import { APP_NAME, APP_VERSION } from "./meta.js";
import { makeResourcesProvider } from "./resources/registry.js";
import { devModeEnabled, makeAppRegistry } from "./tools/registry.js";

export async function runMcpServer(opts: { transport?: "stdio" | "http" } = {}): Promise<void> {
  // Log branding happens at module scope via the `./log-brand.js` import above,
  // NOT here. It used to live in this function, which made it correct only by
  // current call ordering — anything that logged earlier silently won the
  // directory.
  const transport = opts.transport ?? (process.argv.includes("--http") ? "http" : "stdio");
  const includeDevOnly = devModeEnabled();
  const registry = makeAppRegistry();

  const resourcesEnabled = process.env.MCP_DISABLE_RESOURCES !== "1";
  const server = new Server(
    // Bare semver on purpose, NOT the build stamp. This is a protocol field
    // advertised to clients, not a diagnostic — a client may compare or parse
    // it, and `+build` metadata has no meaning to them. `--version` and the
    // REPL banner carry the stamp instead.
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

  if (transport === "http") {
    await runHttpMcp({ server });
  } else {
    // Mirror logs to stderr so the MCP host's connection log surfaces them.
    // stdio only: stdout is JSON-RPC, and no TUI renders in this process.
    setStderrMirror(true);
    await startStdio({ server, entrypoint: APP_NAME });
  }
}

// Run when invoked directly (stress harness, manual node invocation).
// The bin (dist/cli.js) goes through cli.ts and never trips this branch.
const isMain = (() => {
  try {
    const arg = process.argv[1] ?? "";
    return arg.endsWith("/dist/index.js") || arg.endsWith("/src/index.ts");
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
