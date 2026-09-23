#!/usr/bin/env node
/**
 * MCP Dev Proxy — persistent stdio proxy for MCP server development.
 *
 * Stays alive across child restarts. Buffers stdin from the host (Cursor /
 * Claude / Warp) during restart windows so requests aren't dropped.
 * Watches source files; restarts the child when any .ts file under
 * MCP_DEV_WATCH_DIR changes. On restart it replays the captured
 * `initialize` + `notifications/initialized` so the host's pre-existing
 * protocol state stays valid.
 *
 * Why an in-process watcher (not `tsx watch` / `nodemon`):
 *   - `tsx watch` consumes stdin (treats Return as a restart key),
 *     corrupting JSON-RPC.
 *   - `nodemon` would add a dev dependency. fs.watch is built into Node.
 *
 * Env:
 *   MCP_DEV_ENTRY     TS entry to run, relative to cwd (default: "src/index.ts")
 *   MCP_DEV_CMD       full command override; you then own the tsx hazard below
 *   MCP_DEV_WATCH_DIR dir to watch recursively (default: "src")
 */

import { type ChildProcess, spawn } from "node:child_process";
import { watch } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Run the entry as `node --import <tsx loader> <entry>`, NEVER as
 * `tsx <entry>`.
 *
 * `node_modules/.bin/tsx` is a supervisor, not a runner: it spawns your code as
 * a GRANDCHILD and relays signals to it on a 30ms budget (tsx 4.22-4.23,
 * `dist/cli.mjs`, `relaySignalToChild`), then `kill("SIGKILL")`s it when the
 * child's IPC ack is late. This proxy restarts the child on EVERY source
 * change, by SIGTERM, and a server that is mid-request is exactly the child
 * whose ack is late — so the old default killed the dev server uncleanly on a
 * routine save.
 *
 * The consequence is specific to this template: the generated AGENTS.md tells
 * every agent "log file without a `shutdown` marker = crash", and a SIGKILLed
 * process cannot write one. Every busy restart manufactured false crash
 * evidence in the dev log.
 *
 * KILLING THE PROCESS GROUP DOES NOT SAVE YOU, which is the part worth writing
 * down because it is a plausible wrong conclusion — `killChildGroup` below
 * signals the whole group, so the real server does get the signal directly, but
 * the tsx wrapper is in that same group, receives it too, and runs its
 * relay-and-escalate anyway. Measured in this exact shape
 * (`shell: true` + `detached: true` + `process.kill(-pid, "SIGTERM")`):
 *
 *   .bin/tsx    child idle       -> code=0   signal=null · handler ran
 *   .bin/tsx    child busy 2s    -> code=143 signal=null · handler NEVER ran
 *   --import    child idle       -> code=0   signal=null · handler ran
 *   --import    child busy 2s    -> code=0   signal=null · handler ran
 *
 * Independently reproduced by the up-bank-mcp and gmail-cli-mcp sessions in
 * their own copies of this file. Resolved through tsx's `.` export so it
 * survives tsx upgrades, and quoted because the pnpm store path can contain
 * characters the shell would otherwise split on (`shell: true` below).
 *
 * NOT fixed, and deliberately: THIS PROXY is itself usually launched under the
 * tsx CLI (`.mcp.json` runs `pnpm tsx …scripts/mcp-dev-proxy.ts`), so the same
 * hazard applies to the proxy's OWN shutdown, and the child below is
 * `detached` + `unref`ed — a SIGKILLed proxy leaves the whole child group
 * orphaned. That case already has a net: the child runs
 * `enableOrphanWatchdog()`, notices its ppid change and exits on its own. A
 * config file cannot carry the absolute loader path anyway, since it is
 * machine-specific and this one holds `${VAR}` placeholders only.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const MCP_DEV_ENTRY = process.env.MCP_DEV_ENTRY || "src/index.ts";
const MCP_DEV_CMD =
  process.env.MCP_DEV_CMD || `"${process.execPath}" --import "${TSX_LOADER}" ${MCP_DEV_ENTRY}`;

/**
 * A SAFER DEFAULT IS NOT A FIX FOR ANYONE WHO ALREADY OVERRIDES IT.
 *
 * Every repo scaffolded before this change carries `MCP_DEV_CMD` in its MCP
 * host config — `.mcp.json`, `.codex/config.toml`, the generated
 * `opencode.json` — and an explicit override beats the default by
 * construction. Those repos stay exactly as broken while looking fixed, which
 * is worse than being obviously broken. Named by the up-bank-mcp session, whose
 * two config files still pin it.
 *
 * A doc line would not reach them; this does, at the moment it matters. Matches
 * a bare `tsx` invocation only, so a deliberate `node --import` override stays
 * silent.
 */
