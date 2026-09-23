#!/usr/bin/env node
/**
 * Stress harness — 15-assertion robustness suite.
 *
 * Lifted from Gmail-MCP-Server/scripts/stress-mcp.ts (~430 LOC, 9 cases),
 * generalized to use the starter's domain-agnostic tool surface
 * (health_check + noop). The HTTP case (#9) is wired up by default since
 * the starter ships HTTP support; delete it alongside removing HTTP.
 *
 * Run: `pnpm stress` — exits 0 on all-pass, 1 on any failure.
 *
 * Cases:
 *   1. handshake + tools/list returns the catalog
 *   2. health_check returns Status: healthy
 *   3. 20 parallel health_check stay healthy
 *   4. unknown tool name rejected
 *   5. malformed schema rejected with usable error
 *   6. MCP_TOOL_TIMEOUT_FORCE_MS=1 produces clean timeout
 *   7. SIGTERM exits code 0 (handler intercepted)
 *   8. MCP_MAX_RSS_MB=50 triggers watchdog kill
 *   9. shutdown marker names the real cause (SIGTERM, then stdin EOF)
 *  10. HTTP /health 200; /mcp 401 without bearer; session roundtrip with bearer
 *
 * Ten cases, 15 assertions: case 9 records one per path, and case 10 records
 * five. `EXPECTED_ASSERTIONS` below is asserted against the actual run, so the
 * count in this comment cannot drift from the harness the way it did before.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ENTRY = resolve(ROOT, "src/index.ts");

/**
 * Run the TypeScript entry in ONE process: `node --import <tsx loader> ENTRY`,
 * never `node_modules/.bin/tsx ENTRY`.
 *
 * The tsx CLI runs your code in a GRANDCHILD and relays signals to it on a 30ms
 * budget (tsx 4.23.1, `dist/cli.mjs`, `relaySignalToChild`): forward the signal,
 * wait 30ms for the child to report over IPC that it arrived, and if that report
 * is late, `kill("SIGKILL")` and `process.exit(128 + signum)`.
 *
 * Cases 7 and the SIGTERM half of the shutdown-marker case both assert on a
 * GRACEFUL exit, so both are false-failure generators through that wrapper: a
 * SIGKILLed process runs no handler and writes no marker, and the exit code the
 * harness reads is the wrapper's 143 rather than the app's 0. The report is late
 * exactly when the child's event loop is busy — the normal state of a loaded CI
 * runner, never the state of an idle laptop. Measured against a script that
 * traps SIGTERM and writes a file: idle → code 0 and the handler runs, busy →
 * code 143 and it does not.
 *
 * Resolved through tsx's `.` export so it does not depend on tsx's internal
 * layout, and absolutely so it does not depend on the child's cwd.
 * `tests/http-lifecycle.test.ts` carries the same fix; keep the two in step.
 */
const TSX_IMPORT = ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href];

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: unknown;
}
interface RpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: { content?: { type: string; text: string }[]; isError?: boolean; tools?: unknown[] };
  error?: { code: number; message: string };
}
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

class McpClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, (msg: RpcResponse) => void>();
  public stderr = "";

  constructor(env: Record<string, string> = {}) {
    this.child = spawn(process.execPath, [...TSX_IMPORT, ENTRY], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: RpcResponse;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (typeof parsed.id === "number") {
        const cb = this.pending.get(parsed.id);
        if (cb) {
          this.pending.delete(parsed.id);
          cb(parsed);
        }
      }
    }
  }

  private send(req: RpcRequest): void {
    this.child.stdin.write(`${JSON.stringify(req)}\n`);
  }

  notification(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(method: string, params?: unknown, timeoutMs = 8_000): Promise<RpcResponse> {
    const id = this.nextId++;
    return new Promise((resolveResp, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolveResp(msg);
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "stress", version: "0.0.1" },
    });
    this.notification("notifications/initialized");
  }

  pid(): number | undefined {
    return this.child.pid;
  }

  async waitExit(timeoutMs = 5_000): Promise<{ code: number | null; signal: string | null }> {
    return new Promise((resolveExit) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolveExit({ code: null, signal: "TIMEOUT" });
      }, timeoutMs);
      timer.unref();
      this.child.on("exit", (code, signal) => {
        clearTimeout(timer);
        resolveExit({ code, signal });
      });
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.child.kill(signal);
  }

  /** Close stdin without signalling — the MCP host going away. */
  closeStdin(): void {
    this.child.stdin.end();
  }
}

