/**
 * The HTTP transport's process lifecycle, in a real child process.
 *
 * The stdio path has wired `installShutdownHandlers()` since it was written;
 * the HTTP path never did. `runHttpMcp` registered `handle.close()` as a
 * cleanup and then nothing ever trapped a signal to run the registry, so a
 * `SIGTERM` — how every supervisor, container runtime and `pnpm` stops a
 * server — killed the process outright: in-flight requests dropped, no
 * `shutdown` marker written, and the log looking exactly like a crash to the
 * rule the generated AGENTS.md states ("file without `shutdown` = crash").
 *
 * This has to be a child process. The contract under test is what the OS does
 * with a signal and what exit status the process reaches, and neither exists
 * in-process: `shutdown()` returns `Promise<never>` because it calls
 * `process.exit`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * The child is `node --import tsx src/index.ts`, NEVER `node_modules/.bin/tsx`.
 *
 * The tsx CLI does not run your code — it spawns a GRANDCHILD and relays
 * signals to it, on a 30ms budget (tsx 4.23.1, `dist/cli.mjs`,
 * `relaySignalToChild`): forward the signal, wait 30ms for the child to report
 * over IPC that it arrived, and if that report is late, `kill("SIGKILL")` and
 * `process.exit(128 + signum)`.
 *
 * SIGKILL cannot be trapped, so the app's handlers never run — no cleanup, no
 * marker, nothing. The report is late exactly when the child's event loop is
 * busy, which is the normal state of a loaded CI runner and never the state of
 * an idle laptop. Measured against a 12-line script that traps SIGTERM and
 * writes a file:
 *
 *     child event loop idle   → wrapper exit code=0   signal=null · handler ran
 *     child event loop busy   → wrapper exit code=143 signal=null · handler DID NOT run
 *
 * The second row is byte-identical to the macOS CI failure this test produced
 * for three runs, through two "fixes" that both left tsx in the signal path:
 * first asserting a different thing about the wrapper, then polling 15s for a
 * marker that a SIGKILLed process was never going to write. `--import` runs
 * the loader in ONE process, so `child` IS the app and the signal reaches it.
 *
 * Same reasoning applies to `scripts/stress-mcp.ts`; keep the two in step.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const APP_DIR = resolve(import.meta.dirname, "..");
/**
 * tsx's own `.` export (`dist/loader.mjs`), resolved absolutely so the spawn
 * does not depend on the child's cwd, and via the export map so it does not
 * depend on tsx's internal layout.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

interface HttpChild {
  child: ReturnType<typeof spawn>;
  url: string;
  stderr: () => string;
}

/** Boot `src/index.ts --http` on an ephemeral port and wait for its banner. */
async function startHttpChild(
  logDir: string,
  extraEnv: Record<string, string> = {},
): Promise<HttpChild> {
  const child = spawn(process.execPath, ["--import", TSX_LOADER, "src/index.ts", "--http"], {
    cwd: APP_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NO_COLOR: "1",
      CI: "1",
      MCP_HTTP_TOKEN: "http-lifecycle-test-token",
      MCP_HTTP_PORT: "0", // ephemeral — never collide with a developer's 8080
      MCP_HTTP_BIND: "127.0.0.1",
      MCP_LOG_DIR: logDir,
      ...extraEnv,
    },
  });

  let err = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString();
  });

  const url = await new Promise<string>((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => {
      rejectUrl(new Error(`no listening banner within 30s. stderr:\n${err}`));
    }, 30_000);
    const poll = setInterval(() => {
      const match = err.match(/MCP HTTP listening on (http:\/\/\S+)/);
      if (!match?.[1]) return;
      clearInterval(poll);
      clearTimeout(timer);
      resolveUrl(match[1]);
    }, 50);
    child.once("exit", (code, signal) => {
      clearInterval(poll);
      clearTimeout(timer);
      rejectUrl(new Error(`exited early (code=${code} signal=${signal}). stderr:\n${err}`));
    });
    child.once("error", rejectUrl);
  });

  return { child, url, stderr: () => err };
}

interface LogEntry {
  msg: string;
  /**
   * Diagnostic payload. `reason` is the cause `getShutdownCause()` recorded on
   * `shutdown`; watchdog events carry their own keys (`threshold_mb`, ...),
   * hence the open record alongside the one field asserted by name.
   */
  data?: Record<string, unknown> & { reason?: string };
}

/**
 * Every NDJSON entry the child wrote, across whatever file it chose.
 *
 * Reading once — rather than polling — is sound only because `child` is the app
 * itself: the marker is written with `appendFileSync` from a cleanup, which
 * runs before `process.exit` returns, so the `exit` event we awaited is proof
 * the bytes are already on disk. Under the old tsx-wrapper spawn it was not,
 * and that is what the polling here used to paper over.
 */
