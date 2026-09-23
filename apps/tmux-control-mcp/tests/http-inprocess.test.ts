/**
 * `runHttpMcp` driven in-process.
 *
 * Its sibling `http-lifecycle.test.ts` spawns real children, because signals
 * and exit statuses do not exist in-process. The cost is that a child process
 * is invisible to v8 coverage, so `src/commands/http.ts` measured 0% while
 * being one of the more heavily exercised files in the app — and every comment
 * added to it dragged the whole app's coverage down.
 *
 * This file closes that gap by calling the function directly. It deliberately
 * installs the real shutdown handlers and the real watchdog (that wiring is
 * what is under test), so it lives in its own file: vitest isolates per file,
 * and process-level handlers should not leak into anyone else's worker.
 */

import { clearLogs, getLogs } from "@george43g/robustness";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyHttpEnvFromOpts,
  httpRequested,
  makeShutdownMarker,
  observeOnly,
  registerHttpCommand,
  runHttpMcp,
} from "../src/commands/http.js";

const ENV_KEY = "MCP_HTTP_TOKEN";
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV_KEY];
  process.env[ENV_KEY] = "in-process-test-token";
});

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

function newServer(): McpServer {
  return new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
}

describe("runHttpMcp", () => {
  it("returns a live handle and traps signals so its cleanup is reachable", async () => {
    // Captured before the first call, and asserted inside it: the two facts
    // have to be checked together, because `installShutdownHandlers` merges
    // rather than stacks — a second call adds no listener, so the delta is
    // observable exactly once per worker. Splitting this into two tests made
    // the second one fail against correct code.
    const sigtermBefore = process.listenerCount("SIGTERM");

    const handle = await runHttpMcp({ server: newServer(), port: 0, bind: "127.0.0.1" });
    try {
      expect(handle.port).toBeGreaterThan(0);
      const res = await fetch(`${handle.url}/health`);
      await res.text();
      expect(res.status).toBe(200);

      // The bug this path had for its whole life: a registered cleanup with
      // nothing to run it. A trap on SIGTERM is what makes it reachable.
      expect(process.listenerCount("SIGTERM")).toBeGreaterThan(sigtermBefore);
    } finally {
      await handle.close();
    }

    // Closed for real, not merely dereferenced.
    await expect(fetch(`${handle.url}/health`)).rejects.toThrow();
  }, 30_000);

  it("refuses to start without a bearer token, and says how to fix it", async () => {
    const savedToken = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    try {
      // The secret chain resolves to null and the transport owns the message,
      // so there is exactly one place that explains the fix.
      await expect(runHttpMcp({ server: newServer(), port: 0, bind: "127.0.0.1" })).rejects.toThrow(
        /requires a non-empty bearer token/,
      );
    } finally {
      if (savedToken === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = savedToken;
    }
  }, 30_000);

  it("falls back to MCP_HTTP_PORT/MCP_HTTP_BIND when no overrides are passed", async () => {
    const savedPort = process.env.MCP_HTTP_PORT;
    const savedBind = process.env.MCP_HTTP_BIND;
    process.env.MCP_HTTP_PORT = "0"; // ephemeral
    process.env.MCP_HTTP_BIND = "127.0.0.1";
    try {
      const handle = await runHttpMcp({ server: newServer() });
      try {
        expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      } finally {
        await handle.close();
      }
    } finally {
      if (savedPort === undefined) delete process.env.MCP_HTTP_PORT;
      else process.env.MCP_HTTP_PORT = savedPort;
      if (savedBind === undefined) delete process.env.MCP_HTTP_BIND;
      else process.env.MCP_HTTP_BIND = savedBind;
    }
  }, 30_000);

  it("is safe to start a second time — the handlers merge, they do not stack", async () => {
    const sigtermBefore = process.listenerCount("SIGTERM");
    const handle = await runHttpMcp({ server: newServer(), port: 0, bind: "127.0.0.1" });
    try {
      expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
      const res = await fetch(`${handle.url}/health`);
      await res.text();
      expect(res.status).toBe(200);
    } finally {
      await handle.close();
    }
  }, 30_000);
});

/**
 * The three small exported helpers `src/cli.ts` uses to route into HTTP. They
 * are pre-existing and correct — these cases pass on first run and are here for
 * coverage, not because anything was broken. They were the last uninstrumented
 * functions in the file.
 */
describe("http command wiring", () => {
  it("attaches --http/--port/--bind to a subcommand", () => {
    const cmd = new Command("mcp");
    registerHttpCommand(cmd);
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toEqual(expect.arrayContaining(["--http", "--port", "--bind"]));
  });

  it("reads --http from commander opts and from the legacy positional argv", () => {
    expect(httpRequested({ http: true })).toBe(true);
    expect(httpRequested({})).toBe(false);

    const savedArgv = [...process.argv];
    process.argv.push("--http");
    try {
      expect(httpRequested({})).toBe(true);
    } finally {
      process.argv = savedArgv;
    }
  });

  it("writes only the env knobs it was actually given", () => {
    const savedPort = process.env.MCP_HTTP_PORT;
    const savedBind = process.env.MCP_HTTP_BIND;
    delete process.env.MCP_HTTP_PORT;
    delete process.env.MCP_HTTP_BIND;
    try {
      applyHttpEnvFromOpts({});
      expect(process.env.MCP_HTTP_PORT).toBeUndefined();
      expect(process.env.MCP_HTTP_BIND).toBeUndefined();

      applyHttpEnvFromOpts({ port: "9999", bind: "0.0.0.0" });
      expect(process.env.MCP_HTTP_PORT).toBe("9999");
      expect(process.env.MCP_HTTP_BIND).toBe("0.0.0.0");
    } finally {
      if (savedPort === undefined) delete process.env.MCP_HTTP_PORT;
      else process.env.MCP_HTTP_PORT = savedPort;
      if (savedBind === undefined) delete process.env.MCP_HTTP_BIND;
      else process.env.MCP_HTTP_BIND = savedBind;
    }
  });
});

describe("shutdown marker", () => {
  it("writes once however many times the registry sweeps it", () => {
    clearLogs();
    const marker = makeShutdownMarker();

    // The exact double-invocation the guard exists for: the controller's exit
    // listener sweeps the whole registry synchronously, so a cleanup the async
    // pass already ran fires a second time when a later one hangs.
    marker();
    marker();
    marker();

    // getLogs() is the human-readable ring ("<ts> [info] shutdown {...}"), not
    // the NDJSON that goes to the file — only the file sink serialises entries.
    const shutdownLines = getLogs().filter((l) => /\[info\] shutdown \{/.test(l));
    expect(shutdownLines).toHaveLength(1);
  });
});

describe("breach policy", () => {
  it("never returns kill — the one constraint this path cannot relax", () => {
    // `runHttpMcp` hands this to installWatchdog. If it ever returns "kill",
    // a shared HTTP server starts self-terminating on load spikes.
    expect(observeOnly()).toBe("observe");
    expect(observeOnly()).not.toBe("kill");
  });
});