interface CaseResult {
  name: string;
  pass: boolean;
  detail?: string;
}
const results: CaseResult[] = [];

/**
 * How many assertions a full run records. Asserted against `results.length` at
 * the end of `main()`, and read by `scripts/check-stress-count.mjs`, which
 * fails the build when prose quotes a different number.
 *
 * NOT derivable by counting `record(` call sites: `caseShutdownMarker` records
 * twice from one loop and `caseHttpTransport` records five times, so a naive
 * grep returns 14.
 */
const EXPECTED_ASSERTIONS = 15;

function record(name: string, pass: boolean, detail?: string) {
  results.push({ name, pass, ...(detail !== undefined ? { detail } : {}) });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function readMcpResponse(res: FetchResponse): Promise<RpcResponse | null> {
  const raw = (await res.text()).trim();
  if (!raw) return null;

  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) return null;
    return JSON.parse(dataLine.slice("data:".length).trim()) as RpcResponse;
  }

  return JSON.parse(raw) as RpcResponse;
}

async function caseHandshake(): Promise<void> {
  const c = new McpClient();
  try {
    await c.initialize();
    const tools = await c.request("tools/list", {});
    const count = (tools.result?.tools as unknown[] | undefined)?.length ?? 0;
    record("handshake + tools/list", count >= 2, `${count} tools`);
  } finally {
    c.kill();
    await c.waitExit();
  }
}

async function caseHealthCheckCanary(): Promise<void> {
  const c = new McpClient();
  try {
    await c.initialize();
    const r = await c.request("tools/call", { name: "health_check", arguments: {} });
    const text = r.result?.content?.[0]?.text ?? "";
    const ok = text.includes('"status": "healthy"') || text.includes("healthy");
    record("health_check returns healthy", ok, ok ? undefined : text.slice(0, 80));
  } finally {
    c.kill();
    await c.waitExit();
  }
}

async function caseHealthUnderLoad(): Promise<void> {
  const c = new McpClient();
  try {
    await c.initialize();
    const calls = Array.from({ length: 20 }, () =>
      c.request("tools/call", { name: "health_check", arguments: {} }, 5_000),
    );
    const responses = await Promise.all(calls);
    const allOk = responses.every((r) => (r.result?.content?.[0]?.text ?? "").includes("healthy"));
    record("20 parallel health_check stay healthy", allOk);
  } finally {
    c.kill();
    await c.waitExit();
  }
}

async function caseUnknownTool(): Promise<void> {
  const c = new McpClient();
  try {
    await c.initialize();
    const r = await c.request("tools/call", { name: "ghost_tool", arguments: {} });
    const text = r.result?.content?.[0]?.text ?? "";
    record("unknown tool rejected", text.includes("Unknown tool"), text.slice(0, 80));
  } finally {
    c.kill();
    await c.waitExit();
  }
}

async function caseMalformedSchema(): Promise<void> {
  const c = new McpClient();
  try {
    await c.initialize();
    // noop requires input:string; pass number
    const r = await c.request("tools/call", { name: "noop", arguments: { input: 42 } });
    const text = r.result?.content?.[0]?.text ?? "";
    record(
      "malformed schema rejected",
      text.toLowerCase().includes("invalid arguments") || text.toLowerCase().includes("expected"),
      text.slice(0, 80),
    );
  } finally {
    c.kill();
    await c.waitExit();
  }
}