async function readLogEntries(logDir: string): Promise<LogEntry[]> {
  const files = (await readdir(logDir)).filter((f) => f.endsWith(".ndjson"));
  const entries: LogEntry[] = [];
  for (const file of files) {
    const raw = await readFile(join(logDir, file), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      entries.push(JSON.parse(line) as LogEntry);
    }
  }
  return entries;
}

/** Resolve when the child exits, or reject after `timeoutMs`. */
function exitOf(
  child: ReturnType<typeof spawn>,
  stderr: () => string,
  timeoutMs = 20_000,
): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(
      () => rejectExit(new Error(`no exit within ${timeoutMs}ms. stderr:\n${stderr()}`)),
      timeoutMs,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

describe("http transport lifecycle", () => {
  it("traps SIGTERM and exits gracefully instead of being killed by it", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "http-lifecycle-"));
    const { child, url, stderr } = await startHttpChild(logDir);

    try {
      // The server really is serving before we signal it.
      const health = await fetch(`${url}/health`);
      await health.text();
      expect(health.status).toBe(200);

      const exited = exitOf(child, stderr);
      child.kill("SIGTERM");
      const result = await exited;

      // Two independent assertions, because they fail for different reasons.
      //
      // `signal === null` is the one that names this test: a process killed by
      // an untrapped SIGTERM reports `signal: "SIGTERM", code: null`, and one
      // that trapped it and chose to leave reports `code: 0, signal: null`.
      // This is only meaningful because `child` is the app — asserted against
      // the tsx wrapper it measured the wrapper's teardown instead, which is
      // how it came to report `expected 143 to be +0` for a correctly behaving
      // server.
      expect(
        { code: result.code, signal: result.signal },
        `expected a graceful self-exit. stderr:\n${stderr()}`,
      ).toEqual({ code: 0, signal: null });

      // And the cause was recorded, which no exit code can show: the marker
      // must name the signal, not a hardcoded literal.
      const entries = await readLogEntries(logDir);
      const shutdown = entries.find((e) => e.msg === "shutdown");
      expect(shutdown, `no shutdown marker. stderr:\n${stderr()}`).toBeDefined();
      expect(shutdown?.data?.reason).toBe("signal:SIGTERM");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 60_000);

  it("writes startup and shutdown markers, so a clean stop is not read as a crash", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "http-lifecycle-"));
    const { child, stderr } = await startHttpChild(logDir);

    try {
      const exited = exitOf(child, stderr);
      child.kill("SIGTERM");
      await exited;

      const messages = (await readLogEntries(logDir)).map((e) => e.msg);
      expect(messages).toContain("startup");
      expect(messages).toContain("shutdown");
      // Write-once: the controller's exit listener sweeps the cleanup registry
      // synchronously, so a guard is the only thing keeping this at one.
      expect(messages.filter((m) => m === "shutdown")).toHaveLength(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 60_000);

  /**
   * `MCP_MAX_RSS_MB=50` is the exact knob stress case #8 uses to make the
   * **stdio** server self-kill (`code=1`). HTTP must do the opposite with the
   * same input: notice, say so, and keep serving.
   */
  it("detects an RSS breach and logs it without ever killing the server", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "http-observe-"));
    const { child, url, stderr } = await startHttpChild(logDir, {
      MCP_MAX_RSS_MB: "50", // any real node process is over this
      MCP_MEMORY_SAMPLE_MS: "300", // don't wait out the 60s default
    });

    try {
      // Three sample windows' worth, so a breach that only fires once would
      // still be caught and a kill would have had ample time to land.
      await new Promise((r) => setTimeout(r, 2_000));

      const entries = await readLogEntries(logDir);
      const messages = entries.map((e) => e.msg);

      // The watchdog is running at all — this is what the HTTP path lacked.
      expect(messages).toContain("watchdog_installed");
      // …and it saw the breach.
      const observed = entries.filter((e) =>
        e.msg.startsWith("watchdog_breach_observed: rss_exceeded"),
      );
      expect(observed.length).toBeGreaterThan(0);
      expect(observed[0]?.data).toMatchObject({ threshold_mb: 50 });

      // The whole point: detection without enforcement. No kill marker, and
      // the server is still answering.
      expect(messages.some((m) => m.startsWith("watchdog_kill"))).toBe(false);
      expect(child.exitCode).toBeNull();
      const health = await fetch(`${url}/health`);
      await health.text();
      expect(health.status).toBe(200);

      // Still exits cleanly afterwards — observing must not wedge shutdown.
      // `code: 0, signal: null` is a real assertion here only because the
      // child is the app rather than a tsx wrapper; see the header comment.
      const exited = exitOf(child, stderr);
      child.kill("SIGTERM");
      const result = await exited;
      expect({ code: result.code, signal: result.signal }).toEqual({ code: 0, signal: null });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 60_000);
});
