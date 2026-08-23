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
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defaultIpcEndpoint } from "@george43g/test-kit";
import {
  type BrowserContext,
  test as base,
  chromium,
  expect as pwExpect,
  type Worker,
} from "@playwright/test";
import { portForSpec } from "./ports.js";

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
 * Assert the daemon answering us is the one we just spawned.
 *
 * CI cannot catch environment-binding defects — a fresh runner has no
 * pre-existing daemon to be confused with — so this exists for the machine
 * where it actually happens: a developer's box, where a real console or
 * launchd daemon is running as the same user. Measured on the Windows box
 * (2026-08-22): `daemon status` returned a different pid, ws 8790 and uptime
 * 50min, and the msedge roundtrip failed in a way that looked like a product
 * bug. Every check below turns one of those symptoms into a named failure.
 */
async function assertDaemonIdentity(d: Daemon): Promise<void> {
  const s = await d.status();
  const fail = (why: string): never => {
    throw new Error(
      `${why}\n` +
        `  This test is talking to the WRONG daemon. A real browser-tab daemon is\n` +
        `  probably running as this user — stop it with \`browser-tab daemon stop\`,\n` +
        `  or give this run a distinct BROWSER_TAB_SOCKET_PATH.`,
    );
  };

  // `spawn` is called without `shell: true`, so proc.pid IS the node pid.
  if (s.pid !== d.proc.pid) fail(`daemon status reports pid ${s.pid}, we spawned ${d.proc.pid}.`);
  if (s.socket !== d.env.BROWSER_TAB_SOCKET_PATH) {
    fail(
      `daemon status reports socket ${s.socket}, we asked for ${d.env.BROWSER_TAB_SOCKET_PATH}.`,
    );
  }
  // Redundant with the pid check, but it is the human-legible tell from the
  // original measurement and it survives a pid coincidence after a reboot.
  if (typeof s.uptimeS === "number" && s.uptimeS > 60) {
    fail(`daemon reports ${s.uptimeS}s uptime; ours is seconds old.`);
  }
  // A null wsPort means the WS bind FAILED and the daemon degraded silently to
  // ext = null (`ws_disabled`). Everything downstream would then wait forever
  // for `dataSource: "extension"`. This is also the port-band check: one call,
  // two guarantees.
  if (s.wsPort !== d.wsPort) {
    throw new Error(
      s.wsPort === null
        ? `daemon bound NO WS port — the ${d.wsPort} bind was lost and swallowed as ` +
            `ws_disabled. Another daemon (or a previous run's leak) holds that port; ` +
            `see e2e/ports.ts for the per-spec bands.`
        : `daemon bound WS port ${s.wsPort}, we asked for ${d.wsPort}.`,
    );
  }
}

/**
 * Assert the extension the daemon is talking to is built from THIS tree.
 *
 * The C3 failure: a spec passes against last week's `dist/`. Git does not
 * preserve mtimes, so a file-freshness check is worthless here — but the
 * daemon already computes the signal for its own reasons. `extIsStale`
 * (`daemon/ws-server.ts`) compares the extension's `protocolVersion` against
 * the daemon's `WIRE_PROTOCOL_VERSION` at hello, and `daemon status --json`
 * reports it per session. A stale bundle also reports no capabilities, so
 * everything downstream degrades into "gracefully refuses" — which reads as a
 * product limitation rather than a build problem.
 *
 * Call this once the browser is extension-authoritative, not at startDaemon
 * time: nothing has connected yet then.
 */
export async function assertExtensionFresh(daemon: Daemon): Promise<void> {
  const s = await daemon.status();
  const sessions = (s.extensionInfo ?? []) as Array<Record<string, unknown>>;
  if (sessions.length === 0) {
    throw new Error(
      "daemon reports no extension sessions, so freshness cannot be checked. " +
        "Wait for dataSource === 'extension' before calling assertExtensionFresh().",
    );
  }
  const stale = sessions.filter((x) => x.stale === true);
  if (stale.length > 0) {
    throw new Error(
      `extension session(s) ${stale.map((x) => String(x.browser)).join(", ")} speak an ` +
        `older wire protocol than this daemon — the loaded dist/ is from an earlier ` +
        `build. Run \`pnpm build\` and re-run; testing a stale bundle is a pass that ` +
        `means nothing.`,
    );
  }
}

/**
 * @param specUrl the calling spec's `import.meta.url`. REQUIRED, so that an
 * unmigrated caller is a typecheck error rather than a silent fall-back to a
 * shared port — see `e2e/ports.ts` for why sharing is not survivable.
 */
