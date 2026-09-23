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

import { type HttpServerHandle, startHttpServer } from "@george43g/mcp-kit";
import {
  envNum,
  envStr,
  getShutdownCause,
  installShutdownHandlers,
  installWatchdog,
  logShutdown,
  logStartup,
  registerCleanup,
  type WatchdogBreachVerdict,
} from "@george43g/robustness";
import { resolveSecret } from "@george43g/secret-store";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Command } from "commander";
import { getCounters } from "../counters.js";
import { APP_NAME } from "../meta.js";

export interface RunHttpMcpOptions {
  server: Server;
  port?: number;
  bind?: string;
}

/**
 * Resolve the bearer token through the secret chain: `MCP_HTTP_TOKEN` in the
 * environment first, then a project `.env`, then the OS keychain, then an
 * external secret manager if one is configured.
 *
 * `varName({ toolPrefix: "mcp", name: "http_token" })` is exactly
 * `MCP_HTTP_TOKEN`, and env is the first link in the chain — so an exported
 * env var behaves identically to before. The rest of the chain only adds
 * places to find it when that var is absent.
 *
 * Returns null when nothing resolves; the transport owns the error message,
 * so there is one place that explains how to fix it.
 */
async function resolveHttpToken(): Promise<string | null> {
  const found = await resolveSecret({ toolPrefix: "mcp", name: "http_token" });
  return found?.value ?? null;
}

/**
 * Start the MCP server over Streamable HTTP.
 *
 * Returns as soon as the listener is up and the lifecycle is wired — NOT when
 * the server closes, which is what this comment used to claim. The process
 * stays alive because the listener holds the event loop, and it stops when a
 * signal reaches the handlers installed below.
 *
 * The handle is returned so a caller can close the server without going
 * through a process-wide `shutdown()`. `src/index.ts` ignores it; the
 * in-process tests need it, and without it this file could only ever be
 * exercised from a child process, i.e. never measured by coverage.
 */
export async function runHttpMcp(opts: RunHttpMcpOptions): Promise<HttpServerHandle> {
  const port = opts.port ?? envNum("MCP_HTTP_PORT", 8080);
  const bind = opts.bind ?? envStr("MCP_HTTP_BIND", "127.0.0.1");
  const token = await resolveHttpToken();

  // Nothing trapped a signal on this path until now, so the `registerCleanup`
  // below could never run: SIGTERM — how every supervisor, container runtime
  // and `pnpm` stops a server — terminated the process outright at status 143,
  // dropping in-flight requests and leaving the listener to the OS. Installed
  // before `startHttpServer` so a signal arriving mid-bind still finds a
  // handler.
  installShutdownHandlers();

  // Detection without enforcement.
  //
  // An HTTP server is shared, so it must not self-kill the way stdio does —
  // the restart decision belongs to whatever supervises it. That reasoning is
  // unchanged; what changed is that it used to cost the *detection* too, so a
  // wedged event loop or a leaking heap left no trace at all. `onBreach` (added
  // in robustness 0.9.0) separates the two: the watchdog samples and logs
  // exactly as it does on stdio, and only the kill is withheld.
  //
  // ─── TO ENABLE THE KILL: delete the `onBreach` line below. ───────────────
  // The watchdog then behaves as it does on stdio — `watchdog_kill: <reason>`,
  // a 5s force-exit net, then shutdown(1). Do that only if something will
  // restart the process afterwards.
  //
  // Every breaching sample logs `watchdog_breach_observed: <reason>` at warn.
  // See the README's "Process markers" section for the cadence and the knobs
  // that quieten it.
  installWatchdog({ onBreach: observeOnly });

  const handle = await startHttpServer({
    server: opts.server,
    port,
    bind,
    // Conditional spread, not `token: token ?? undefined`: this repo runs
    // exactOptionalPropertyTypes, so an explicit undefined is a type error.
    ...(token === null ? {} : { token }),
    getCounters,
  });
  registerCleanup(() => handle.close());

  // After the bind, not before: this line means "serving", so a failed bind
  // leaves no startup marker to contradict.
  logStartup(APP_NAME);

  // Its counterpart, without which every clean HTTP exit reads as a crash to
  // the rule the generated AGENTS.md states ("file without `shutdown` =
  // crash"). Registered LAST and guarded, for the two independent reasons
  // measured in `packages/mcp-kit/src/transports/stdio.ts`: the controller's
  // exit listener sweeps the whole registry synchronously, so a cleanup the
  // async pass already ran executes twice when a later one hangs; and "last"
  // is not a position you can hold, because anything registering a cleanup at
  // runtime lands after this one.
  registerCleanup(makeShutdownMarker());

  return handle;
}

/**
 * The write-once shutdown marker, as a factory rather than an inline closure.
 *
 * Extracted so the guard is directly testable: a cleanup only ever runs during
 * a real process shutdown, so inline it could be proven only by spawning a
 * child and counting lines afterwards. The guard is the part that was measured
 * to matter — `stdio.ts` records 2 lines unguarded vs 1 guarded — so it earns a
 * test that calls it twice and asserts once.
 */
export function makeShutdownMarker(): () => void {
  let written = false;
  return () => {
    if (written) return;
    written = true;
    logShutdown(getShutdownCause());
  };
}

/**
 * This path's breach policy: detect and log, never kill.
 *
 * A named export rather than an inline arrow so the one constraint that is not
 * negotiable here — an HTTP server must not self-kill — is a single assertable
 * function instead of a behaviour you can only observe by running a server for
 * two seconds and watching it not die.
 */
export function observeOnly(): WatchdogBreachVerdict {
  return "observe";
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
