/**
 * Playwright fixtures for the browser-tab extension e2e.
 *
 * Loads the BUILT `dist/` bundle into a real Chromium (new-headless — the full
 * chromium build supports MV3 extensions, the headless shell does not) and,
 * when a test needs the round-trip, spins up a throwaway daemon whose state is
 * fully isolated via `BROWSER_TAB_STATE_DIR`/`_CACHE_DIR` (never touches the
 * real `~/.browser-tab`). The daemon runs the fake AppleScript adapter, so the
 * only real browser in the loop is the one Playwright drives.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type BrowserContext, test as base, chromium, type Worker } from "@playwright/test";

const execFileP = promisify(execFile);
const HERE = fileURLToPath(new URL(".", import.meta.url));
export const DIST = resolve(HERE, "../dist");
export const REPO_ROOT = resolve(HERE, "../../..");
export const CLI = resolve(REPO_ROOT, "apps/browser-tab-mcp/dist/cli.js");

/** Playwright browser channel this run drives — default matches today's ubuntu leg exactly. */
const RAW_CHANNEL = process.env.E2E_BROWSER_CHANNEL ?? "chromium";
if (!["chromium", "chrome", "msedge"].includes(RAW_CHANNEL)) {
  throw new Error(`E2E_BROWSER_CHANNEL must be chromium|chrome|msedge, got "${RAW_CHANNEL}"`);
}
export const CHANNEL = RAW_CHANNEL;
/** What detectBrowserName() must yield inside this channel's real UA. */
export const EXPECTED_BROWSER: "chrome" | "edge" = CHANNEL === "msedge" ? "edge" : "chrome";

/** An isolated, fake-adapter daemon on an ephemeral WS port. */
export interface Daemon {
  proc: ChildProcess;
  wsPort: number;
  token: string;
  /** Env every CLI call must carry to reach THIS daemon (state/cache/port). */
  env: NodeJS.ProcessEnv;
  /** Run a `browser-tab` CLI subcommand against this daemon; returns stdout. */
  cli(args: string[]): Promise<string>;
  /** `daemon status --json` parsed. */
  status(): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
}

/**
 * Pick a port deterministically-ish from the pid to avoid collisions in a serial run.
 * Base 24_500: 21500-23899 now belongs to the vitest integration bands — see
 * `randomWsPort(` callers and `packages/test-kit/src/fakes/daemon-env.ts`.
 */
function ephemeralPort(): number {
  return 24_500 + (process.pid % 2000);
}

export async function startDaemon(): Promise<Daemon> {
  const dir = mkdtempSync(join(tmpdir(), "bt-e2e-"));
  const wsPort = ephemeralPort();
  // Shared isolation: state/cache/log dirs + WS port, never the real ~/.browser-tab.
  const shared: NodeJS.ProcessEnv = {
    ...process.env,
    BROWSER_TAB_STATE_DIR: join(dir, "state"),
    BROWSER_TAB_CACHE_DIR: join(dir, "cache"),
    BROWSER_TAB_WS_PORT: String(wsPort),
    MCP_LOG_DIR: join(dir, "logs"),
  };
  // The DAEMON runs the fake AppleScript adapter (so it never shells osascript);
  // CLIENT calls must NOT — in fake mode `list`/`move` short-circuit to fake data
  // instead of querying the running daemon (whose chrome feed is the real extension).
  const daemonEnv: NodeJS.ProcessEnv = { ...shared, BROWSER_TAB_FAKE_ADAPTER: "1" };
  const env = shared;

  const cli = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileP("node", [CLI, ...args], { env, timeout: 20_000 });
    return stdout.trim();
  };
  const status = async (): Promise<Record<string, unknown>> => {
    // `daemon status` exits 1 when unreachable — tolerate and parse whatever JSON it printed.
    try {
      const out = await cli(["daemon", "status", "--json"]);
      return JSON.parse(out);
    } catch (err) {
      const stdout = (err as { stdout?: string }).stdout ?? "";
      try {
        return JSON.parse(stdout);
      } catch {
        return { reachable: false };
      }
    }
  };

  const proc = spawn("node", [CLI, "daemon", "run"], { env: daemonEnv, stdio: "ignore" });

  // Wait for the socket to answer.
  const deadline = Date.now() + 15_000;
  let reachable = false;
  while (Date.now() < deadline) {
    const s = await status();
    if (s.reachable === true) {
      reachable = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!reachable) {
    proc.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
    throw new Error("throwaway daemon did not become reachable within 15s");
  }

  const token = await execFileP("node", [CLI, "daemon", "token"], { env }).then((r) =>
    r.stdout.trim(),
  );

  const stop = async (): Promise<void> => {
    proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    if (!proc.killed) proc.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  };

  return { proc, wsPort, token, env, cli, status, stop };
}

/** Launch the extension in a fresh new-headless Chromium; resolve its id. */
export async function launchExtension(): Promise<{
  context: BrowserContext;
  extensionId: string;
  userDataDir: string;
}> {
  const userDataDir = mkdtempSync(join(tmpdir(), "bt-e2e-profile-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: CHANNEL,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  const extensionId = new URL((sw as Worker).url()).host;

  return { context, extensionId, userDataDir };
}

/** Seed the extension's storage with the daemon's port + token (the real config path). */
export async function seedConfig(
  context: BrowserContext,
  extensionId: string,
  daemon: Daemon,
): Promise<void> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  // Drive storage.local directly — the same keys the options form writes
  // (`token`/`port`), so the background reconnects on storage.onChanged.
  // Deliberately omit `browser`: real UA auto-detection (`detectBrowserName`,
  // extension-core runtime.ts) is what's under test here, and the msedge leg
  // is the standing regression guard for the edg/-before-chrome ordering that
  // keeps Edge from evicting the Chrome WS session.
  await page.evaluate(
    ({ token, port }) =>
      (globalThis as unknown as { chrome: typeof chrome }).chrome.storage.local.set({
        token,
        port,
      }),
    { token: daemon.token, port: daemon.wsPort },
  );
  await page.close();
}

export const test = base;
export { expect } from "@playwright/test";