export async function startDaemon(specUrl: string): Promise<Daemon> {
  const specBasename = basename(fileURLToPath(specUrl));
  const dir = mkdtempSync(join(tmpdir(), "bt-e2e-"));
  const wsPort = portForSpec(specBasename);
  // Shared isolation: state/cache/log dirs + WS port + IPC endpoint, never
  // the real ~/.browser-tab and never the per-user default pipe/socket. The
  // socket path matters most on Windows: leaving it unset falls back to the
  // per-user default named pipe, and a real daemon already running under
  // that same user (a dev's console session) silently absorbs every
  // `daemon.cli([...])` call below instead of the throwaway one — the
  // extension still connects to the throwaway fine, but the assertions read
  // the wrong daemon's state. Measured on the Windows box (2026-08-22):
  // `daemon status` returned a different pid, ws 8790, uptime 50min — which
  // is why the msedge roundtrip failed there. `defaultIpcEndpoint()` is
  // imported from `@george43g/test-kit` (an existing devDependency here,
  // same as the vitest unit tests use) rather than duplicated — see its doc
  // comment in `packages/test-kit/src/fakes/daemon-env.ts` for the full
  // rationale.
  const shared: NodeJS.ProcessEnv = {
    ...process.env,
    BROWSER_TAB_STATE_DIR: join(dir, "state"),
    BROWSER_TAB_CACHE_DIR: join(dir, "cache"),
    BROWSER_TAB_WS_PORT: String(wsPort),
    BROWSER_TAB_SOCKET_PATH: defaultIpcEndpoint(dir),
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

  const daemon: Daemon = { proc, wsPort, token, env, cli, status, stop };
  try {
    await assertDaemonIdentity(daemon);
  } catch (err) {
    await stop();
    throw err;
  }
  return daemon;
}

/**
 * Everything a sweep spec needs, wired and proven live: a throwaway daemon on
 * this spec's own port band, a real browser running the built bundle, and a
 * daemon that is EXTENSION-AUTHORITATIVE rather than merely aware of one.
 *
 * Every Phase-2 spec file calls this in `beforeAll`. Each call builds its OWN
 * daemon and its OWN browser — the sharing that would be wrong here is sharing
 * one stack ACROSS files, which is what destroys per-command diagnostics when
 * something fails. Sharing the setup code has the opposite effect: twelve
 * hand-copied `beforeAll` blocks drift, and a drifted one that waits on the
 * wrong condition looks exactly like a flaky product.
 */
export interface Stack {
  daemon: Daemon;
  context: BrowserContext;
  extensionId: string;
  /** The extension's background service worker — used to drive AND to read back. */
  sw: Worker;
  /** Tab/window handle for a raw chrome id, in the documented x-id grammar. */
  tabHandle(id: number): string;
  windowHandle(id: number): string;
  /**
   * Parsed `browser-tab list --json`, NARROWED to this run's browser.
   *
   * ALWAYS go through this rather than scanning `snap.browsers`. The throwaway
   * daemon runs `BROWSER_TAB_FAKE_ADAPTER=1` so it never shells `osascript`,
   * and the fake adapter fabricates brave/chromium/safari windows full of
   * plausible tabs (gmail, github, HN). A spec that scans every browser is
   * measuring the FIXTURE — and measuring it successfully, which is worse than
   * failing. Caught the hard way while writing tabs-lifecycle: a tab-count
   * assertion picked "the first browser with windows" and got brave.
   *
   * `extraArgs` are appended before `--json`, e.g. ["--fields", "summary"].
   */
  browserState(extraArgs?: readonly string[]): Promise<Record<string, unknown> | undefined>;
  close(): Promise<void>;
}

export async function startStack(specUrl: string): Promise<Stack> {
  const daemon = await startDaemon(specUrl);
  const { context, extensionId, userDataDir } = await launchExtension();
  // `serviceWorkers()[0]` is `Worker | undefined` under noUncheckedIndexedAccess
  // — assign through a local so the narrowing actually applies.
  const existing = context.serviceWorkers()[0];
  const sw = existing ?? (await context.waitForEvent("serviceworker"));
  await seedConfig(context, extensionId, daemon);

  const browserState = async (
    extraArgs: readonly string[] = [],
  ): Promise<Record<string, unknown> | undefined> => {
    const snap = JSON.parse(await daemon.cli(["list", ...extraArgs, "--json"])) as {
      browsers: Array<Record<string, unknown>>;
    };
    return snap.browsers.find((b) => b.browser === EXPECTED_BROWSER);
  };

  // Wait until the daemon is extension-AUTHORITATIVE — not merely that
  // `extensions` lists the browser, which flips the moment `hello` registers
  // the session, a beat before the first snapshot merges.
  await pwExpect
    .poll(async () => (await browserState())?.dataSource ?? "none", {
      timeout: 20_000,
      intervals: [250],
    })
    .toBe("extension");

  // A session exists now, so freshness is checkable. A stale dist/ reports no
  // capabilities, and everything downstream degrades into graceful refusals
  // that read as product limits rather than a build problem.
  await assertExtensionFresh(daemon);

  return {
    daemon,
    context,
    extensionId,
    sw,
    tabHandle: (id) => `t:${EXPECTED_BROWSER}:x${id}`,
    windowHandle: (id) => `w:${EXPECTED_BROWSER}:x${id}`,
    browserState,
    close: async () => {
      await context.close();
      await daemon.stop();
      const { rmSync } = await import("node:fs");
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
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