async function caseForcedTimeout(): Promise<void> {
  // Force every tool to 1ms; pair with the noop test-hook delay so the
  // handler reliably outlasts the timer (sub-millisecond handlers would
  // otherwise race a 1ms setTimeout non-deterministically).
  const c = new McpClient({
    MCP_TOOL_TIMEOUT_FORCE_MS: "1",
    MCP_TEST_NOOP_DELAY_MS: "50",
  });
  try {
    await c.initialize();
    const r = await c.request("tools/call", { name: "noop", arguments: { input: "x" } });
    const text = r.result?.content?.[0]?.text ?? "";
    record(
      "MCP_TOOL_TIMEOUT_FORCE_MS=1 produces timeout",
      text.includes("Timed out"),
      text.slice(0, 80),
    );
  } finally {
    c.kill();
    await c.waitExit();
  }
}

async function caseSigTermClean(): Promise<void> {
  const c = new McpClient();
  try {
    await c.initialize();
    c.kill("SIGTERM");
    const exit = await c.waitExit(3_000);
    record(
      "SIGTERM produces clean exit code 0",
      exit.code === 0 && exit.signal === null,
      `code=${exit.code} signal=${exit.signal}`,
    );
  } finally {
    c.kill("SIGKILL");
  }
}

async function caseRssWatchdogKill(): Promise<void> {
  const c = new McpClient({
    MCP_MAX_RSS_MB: "50",
    MCP_MEMORY_SAMPLE_MS: "200",
  });
  try {
    await c.initialize();
    const exit = await c.waitExit(8_000);
    record(
      "MCP_MAX_RSS_MB=50 triggers watchdog kill",
      // The watchdog calls process.exit(1) or self-kills; either exit code or
      // a signal counts. Vitest-style heap-warm startup usually pushes RSS
      // past 50MB within the first sample tick.
      exit.code === 1 || exit.code === 137 || exit.signal !== null,
      `code=${exit.code} signal=${exit.signal}`,
    );
  } finally {
    c.kill("SIGKILL");
  }
}

/** The `shutdown` NDJSON marker a run left behind, if any. */
function readShutdownMarker(dir: string): { reason?: string } | null {
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ndjson"))) {
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { msg?: string; data?: { reason?: string } };
        if (parsed.msg === "shutdown") return parsed.data ?? {};
      } catch {
        // A torn final line is possible if the process died mid-write.
      }
    }
  }
  return null;
}

/**
 * The generated AGENTS.md tells every agent "file without `shutdown` = crash".
 * That rule was false for every process this template ever produced: startStdio
 * logged startup and nothing logged the counterpart, so a clean exit was
 * indistinguishable from a crash. Found by the up-bank-mcp session, in whose
 * repo the same rule had been documented and believed for months.
 *
 * Asserts the CAUSE, not merely that a marker exists — a presence-only check
 * passes against a hardcoded literal, which is the thing this exists to kill.
 */
async function caseShutdownMarker(): Promise<void> {
  const paths: Array<[string, string, (c: McpClient) => void]> = [
    ["SIGTERM", "signal:SIGTERM", (c) => c.kill("SIGTERM")],
    ["stdin EOF", "stdin_eof", (c) => c.closeStdin()],
  ];
  for (const [label, expected, trigger] of paths) {
    const dir = mkdtempSync(join(tmpdir(), "stress-shutdown-"));
    const c = new McpClient({ MCP_LOG_DIR: dir, MCP_LOG_TO_FILE: "1" });
    try {
      await c.initialize();
      trigger(c);
      await c.waitExit(6_000);
    } finally {
      c.kill("SIGKILL");
    }
    const marker = readShutdownMarker(dir);
    record(
      `shutdown marker names the real cause (${label})`,
      marker?.reason === expected,
      marker
        ? `reason=${String(marker.reason)} expected=${expected}` +
            // This case asserts the cause STRING, so it also pins the cause
            // vocabulary. If getShutdownCause() is ever re-worded, this fails for
            // a reason that has nothing to do with the marker.
            (marker.reason === undefined ? "" : " (cause vocabulary is pinned here)")
        : `NO MARKER written — expected reason=${expected}`,
    );
  }
}

