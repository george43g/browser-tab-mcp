#!/usr/bin/env node
/**
 * Stress harness — 10-case robustness suite.
 *
 * Lifted from Gmail-MCP-Server/scripts/stress-mcp.ts, generalized to use
 * the starter's domain-agnostic tool surface (health_check + noop).
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
 *   9. list_tabs with the fake adapter returns a valid snapshot
 *  10. daemon lifecycle: socket serves 20 parallel getSnapshot, SIGTERM
 *      exits 0 and unlinks the socket
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
/**
 * Run TypeScript entry points through node itself, not through a bin shim.
 *
 * THREE FAILURES TAUGHT THIS. Spawning `node_modules/.bin/tsx` broke on Windows
 * three different ways: the path has no extension there (ENOENT); probing for
 * "the first file that exists" still picked the extensionless POSIX shell script
 * because pnpm writes both (ENOENT again); and once the `.CMD` was selected,
 * Node refuses to spawn a `.CMD` without a shell at all (EINVAL — the
 * CVE-2024-27980 hardening).
 *
 * Every one of those is a property of the SHIM, not of tsx. Loading tsx into
 * `process.execPath` sidesteps the shim entirely: one spawn form on every OS,
 * no filesystem probing, no shell, and no argument re-parsing — which matters
 * here because this harness inspects the child's stdio byte for byte.
 */
const NODE = process.execPath;
const TSX_ARGS = ["--import", "tsx"];
const ENTRY = resolve(ROOT, "src/index.ts");

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

class McpClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (msg: RpcResponse) => void; reject: (err: Error) => void }
  >();
  private exitReason: string | null = null;
  private exitInfo: { code: number | null; signal: string | null } | null = null;
  public stderr = "";

  constructor(env: Record<string, string> = {}) {
    this.child = spawn(NODE, [...TSX_ARGS, ENTRY], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    // A write racing the child's death must not crash the harness with an
    // unhandled stream error — the exit handler below reports the death.
    this.child.stdin.on("error", () => {});
    // A server that dies before answering must REJECT its callers, loudly and
    // immediately. Without this, a pending request's only escape was its
    // unref'd timeout timer — which does not keep the event loop alive, so a
    // child that exited cleanly at import time (the Windows backslash bug in
    // index.ts's entry guard) drained the loop and the whole harness exited 0
    // after printing nothing but its header: a PHANTOM PASS, on CI included.
    this.child.once("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      this.exitReason = `server exited (code ${code}, signal ${signal}) before responding${
        this.stderr ? ` — stderr: ${this.stderr.slice(0, 300)}` : ""
      }`;
      for (const [, entry] of this.pending) entry.reject(new Error(this.exitReason));
      this.pending.clear();
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
        const entry = this.pending.get(parsed.id);
        if (entry) {
          this.pending.delete(parsed.id);
          entry.resolve(parsed);
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
      if (this.exitReason) {
        reject(new Error(`request ${method} refused: ${this.exitReason}`));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolveResp(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
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
    // An already-dead child never fires "exit" again, and the timeout timer
    // below is unref'd — so without this, waiting on a child that died before
    // the wait began drained the event loop instead of resolving.
    if (this.exitInfo) return this.exitInfo;
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

  endStdin(): void {
    this.child.stdin.end();
  }
}

interface CaseResult {
  name: string;
  pass: boolean;
  detail?: string;
}
const results: CaseResult[] = [];

function record(name: string, pass: boolean, detail?: string) {
  results.push({ name, pass, ...(detail !== undefined ? { detail } : {}) });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
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
    if (process.platform === "win32") {
      // Windows cannot deliver a catchable SIGTERM: child.kill() is
      // TerminateProcess, so the shutdown handler never runs and the exit is
      // (code null, signal SIGTERM) BY DESIGN of the platform, not a bug.
      // The graceful trigger the shutdown registry actually receives on
      // Windows is stdin EOF ("MCP host died") — so that is what this case
      // must exercise there. First real Windows run (2026-08-21) caught this.
      c.endStdin();
      const exit = await c.waitExit(3_000);
      record(
        "graceful shutdown exits 0 (win32: stdin EOF)",
        exit.code === 0 && exit.signal === null,
        `code=${exit.code} signal=${exit.signal}`,
      );
    } else {
      c.kill("SIGTERM");
      const exit = await c.waitExit(3_000);
      record(
        "SIGTERM produces clean exit code 0",
        exit.code === 0 && exit.signal === null,
        `code=${exit.code} signal=${exit.signal}`,
      );
    }
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

async function caseListTabsFakeAdapter(): Promise<void> {
  const c = new McpClient({ BROWSER_TAB_FAKE_ADAPTER: "1", BROWSER_TAB_BROWSERS: "chrome,safari" });
  try {
    await c.initialize();
    const r = await c.request("tools/call", { name: "list_tabs", arguments: {} });
    const text = r.result?.content?.[0]?.text ?? "";
    let ok = false;
    let detail = "no parseable snapshot";
    try {
      const snapshot = JSON.parse(text) as {
        version?: number;
        source?: string;
        browsers?: { browser: string; windows: unknown[] }[];
      };
      ok =
        snapshot.version === 2 &&
        snapshot.source === "osascript-direct" &&
        Array.isArray(snapshot.browsers) &&
        snapshot.browsers.length === 2 &&
        snapshot.browsers.every((b) => Array.isArray(b.windows) && b.windows.length > 0);
      detail = `browsers=${snapshot.browsers?.map((b) => b.browser).join(",")}`;
    } catch {
      detail = `unparseable: ${text.slice(0, 80)}`;
    }
    record("list_tabs (fake adapter) returns valid snapshot", ok, detail);
  } finally {
    c.kill();
    await c.waitExit();
  }
}

async function caseJournalFakeAdapter(): Promise<void> {
  const c = new McpClient({ BROWSER_TAB_FAKE_ADAPTER: "1" });
  try {
    await c.initialize();
    const r = await c.request("tools/call", { name: "journal", arguments: { view: "recent" } });
    const text = r.result?.content?.[0]?.text ?? "";
    let ok = false;
    let detail = "no parseable journal";
    try {
      const out = JSON.parse(text) as { view?: string; focus?: unknown[]; nav?: unknown[] };
      ok = out.view === "recent" && Array.isArray(out.focus) && Array.isArray(out.nav);
      detail = `view=${out.view} focus=${out.focus?.length} nav=${out.nav?.length}`;
    } catch {
      detail = `unparseable: ${text.slice(0, 80)}`;
    }
    record("journal (fake adapter) returns valid empty result", ok, detail);
  } finally {
    c.kill();
    await c.waitExit();
  }
}

async function caseWriteCommandsFakeAdapter(): Promise<void> {
  const c = new McpClient({ BROWSER_TAB_FAKE_ADAPTER: "1", BROWSER_TAB_BROWSERS: "chrome" });
  try {
    await c.initialize();
    const text = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const r = await c.request("tools/call", { name, arguments: args });
      return r.result?.content?.[0]?.text ?? "";
    };
    // Happy paths the AppleScript fake adapter supports.
    record(
      "tab_action navigate returns ok",
      (
        await text("tab_action", { tabId: "t:chrome:9900", action: "navigate", url: "https://x/" })
      ).includes('"ok": true'),
    );
    record(
      "open_window returns ok",
      (
        await text("open_window", { urls: ["https://x/"], bounds: { x: 0, y: 0, w: 800, h: 600 } })
      ).includes('"ok": true'),
    );
    record(
      "close_window returns ok",
      (await text("close_window", { windowId: "w:chrome:100" })).includes('"ok": true'),
    );
    // focus_tab's raiseWindow default is a Zod `.default(true)` — it has to
    // survive the MCP boundary, not just a direct call, or an MCP host that
    // omits the field silently gets the opt-out behaviour.
    record(
      "focus_tab omitting raiseWindow raises (schema default survives dispatch)",
      (await text("focus_tab", { tabId: "t:chrome:9900" })).includes('"windowFocused": true'),
    );
    record(
      "focus_tab raiseWindow:false does not raise",
      (await text("focus_tab", { tabId: "t:chrome:9900", raiseWindow: false })).includes(
        '"windowFocused": false',
      ),
    );
    // Extension-only surfaces must error cleanly (not crash) without a daemon.
    record(
      "group_tabs without extension errors cleanly",
      /extension/i.test(await text("group_tabs", { action: "create", tabIds: ["t:chrome:9900"] })),
    );
    record(
      "unsupported tab_action errors cleanly",
      /extension/i.test(await text("tab_action", { tabId: "t:chrome:9900", action: "mute" })),
    );
    // move_tab's signed forms resolve in the daemon; without one they must
    // error cleanly with the daemon hint, and the schema refusals must fire
    // over the real transport (mirrors the screenshot neither/both check).
    record(
      "move_tab by without daemon errors cleanly with the daemon hint",
      /daemon/i.test(await text("move_tab", { tabId: "t:chrome:9900", by: -1 })),
    );
    record(
      "move_tab to: 0 is schema-rejected",
      /one-based/i.test(await text("move_tab", { tabId: "t:chrome:9900", to: 0 })),
    );
    record(
      "move_tab to+by together is schema-rejected",
      /at most one/i.test(await text("move_tab", { tabId: "t:chrome:9900", to: 1, by: 1 })),
    );
  } finally {
    c.kill();
    await c.waitExit();
  }
}

async function caseContentFakeAdapter(): Promise<void> {
  const c = new McpClient({ BROWSER_TAB_FAKE_ADAPTER: "1" });
  try {
    await c.initialize();
    const text = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const r = await c.request("tools/call", { name, arguments: args });
      return r.result?.content?.[0]?.text ?? "";
    };
    // Content extraction + annotations are daemon/extension-only: without a
    // daemon they must error cleanly (not crash).
    record(
      "get_page without daemon/extension errors cleanly",
      /extension|daemon/i.test(await text("get_page", { tabId: "t:chrome:9900", mode: "text" })),
    );
    record(
      "annotate without daemon errors cleanly",
      /daemon/i.test(await text("annotate", { url: "https://x/", note: "hi" })),
    );
    record(
      "screenshot without daemon/extension errors cleanly",
      /daemon|extension|fixture/i.test(await text("screenshot", { tabId: "t:chrome:x9900" })),
    );
    record(
      "screenshot with neither/both ids is rejected by schema",
      /Invalid arguments|exactly one/i.test(await text("screenshot", {})),
    );
    // history is a read-query: like journal it degrades to a valid empty result
    // without a daemon (not an error), and enforces its maxResults bound.
    let histOk = false;
    let histDetail = "no parseable history";
    try {
      const out = JSON.parse(await text("history", { maxResults: 20 })) as {
        rows?: unknown[];
        truncated?: unknown;
      };
      histOk = Array.isArray(out.rows) && out.rows.length === 0 && out.truncated === false;
      histDetail = `rows=${out.rows?.length} truncated=${String(out.truncated)}`;
    } catch (err) {
      histDetail = `unparseable: ${(err as Error).message}`;
    }
    record("history (fake adapter) returns valid empty result", histOk, histDetail);
    record(
      "history with out-of-range maxResults is rejected by schema",
      /Invalid arguments/i.test(await text("history", { maxResults: 9999 })),
    );
    // select_tabs is daemon-only like get_page: fixture mode must error
    // actionably (an empty selection is a REAL result callers can act on, so
    // "daemon down" must never impersonate it), and a malformed selector is a
    // schema rejection before any dispatch.
    record(
      "select_tabs without daemon errors cleanly (never an empty selection)",
      /daemon/i.test(await text("select_tabs", { selector: { kind: "scope", scope: "allTabs" } })),
    );
    record(
      "select_tabs with an invalid selector is rejected by schema",
      /Invalid arguments/i.test(await text("select_tabs", { selector: { kind: "nonsense" } })),
    );
    record(
      "plan_tab_change without daemon errors cleanly",
      /daemon/i.test(
        await text("plan_tab_change", {
          selector: { kind: "scope", scope: "allTabs" },
          transform: { kind: "reverse" },
        }),
      ),
    );
    record(
      "cut_tabs without confirmDestruction is rejected by schema",
      /Invalid arguments/i.test(
        await text("cut_tabs", {
          selector: { kind: "scope", scope: "allTabs" },
          destination: { kind: "newWindow", browser: "chrome" },
        }),
      ),
    );
    record(
      "copy_tabs without daemon errors cleanly",
      /daemon/i.test(
        await text("copy_tabs", {
          selector: { kind: "scope", scope: "allTabs" },
          destination: { kind: "newWindow", browser: "chrome" },
        }),
      ),
    );
    record(
      "apply_tab_layout without daemon errors cleanly",
      /daemon/i.test(await text("apply_tab_layout", { planId: "deadbeef" })),
    );
    record(
      "plan_tab_change with an unknown transform is rejected by schema",
      /Invalid arguments/i.test(
        await text("plan_tab_change", {
          selector: { kind: "scope", scope: "allTabs" },
          transform: { kind: "interleave" },
        }),
      ),
    );
  } finally {
    c.kill();
    await c.waitExit();
  }
}

function ipcRequest(sock: string, method: string, timeoutMs = 5_000): Promise<unknown> {
  return new Promise((resolveReq, rejectReq) => {
    const conn = createConnection(sock);
    let buffer = "";
    const timer = setTimeout(() => {
      conn.destroy();
      rejectReq(new Error(`ipc ${method} timed out`));
    }, timeoutMs);
    timer.unref();
    conn.on("connect", () => {
      conn.write(`${JSON.stringify({ id: 1, method })}\n`);
    });
    conn.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const line = buffer.split("\n")[0];
      if (line?.trim()) {
        clearTimeout(timer);
        conn.destroy();
        try {
          resolveReq(JSON.parse(line));
        } catch (err) {
          rejectReq(err as Error);
        }
      }
    });
    conn.on("error", (err) => {
      clearTimeout(timer);
      rejectReq(err);
    });
  });
}

/**
 * Case 14 — the two refusals that are security boundaries, checked across the
 * REAL MCP transport rather than in-process.
 *
 * Both used to be no-ops: `url: z.string()` accepted `javascript:`/`file:`, and
 * `devOnly` was honoured only by `toMcpTools()` — so `get_logs` was hidden from
 * tools/list but still ran if you named it.
 */
async function caseRefusalsFakeAdapter(): Promise<void> {
  const c = new McpClient({ BROWSER_TAB_FAKE_ADAPTER: "1", BROWSER_TAB_BROWSERS: "chrome" });
  try {
    await c.initialize();
    const text = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const r = await c.request("tools/call", { name, arguments: args });
      return r.result?.content?.[0]?.text ?? "";
    };
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x"]) {
      record(
        `open_tab refuses ${url.split(":")[0]}:`,
        /not allowed/i.test(await text("open_tab", { url })),
      );
    }
    record(
      "open_window refuses a javascript: url in its array",
      /not allowed/i.test(await text("open_window", { urls: ["javascript:alert(1)"] })),
    );
    record(
      "tab_action navigate refuses a file: url",
      /not allowed/i.test(
        await text("tab_action", {
          tabId: "t:chrome:9900",
          action: "navigate",
          url: "file:///etc/passwd",
        }),
      ),
    );
    record(
      "open_tab still opens https",
      (await text("open_tab", { url: "https://example.com" })).includes('"ok": true'),
    );
    // Hidden must mean unreachable, and must look exactly like "no such tool"
    // so the refusal doesn't confirm the tool exists.
    record(
      "get_logs is unreachable without MCP_DEV",
      /unknown tool name/i.test(await text("get_logs", {})),
    );
  } finally {
    c.kill();
    await c.waitExit();
  }
}

async function caseDaemonLifecycle(): Promise<void> {
  const isWin = process.platform === "win32";
  const tmp = mkdtempSync(join(tmpdir(), "browser-tab-stress-"));
  // Windows IPC is a NAMED PIPE (daemon/paths.ts isPipe()) — it has no
  // ordinary filesystem entry, so a unix-style tmp path never "appears" and
  // the old existsSync probe waited its full deadline and failed. First real
  // Windows run (2026-08-21) caught this.
  const sock = isWin ? `\\\\.\\pipe\\browser-tab-stress-${process.pid}` : join(tmp, "daemon.sock");
  const proc = spawn(NODE, [...TSX_ARGS, resolve(ROOT, "src/cli.ts"), "daemon", "run"], {
    env: {
      ...process.env,
      BROWSER_TAB_FAKE_ADAPTER: "1",
      BROWSER_TAB_BROWSERS: "chrome",
      BROWSER_TAB_SOCKET_PATH: sock,
      BROWSER_TAB_CACHE_DIR: tmp,
      BROWSER_TAB_POLL_MS: "60000",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    // Probe by CONNECTING, not by existsSync: a named pipe never has a file
    // entry, and even on POSIX "the socket file exists" is not "the daemon
    // accepts". One successful getSnapshot is the honest readiness signal.
    let answered = false;
    const deadline = Date.now() + 10_000;
    while (!answered && Date.now() < deadline) {
      try {
        const probe = (await ipcRequest(sock, "getSnapshot", 1_000)) as { ok?: boolean };
        answered = probe.ok === true;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    record("daemon IPC answers", answered);
    if (!answered) return;

    const results = await Promise.all(
      Array.from({ length: 20 }, () => ipcRequest(sock, "getSnapshot")),
    );
    const allOk = results.every((r) => {
      const resp = r as { ok?: boolean; result?: { source?: string; browsers?: unknown[] } };
      return (
        resp.ok === true &&
        resp.result?.source === "daemon" &&
        (resp.result?.browsers?.length ?? 0) > 0
      );
    });
    record("20 parallel daemon getSnapshot all ok", allOk);

    proc.kill("SIGTERM");
    const exit = await new Promise<{ code: number | null; signal: string | null }>(
      (resolveExit) => {
        const timer = setTimeout(() => {
          proc.kill("SIGKILL");
          resolveExit({ code: null, signal: "TIMEOUT" });
        }, 5_000);
        timer.unref();
        proc.once("exit", (code, signal) => {
          clearTimeout(timer);
          resolveExit({ code, signal });
        });
      },
    );
    if (isWin) {
      // TerminateProcess semantics: the daemon cannot intercept this kill, so
      // "exited at all, promptly" is the testable contract here — and a pipe
      // leaves no filesystem entry, so there is nothing to check for unlink.
      record(
        "daemon terminates on kill (win32: no catchable SIGTERM)",
        exit.signal !== "TIMEOUT",
        `code=${exit.code} signal=${exit.signal}`,
      );
    } else {
      record("daemon SIGTERM exits 0", exit.code === 0, `code=${exit.code} signal=${exit.signal}`);
      record("daemon socket unlinked on shutdown", !existsSync(sock));
    }
  } finally {
    proc.kill("SIGKILL");
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  // FAILSAFE: only the summary path at the bottom may produce exit 0/1. If
  // every pending promise is orphaned and the event loop drains mid-run (the
  // phantom-pass this harness shipped with), node honours this exitCode — so
  // a run that never reaches its own verdict can no longer read as success.
  process.exitCode = 70;
  process.on("beforeExit", () => {
    console.error(
      "stress harness: event loop drained before the summary — a case orphaned its promises; failing (exit 70)",
    );
  });
  console.log(`stress harness · entry ${ENTRY}`);
  await caseHandshake();
  await caseHealthCheckCanary();
  await caseHealthUnderLoad();
  await caseUnknownTool();
  await caseMalformedSchema();
  await caseForcedTimeout();
  await caseSigTermClean();
  await caseRssWatchdogKill();
  await caseListTabsFakeAdapter();
  await caseJournalFakeAdapter();
  await caseWriteCommandsFakeAdapter();
  await caseContentFakeAdapter();
  await caseRefusalsFakeAdapter();
  await caseDaemonLifecycle();

  const failed = results.filter((r) => !r.pass);
  const passed = results.length - failed.length;
  console.log(`\n${passed} passed, ${failed.length} failed.`);
  // Emit the report the CI upload step + turbo `stress.outputs` expect.
  writeFileSync(
    resolve(ROOT, "stress-mcp-report.json"),
    `${JSON.stringify(
      {
        suite: "stress-mcp",
        generatedAt: new Date().toISOString(),
        entry: ENTRY,
        passed,
        failed: failed.length,
        cases: results,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("stress harness crashed:", err);
  process.exit(2);
});