if (process.env.MCP_DEV_CMD && /(^|[/\s])tsx(\s|$)/.test(process.env.MCP_DEV_CMD)) {
  console.error(
    "[dev-proxy] WARNING: MCP_DEV_CMD runs the tsx CLI, which SIGKILLs this " +
      "server on restart when its event loop is busy — no cleanup, and no " +
      "`shutdown` marker, so the log reads as a crash. Replace MCP_DEV_CMD " +
      `with MCP_DEV_ENTRY="${MCP_DEV_ENTRY}" in your MCP host config.`,
  );
}
const WATCH_DIR = resolve(process.cwd(), process.env.MCP_DEV_WATCH_DIR || "src");
const RESTART_DELAY_MS = 100;
const RESPAWN_TIMEOUT_MS = 10_000;
const DEBOUNCE_MS = 150;

let child: ChildProcess | null = null;
let isShuttingDown = false;
let childReady = false;
let restartCount = 0;

let initializeLine: string | null = null;
let initializedNotificationLine: string | null = null;

const pendingLines: string[] = [];
let stdinBuffer = "";

function writeToChild(line: string): void {
  if (child?.stdin && !child.stdin.destroyed) {
    try {
      child.stdin.write(`${line}\n`);
      return;
    } catch {
      // fall through to buffer
    }
  }
  pendingLines.push(line);
}

function flushPending(): void {
  if (!child?.stdin || child.stdin.destroyed) return;
  while (pendingLines.length > 0) {
    const line = pendingLines.shift();
    if (!line) continue;
    try {
      child.stdin.write(`${line}\n`);
    } catch {
      pendingLines.unshift(line);
      return;
    }
  }
}

function processStdinChunk(chunk: Buffer): void {
  stdinBuffer += chunk.toString("utf8");
  const lines = stdinBuffer.split("\n");
  stdinBuffer = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed) as { method?: string };
      if (parsed.method === "initialize") {
        initializeLine = trimmed;
      } else if (parsed.method === "notifications/initialized") {
        initializedNotificationLine = trimmed;
      }
    } catch {
      // not JSON — still forward
    }

    if (childReady) {
      writeToChild(trimmed);
    } else {
      pendingLines.push(trimmed);
    }
  }
}

function spawnChild(): void {
  if (!MCP_DEV_CMD.trim()) {
    console.error("[dev-proxy] empty MCP_DEV_CMD");
    process.exit(1);
  }
  childReady = false;
  restartCount++;

  // The whole command as ONE string, not split into cmd + args. Under
  // `shell: true` Node concatenates them back together anyway, and passing an
  // args array alongside it emits DEP0190 on Node 24 ("arguments are not
  // escaped, only concatenated"). Splitting on spaces was also wrong for the
  // default above, whose absolute paths are quoted precisely because they can
  // contain them. Reported by the eqstack session.
  child = spawn(MCP_DEV_CMD, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
    detached: true,
  });
  child.unref();

  child.stdout?.on("data", (data: Buffer) => {
    process.stdout.write(data);
  });

  child.stderr?.on("data", (data: Buffer) => {
    process.stderr.write(data);
  });

  child.on("error", (err) => {
    console.error("[dev-proxy] Child process error:", err);
  });

  child.on("exit", (code, signal) => {
    if (isShuttingDown) return;
    childReady = false;
    console.error(
      `[dev-proxy] Child exited (code: ${code}, signal: ${signal}), restarting in ${RESTART_DELAY_MS}ms...`,
    );
    setTimeout(spawnChild, RESTART_DELAY_MS);
  });

  setTimeout(() => {
    if (!child || child.killed) return;
    childReady = true;

    if (restartCount > 1 && initializeLine) {
      try {
        child.stdin?.write(`${initializeLine}\n`);
      } catch {
        // ignore
      }
      if (initializedNotificationLine) {
        try {
          child.stdin?.write(`${initializedNotificationLine}\n`);
        } catch {
          // ignore
        }
      }
      console.error(`[dev-proxy] Replayed handshake to child (restart #${restartCount - 1})`);
    }

    flushPending();
  }, 250);

  setTimeout(() => {
    if (!childReady && child && !child.killed) {
      console.error("[dev-proxy] Child failed to become ready within timeout, killing");
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  }, RESPAWN_TIMEOUT_MS);
}

function killChildGroup(signal: NodeJS.Signals): void {
  if (child?.pid) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // process group may already be gone
    }
  }
}

let restartTimer: NodeJS.Timeout | null = null;
function scheduleRestart(reason: string): void {
  if (isShuttingDown) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    console.error(`[dev-proxy] Source change detected (${reason}); restarting child`);
    killChildGroup("SIGTERM");
    // child 'exit' handler respawns
  }, DEBOUNCE_MS);
}

try {
  watch(WATCH_DIR, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    if (!/\.(ts|tsx|js|mjs|cjs|json)$/.test(filename)) return;
    if (filename.includes(".test.") || filename.includes(".spec.")) return;
    scheduleRestart(filename);
  });
  console.error(`[dev-proxy] Watching ${WATCH_DIR} for changes`);
} catch (err) {
  console.error(`[dev-proxy] Failed to watch ${WATCH_DIR}:`, err);
}

process.stdin.on("data", processStdinChunk);

process.on("SIGINT", () => {
  isShuttingDown = true;
  killChildGroup("SIGINT");
  process.exit(0);
});

process.on("SIGTERM", () => {
  isShuttingDown = true;
  killChildGroup("SIGTERM");
  process.exit(0);
});

spawnChild();
