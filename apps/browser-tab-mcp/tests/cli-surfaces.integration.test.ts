/**
 * The ten CLI-only surfaces, driven as REAL PROCESSES.
 *
 * These cross a process boundary but involve no browser, so per the decision
 * tree in AGENTS.md they are integration tests, not e2e. `docs/surfaces/
 * effect-coverage.json` calls this tier `cli-process`.
 *
 * WHAT WAS TRUE BEFORE THIS FILE. Five of these surfaces had NO behavioural
 * test of any kind — `daemon uninstall`, `daemon stop`, `daemon restart` and
 * `repl`/`console` were name-existence checks in a contract test and nothing
 * else. Three more (`daemon run`, `daemon status`, `daemon token`) were
 * executed for real, but only as harness plumbing to get a daemon up: nothing
 * ever asserted their own contract. And `mcp`'s target function is thoroughly
 * tested over a real stdio transport by the stress harness — which spawns
 * `src/index.ts` DIRECTLY, so the commander wiring for the subcommand itself
 * was driven by nothing.
 *
 * THE LIFECYCLE VERBS ARE DRIVEN, NOT SKIPPED. `daemon install` on a
 * developer's Mac would register a real LaunchAgent, which is not something a
 * test suite may do. `BROWSER_TAB_PLATFORM` (see `src/platform.ts`, which
 * exists so every branch is reachable from one machine) forces the
 * unsupported-platform branch, where `serviceManager()` refuses with an
 * instruction. Asserting that refusal proves the subcommand routes to
 * `serviceManager()` and surfaces its answer — the untested wiring. The real
 * install path is macos-local and opt-in.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defaultIpcEndpoint } from "@george43g/test-kit";
import { afterAll, describe, expect, it } from "vitest";
import { makeAppRegistry } from "../src/tools/registry.js";

const execFileP = promisify(execFile);
const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(APP, "dist", "cli.js");

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** A private state/cache/socket world, so nothing can reach a real daemon. */
function isolated(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "bt-cli-"));
  scratch.push(dir);
  return {
    ...process.env,
    BROWSER_TAB_STATE_DIR: join(dir, "state"),
    BROWSER_TAB_CACHE_DIR: join(dir, "cache"),
    MCP_LOG_DIR: join(dir, "logs"),
    // Never the per-user default: a developer's own daemon would answer
    // instead (measured on the Windows box, 2026-08-22).
    BROWSER_TAB_SOCKET_PATH: defaultIpcEndpoint(dir),
    BROWSER_TAB_FAKE_ADAPTER: "1",
    ...extra,
  };
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the built bin and report BOTH the exit code and the output. */
async function run(args: string[], env: NodeJS.ProcessEnv, stdin?: string): Promise<Run> {
  return await new Promise<Run>((resolveRun) => {
    const child = spawn("node", [CLI, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => resolveRun({ code: code ?? -1, stdout, stderr }));
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

describe("mcp (CLI-only)", () => {
  it("speaks JSON-RPC over stdio and lists exactly the registry's tools", async () => {
    // First coverage of `runMcpServer` THROUGH THE SUBCOMMAND. The stress
    // harness spawns src/index.ts directly, so a broken `.action()` here would
    // not have shown up anywhere.
    const env = isolated({ MCP_DEV: "" });
    const child: ChildProcess = spawn("node", [CLI, "mcp"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    const responses: Array<Record<string, unknown>> = [];
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      for (const line of buf.split("\n").slice(0, -1)) {
        if (line.trim()) responses.push(JSON.parse(line) as Record<string, unknown>);
      }
      buf = buf.slice(buf.lastIndexOf("\n") + 1);
    });

    const send = (msg: unknown): void => {
      child.stdin?.write(`${JSON.stringify(msg)}\n`);
    };
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "cli-surfaces-test", version: "0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    const listed = await new Promise<string[]>((resolveList, rejectList) => {
      const timer = setTimeout(() => rejectList(new Error("tools/list never answered")), 20_000);
      const poll = setInterval(() => {
        const hit = responses.find((r) => r.id === 2);
        if (!hit) return;
        clearInterval(poll);
        clearTimeout(timer);
        const result = hit.result as { tools?: Array<{ name: string }> };
        resolveList((result.tools ?? []).map((t) => t.name));
      }, 100);
    }).finally(() => {
      child.kill("SIGTERM");
    });

    // CANARY FIRST. Both sides of the comparison below read the same
    // registry, so it proves the SUBCOMMAND serves what the registry holds —
    // not that the registry is right (that is
    // surface-coverage.contract.test.ts's job). Two empty lists would compare
    // equal and pass, which is the failure mode of every test shaped like
    // this one, so the floor is asserted before the equality.
    expect(listed.length, "tools/list returned a real catalog").toBeGreaterThan(10);

    // devOnly tools are hidden from tools/list without MCP_DEV, so compare
    // against the same filter the server applies rather than the raw list.
    const expected = makeAppRegistry()
      .tools.filter((t) => !t.devOnly)
      .map((t) => t.name)
      .sort();
    expect(listed.sort()).toEqual(expected);
  }, 30_000);
});

describe("tui (CLI-only)", () => {
  it("refuses to launch without a TTY, with a reason and a non-zero exit", async () => {
    // The branch has no test today; the App component's own tests never go
    // through the CLI action at all. Stdio is piped here, so `isInteractive()`
    // is false exactly as it would be under `browser-tab tui | cat`.
    const r = await run(["tui"], isolated());
    expect(r.code, "a refusal must not look like success").toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(/not a TTY/i);
  }, 30_000);
});

describe("repl / console (CLI-only)", () => {
  // BOTH SPELLINGS, deliberately. Commander reports an alias as a name, so
  // `cliCommandNames()` lists `console` and a parity test sees it as present —
  // but "registered" is not "reachable", and only driving it proves the alias
  // resolves to the same action.
  for (const spelling of ["repl", "console"]) {
    it(`${spelling} runs a tool from piped stdin`, async () => {
      // Piped stdin takes cli-kit's `terminal:false` branch.
      const r = await run([spelling], isolated(), "noop hello\nquit\n");
      expect(r.code).toBe(0);
      const out = `${r.stdout}${r.stderr}`;
      expect(out, "the tool really ran and echoed through the dispatcher").toContain('"echo"');
      expect(out).toContain("hello");
    }, 30_000);
  }

  it("help lists the REPL's own shortcuts", async () => {
    const r = await run(["repl"], isolated(), "help\nquit\n");
    expect(r.stdout).toMatch(/tools\s+List MCP tools/);
    expect(r.stdout, "and the tool shortcuts it registers").toMatch(/noop/);
  }, 30_000);
});

describe("doctor (CLI-only)", () => {
  it("emits a report, and the exit code tracks the verdict", async () => {
    // `checkLocalAccess()` and the action itself are invoked by no test today
    // — only `buildReport`/`formatAccessReport` are, directly.
    const r = await run(["doctor"], isolated());
    const out = `${r.stdout}${r.stderr}`;
    expect(out, "a report, not a stack trace").toMatch(/Doctor:/);
    expect(out, "with per-check lines").toMatch(/Node v\d+/);
    // The verdict and the exit code must agree. Asserting the LINK rather than
    // a fixed code keeps this honest on a machine where a check legitimately
    // fails (no Automation TCC, no native module).
    const allClear = /Doctor: all clear/.test(out);
    expect(r.code, `exit code must match the headline (allClear=${allClear})`).toBe(
      allClear ? 0 : 1,
    );
  }, 60_000);
});

describe("daemon token / status (CLI-only)", () => {
  it("token prints a token and is idempotent", async () => {
    const env = isolated();
    const first = await run(["daemon", "token"], env);
    expect(first.code).toBe(0);
    const token = first.stdout.trim();
    expect(token, "a real token, not an empty line").toMatch(/^[0-9a-f]{32,}$/);

    const second = await run(["daemon", "token"], env);
    expect(second.stdout.trim(), "a second call must not rotate it — the extension holds it").toBe(
      token,
    );
  }, 30_000);

  it("status exits non-zero and says so when the daemon is down", async () => {
    const r = await run(["daemon", "status", "--json"], isolated());
    expect(r.code, "unreachable is a failure, not a quiet success").toBe(1);
    expect(JSON.parse(r.stdout).reachable).toBe(false);
  }, 30_000);
});

describe("daemon run (CLI-only)", () => {
  it("becomes reachable, reports its own pid, and exits cleanly on SIGTERM", async () => {
    // Really executed today by two harnesses, asserted by neither.
    const env = isolated();
    const proc = spawn("node", [CLI, "daemon", "run"], { env, stdio: "ignore" });
    try {
      let status: Record<string, unknown> | null = null;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const r = await run(["daemon", "status", "--json"], env);
        const parsed = JSON.parse(r.stdout || "{}") as Record<string, unknown>;
        if (parsed.reachable === true) {
          status = parsed;
          break;
        }
        await new Promise((r2) => setTimeout(r2, 250));
      }
      expect(status, "the daemon became reachable within 20s").not.toBeNull();
      expect(status?.pid, "and it is the process we spawned, not a stray one").toBe(proc.pid);
      expect(Number(status?.uptimeS ?? -1)).toBeGreaterThanOrEqual(0);

      // SHUTDOWN IS PLATFORM-SHAPED, and this is settled rather than open.
      // win32 has no catchable SIGTERM: Node terminates the process abruptly
      // and the exit event reports `code: null` with a signal, so "exits 0"
      // is not a thing that can happen there. The stress harness already
      // encodes exactly this split (case 7: SIGTERM on POSIX, stdin EOF on
      // win32; case 13: POSIX asserts exit-0 + socket unlink, win32 asserts
      // prompt termination). This mirrors it rather than inventing a second
      // opinion — and CI is what caught the first draft asserting 0
      // everywhere.
      const exited = await new Promise<{ code: number | null; timedOut: boolean }>(
        (resolveExit) => {
          const timer = setTimeout(() => resolveExit({ code: null, timedOut: true }), 10_000);
          proc.on("exit", (code) => {
            clearTimeout(timer);
            resolveExit({ code, timedOut: false });
          });
          proc.kill("SIGTERM");
        },
      );
      expect(exited.timedOut, "the daemon must terminate promptly on SIGTERM").toBe(false);
      if (process.platform !== "win32") {
        expect(exited.code, "on POSIX, SIGTERM is a clean shutdown — not a kill").toBe(0);
      }
    } finally {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }
  }, 60_000);
});

describe("daemon install / uninstall / stop / restart (CLI-only)", () => {
  // Driven with the platform forced to one with no service integration, so no
  // LaunchAgent is ever registered on the machine running the suite. What is
  // proven is the wiring: the subcommand reaches `serviceManager()` and
  // surfaces its answer instead of throwing an errno.
  const forced = (): NodeJS.ProcessEnv => isolated({ BROWSER_TAB_PLATFORM: "linux" });

  for (const verb of ["install", "uninstall", "stop", "restart"]) {
    it(`${verb} surfaces the service manager's refusal, non-zero`, async () => {
      const r = await run(["daemon", verb], forced());
      const out = `${r.stdout}${r.stderr}`;
      expect(r.code, "an unusable verb must not exit 0").not.toBe(0);
      expect(out, "names the platform").toMatch(/linux/);
      expect(out, "and gives the actionable alternative").toMatch(/daemon run/);
    }, 30_000);
  }

  it("stop and uninstall share a body DELIBERATELY — test by name, do not 'fix' it", async () => {
    // `stop`'s own description says why: it "deregisters it — a plain kill
    // gets resurrected", because under KeepAlive a plain kill is undone. The
    // shared body is the point, and `daemon stop` really does print the
    // uninstall wording. Pinned so the duplication is not tidied away by
    // someone who reads it as a copy-paste slip.
    const stop = await run(["daemon", "stop"], forced());
    const uninstall = await run(["daemon", "uninstall"], forced());
    expect(`${stop.stdout}${stop.stderr}`).toBe(`${uninstall.stdout}${uninstall.stderr}`);
  }, 30_000);
});

describe("reload-extension (CLI-only, no-daemon path)", () => {
  it("errors clearly when no daemon is running", async () => {
    // The success path is chromium-e2e; this is the half that needs no
    // browser, and it was part of the surface's true-zero coverage.
    const r = await run(["reload-extension", "--browser", "chrome"], isolated());
    expect(r.code).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/daemon/i);
  }, 30_000);
});
