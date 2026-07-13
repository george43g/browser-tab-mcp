/**
 * HTTP transport — Streamable HTTP server (bearer-auth, /health, /mcp).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ DELETE THIS FILE to drop HTTP support entirely. After deleting, also:    │
 * │   1. Remove the `registerHttpCommand(program)` call in `src/cli.ts`.     │
 * │   2. Remove the `import` of this module from `src/cli.ts`.               │
 * │   3. Remove the `MCP_HTTP_TOKEN`/`MCP_HTTP_PORT`/`MCP_HTTP_BIND` entries │
 * │      from `.env.example`.                                                │
 * │   4. Drop stress case #9 (HTTP roundtrip) from `scripts/stress-mcp.ts`. │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * The `runHttpMcp()` function below is the real wiring; the small commander
 * registrar at the bottom (`registerHttpCommand`) attaches it as the `--http`
 * branch of the `mcp` subcommand. Keeping these in the same file makes
 * deletion a single-file change.
 */

import { startHttpServer } from "@george43g/mcp-kit";
import { envNum, envStr, registerCleanup } from "@george43g/robustness";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Command } from "commander";
import { getCounters } from "../counters.js";

export interface RunHttpMcpOptions {
  server: Server;
  port?: number;
  bind?: string;
}

/** Start the MCP server over Streamable HTTP. Returns once the server closes. */
export async function runHttpMcp(opts: RunHttpMcpOptions): Promise<void> {
  const port = opts.port ?? envNum("MCP_HTTP_PORT", 8080);
  const bind = opts.bind ?? envStr("MCP_HTTP_BIND", "127.0.0.1");
  const handle = await startHttpServer({
    server: opts.server,
    port,
    bind,
    getCounters,
  });
  registerCleanup(() => handle.close());
}

/**
 * Attach `--http`/`--port`/`--bind` options + the http transport branch to
 * the `mcp` subcommand. Called once from `src/cli.ts`. Removing HTTP =
 * deleting this whole file + the one call site.
 */
export function registerHttpCommand(mcpSubcmd: Command): void {
  mcpSubcmd
    .option("--http", "Use Streamable HTTP transport (requires MCP_HTTP_TOKEN)")
    .option("--port <port>", "HTTP port (default 8080; env MCP_HTTP_PORT)")
    .option("--bind <host>", "HTTP bind addr (default 127.0.0.1; env MCP_HTTP_BIND)");
}

/**
 * Predicate so cli.ts can branch without knowing about HTTP internals.
 * Reads commander opts + the legacy positional `--http` flag.
 */
export function httpRequested(opts: { http?: boolean }): boolean {
  return opts.http === true || process.argv.includes("--http");
}

/** Surface port/bind overrides to runMcpServer via env (the canonical knob path). */
export function applyHttpEnvFromOpts(opts: { port?: string; bind?: string }): void {
  if (opts.port) process.env.MCP_HTTP_PORT = String(opts.port);
  if (opts.bind) process.env.MCP_HTTP_BIND = String(opts.bind);
}