async function caseHttpTransport(): Promise<void> {
  const token = randomBytes(16).toString("hex");
  const port = 18000 + Math.floor(Math.random() * 1000);
  const proc = spawn(process.execPath, [...TSX_IMPORT, ENTRY, "--http"], {
    env: {
      ...process.env,
      MCP_HTTP_TOKEN: token,
      MCP_HTTP_PORT: String(port),
      MCP_HTTP_BIND: "127.0.0.1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Wait for "listening on" stderr message
  await new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(
      () => rejectReady(new Error("HTTP server did not start in 5s")),
      5_000,
    );
    timer.unref();
    proc.stderr.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening on")) {
        clearTimeout(timer);
        resolveReady();
      }
    });
  });

  try {
    const base = `http://127.0.0.1:${port}`;

    const healthRes = await fetch(`${base}/health`);
    const healthOk = healthRes.status === 200 || healthRes.status === 503;
    record(`HTTP /health returns ${healthRes.status}`, healthOk);

    const unauthorized = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    record("HTTP /mcp without bearer returns 401", unauthorized.status === 401);

    const initRes = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "stress", version: "0.0.1" },
        },
      }),
    });
    const initJson = await readMcpResponse(initRes);
    const sessionId = initRes.headers.get("mcp-session-id") ?? "";
    const initialized = initRes.status === 200 && Boolean(initJson?.result) && sessionId.length > 0;
    record(
      "HTTP /mcp initialize with bearer succeeds",
      initialized,
      initialized
        ? "session established"
        : `status=${initRes.status} session=${sessionId || "missing"}`,
    );
    if (!initialized) return;

    const initializedNotification = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
    record(
      "HTTP /mcp initialized notification accepted",
      [200, 202, 204].includes(initializedNotification.status),
      `status=${initializedNotification.status}`,
    );

    const toolsRes = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });
    const toolsJson = await readMcpResponse(toolsRes);
    const toolCount = (toolsJson?.result?.tools as unknown[] | undefined)?.length ?? 0;
    record(
      "HTTP /mcp tools/list with session succeeds",
      toolsRes.status === 200 && toolCount >= 2,
      `status=${toolsRes.status} tools=${toolCount}`,
    );
  } finally {
    proc.kill("SIGTERM");
    await new Promise<void>((r) => {
      proc.once("exit", () => r());
      setTimeout(() => {
        proc.kill("SIGKILL");
        r();
      }, 3000).unref();
    });
  }
}

async function main(): Promise<void> {
  console.log(`stress harness · entry ${ENTRY}`);
  await caseHandshake();
  await caseHealthCheckCanary();
  await caseHealthUnderLoad();
  await caseUnknownTool();
  await caseMalformedSchema();
  await caseForcedTimeout();
  await caseSigTermClean();
  await caseRssWatchdogKill();
  await caseShutdownMarker();
  await caseHttpTransport();

  const failed = results.filter((r) => !r.pass);
  const passed = results.length - failed.length;
  console.log(`\n${passed} passed, ${failed.length} failed.`);

  // The count is quoted in ~20 places across four mirrored surfaces. It drifted
  // once — two cases were added, the harness printed 15, every doc still said
  // 13, and nothing caught it. This is the link that makes the number
  // mechanical: the harness asserts its own count, `pnpm check:stress-count`
  // asserts the prose against this constant.
  if (results.length !== EXPECTED_ASSERTIONS) {
    console.error(
      `\n✗ ran ${results.length} assertions, but EXPECTED_ASSERTIONS says ${EXPECTED_ASSERTIONS}.` +
        `\n  A case was added or removed: update the constant, then \`pnpm check:stress-count\`` +
        `\n  will name every prose site that still quotes the old number.`,
    );
    process.exit(1);
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("stress harness crashed:", err);
  process.exit(2);
});
