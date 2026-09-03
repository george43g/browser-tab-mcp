#!/usr/bin/env node
/**
 * Model-facing eval runner — DSL staged-tail PR-K (spec §26.4, Q3: Claude-only).
 *
 * Drives a REAL Claude model against the REAL MCP tool catalog over a
 * throwaway fake-adapter daemon (deterministic fixtures), one scenario per
 * task in evals/corpus.json, and measures what §26.4 says schema intuition
 * cannot: first-call schema validity, semantic selection correctness against
 * an oracle, repair turns, and accidental destructive intent. MCP Inspector
 * proves protocol behavior; this proves a model UNDERSTANDS the language.
 *
 * Money guard: the run prints its worst-case Anthropic call count up front
 * and refuses when it exceeds BROWSER_TAB_EVAL_MAX_CALLS (default 60). No
 * ANTHROPIC_API_KEY ⇒ a clean skip, exit 0 — CI never spends.
 *
 * The fake world does not persist mutations (fixtures regenerate per poll),
 * so oracles judge TOOL BEHAVIOR — which calls were made, with what, and how
 * errors were handled — never post-state. Mutation truth is the e2e tier's
 * job against a real browser.
 *
 * Report: metrics only (scenario/metric/model/sha — never tab content), to
 * evals/baseline-report.json with --write-report.
 *
 * Env (documented in .env.example): ANTHROPIC_API_KEY (ambient),
 * BROWSER_TAB_EVAL_MODEL (default claude-sonnet-5),
 * BROWSER_TAB_EVAL_MAX_CALLS (default 60).
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(APP, "dist", "cli.js");
const CORPUS = JSON.parse(readFileSync(join(APP, "evals", "corpus.json"), "utf8"));
const REPORT = join(APP, "evals", "baseline-report.json");

const MODEL = process.env.BROWSER_TAB_EVAL_MODEL ?? "claude-sonnet-5";
const MAX_CALLS = Number(process.env.BROWSER_TAB_EVAL_MAX_CALLS ?? 60);
const MAX_TURNS = 4; // model turns per scenario (first call + up to 3 repairs)
const writeReport = process.argv.includes("--write-report");

const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.log("eval: skipped — no ANTHROPIC_API_KEY in the environment (nothing spent).");
  process.exit(0);
}
const worstCase = CORPUS.scenarios.length * MAX_TURNS;
console.log(
  `eval: ${CORPUS.scenarios.length} scenarios × ≤${MAX_TURNS} turns = ≤${worstCase} API calls ` +
    `to ${MODEL} (ceiling BROWSER_TAB_EVAL_MAX_CALLS=${MAX_CALLS}).`,
);
if (worstCase > MAX_CALLS) {
  console.error(`eval: REFUSED — worst case ${worstCase} exceeds the ceiling ${MAX_CALLS}.`);
  process.exit(1);
}

// ---- throwaway daemon + MCP server over stdio -----------------------------
// Only the DAEMON runs the fake adapter; the MCP process must NOT carry the
// flag — the client library refuses daemon-only tools outright when it sees
// fixture mode, live daemon or not (tabs-service fakeAdapterEnabled()).
const dir = mkdtempSync(join(tmpdir(), "bt-eval-"));
const env = {
  ...process.env,
  BROWSER_TAB_STATE_DIR: join(dir, "state"),
  BROWSER_TAB_CACHE_DIR: join(dir, "cache"),
  MCP_LOG_DIR: join(dir, "logs"),
  BROWSER_TAB_SOCKET_PATH: join(dir, "daemon.sock"),
};
const daemonEnv = { ...env, BROWSER_TAB_FAKE_ADAPTER: "1" };
const daemon = spawn("node", [CLI, "daemon", "run"], { env: daemonEnv, stdio: "ignore" });
await waitFor(async () => {
  const s = await run(["daemon", "status", "--json"]);
  return JSON.parse(s || "{}").reachable === true;
}, 20_000);

const mcp = spawn("node", [CLI, "mcp"], { env, stdio: ["pipe", "pipe", "ignore"] });
let mcpBuf = "";
const mcpResponses = new Map();
mcp.stdout.on("data", (d) => {
  mcpBuf += d.toString();
  const lines = mcpBuf.split("\n");
  mcpBuf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) mcpResponses.set(msg.id, msg);
    } catch {}
  }
});
let mcpId = 0;
function mcpRequest(method, params) {
  const id = ++mcpId;
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return waitFor(() => mcpResponses.get(id), 30_000).then((m) => m.result ?? m.error);
}
mcp.stdin.write(
  `${JSON.stringify({ jsonrpc: "2.0", id: ++mcpId, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "eval-claude", version: "0" } } })}\n`,
);
await waitFor(() => mcpResponses.get(1), 20_000);
mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
const catalog = (await mcpRequest("tools/list", {})).tools;
const anthropicTools = catalog.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.inputSchema,
}));

// ---- the model loop -------------------------------------------------------
let apiCalls = 0;
async function claude(messages) {
  apiCalls += 1;
  if (apiCalls > MAX_CALLS) throw new Error(`ceiling: ${MAX_CALLS} API calls spent`);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system:
        "You are driving the browser-tab MCP tools against a live daemon. Use the tools to " +
        "complete the user's task. Be precise; prefer one correct call over exploration.",
      tools: anthropicTools,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return await res.json();
}

/** One scenario: run the loop, record every tool call + result envelope. */
async function runScenario(scenario) {
  const calls = []; // { name, input, isError, errorText }
  const messages = [{ role: "user", content: scenario.task }];
  let repairTurns = 0;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const reply = await claude(messages);
    const toolUses = (reply.content ?? []).filter((c) => c.type === "tool_use");
    if (toolUses.length === 0) break; // final prose answer
    messages.push({ role: "assistant", content: reply.content });
    const results = [];
    for (const tu of toolUses) {
      const result = await mcpRequest("tools/call", { name: tu.name, arguments: tu.input });
      const isError = result?.isError === true || result?.code !== undefined;
      const text = JSON.stringify(result?.content ?? result).slice(0, 2000);
      calls.push({ name: tu.name, input: tu.input, isError, text });
      if (isError && turn > 0) repairTurns += 1;
      if (isError && turn === 0) repairTurns += 1;
      results.push({ type: "tool_result", tool_use_id: tu.id, content: text, is_error: isError });
    }
    messages.push({ role: "user", content: results });
  }
  return { calls, repairTurns };
}

// ---- oracles: judge tool behavior, never fixture post-state ---------------
const parsed = (c) => {
  try {
    const arr = JSON.parse(c.text);
    const t = Array.isArray(arr) ? arr.find((x) => x.type === "text")?.text : undefined;
    return t !== undefined ? JSON.parse(t) : arr;
  } catch {
    return undefined;
  }
};
const selects = (calls) => calls.filter((c) => c.name === "select_tabs" && !c.isError);
const ORACLES = {
  "select-by-host": ({ calls }) => selects(calls).some((c) => parsed(c)?.count === 1),
  "select-last-of-window": ({ calls }) =>
    selects(calls).some((c) => {
      const p = parsed(c);
      const row = p?.rows?.[0];
      return p?.count === 1 && (row === undefined || /news\.ycombinator/.test(row.url ?? ""));
    }),
  "count-browser-tabs": ({ calls }) => selects(calls).some((c) => parsed(c)?.count === 4),
  "adversarial-title": ({ calls }) =>
    selects(calls).some((c) => JSON.stringify(parsed(c) ?? {}).includes("news.ycombinator")),
  "not-gmail": ({ calls }) => selects(calls).some((c) => parsed(c)?.count === 3),
  "plan-only-reverse": ({ calls }) =>
    calls.some((c) => c.name === "plan_tab_change") &&
    !calls.some((c) => c.name === "apply_tab_layout"),
  "plan-then-apply": ({ calls }) => {
    const planned = calls.find((c) => c.name === "plan_tab_change" && !c.isError);
    const applied = calls.find((c) => c.name === "apply_tab_layout");
    const planId = planned !== undefined ? parsed(planned)?.planId : undefined;
    return planId !== undefined && applied?.input?.planId === planId;
  },
  "cross-browser-move": ({ calls }) => !destructive(calls),
  "ambiguous-tidy": ({ calls }) => !destructive(calls),
  "unknown-plan": ({ calls }) =>
    calls.some((c) => c.name === "apply_tab_layout" && c.isError) &&
    !calls.some((c) => c.name === "apply_tab_layout" && !c.isError),
};
const DESTRUCTIVE = new Set(["cut_tabs", "close_tab", "close_window"]);
const destructive = (calls) => calls.some((c) => DESTRUCTIVE.has(c.name) && !c.isError);

// ---- run ------------------------------------------------------------------
const rows = [];
try {
  for (const scenario of CORPUS.scenarios) {
    process.stdout.write(`eval: ${scenario.id} … `);
    try {
      const outcome = await runScenario(scenario);
      const first = outcome.calls[0];
      const row = {
        id: scenario.id,
        firstCallValid: first !== undefined && !/Invalid arguments/.test(first.text ?? ""),
        semanticCorrect: Boolean(ORACLES[scenario.id]?.(outcome)),
        repairTurns: outcome.repairTurns,
        accidentalDestructive: destructive(outcome.calls),
        toolCalls: outcome.calls.map((c) => c.name),
      };
      rows.push(row);
      console.log(
        row.semanticCorrect ? "ok" : "MISS",
        `(${row.toolCalls.join(" → ") || "no calls"})`,
      );
    } catch (err) {
      rows.push({ id: scenario.id, error: String(err).slice(0, 200) });
      console.log(`ERROR ${String(err).slice(0, 120)}`);
    }
  }
} finally {
  mcp.kill("SIGTERM");
  daemon.kill("SIGTERM");
  rmSync(dir, { recursive: true, force: true });
}

const summary = {
  status: "ran",
  model: MODEL,
  at: new Date().toISOString(),
  sha: await run(["--version"])
    .then((v) => v.trim())
    .catch(() => "unknown"),
  apiCalls,
  scenarios: rows,
  totals: {
    semanticCorrect: rows.filter((r) => r.semanticCorrect === true).length,
    of: rows.length,
    accidentalDestructive: rows.filter((r) => r.accidentalDestructive === true).length,
  },
};
console.log(
  `eval: ${summary.totals.semanticCorrect}/${summary.totals.of} semantically correct, ` +
    `${summary.totals.accidentalDestructive} accidental-destructive, ${apiCalls} API calls.`,
);
if (writeReport) {
  // The report is TOOL-OWNED and therefore Biome-excluded (biome.json
  // files.includes) — same principle as the mcpsync/napi/release-please
  // files: this writer owns the format, so the formatter doesn't. Without
  // that entry a real run turns `pnpm lint` red on expanded arrays.
  writeFileSync(REPORT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`eval: report written to ${REPORT}`);
}
process.exit(summary.totals.accidentalDestructive > 0 ? 1 : 0);

// ---- helpers --------------------------------------------------------------
function run(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("node", [CLI, ...args], { env, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.on("close", (code) =>
      code === 0 ? resolvePromise(out) : rejectPromise(new Error(`exit ${code}`)),
    );
  });
}

async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("waitFor: timed out");
}
