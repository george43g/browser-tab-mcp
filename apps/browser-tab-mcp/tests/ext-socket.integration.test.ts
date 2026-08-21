/**
 * End-to-end: the REAL extension-core `DaemonSocket` driving the REAL daemon
 * `ExtensionServer` over loopback — the seam `ws-server.test.ts` skips (it uses
 * a hand-rolled JSON client). `installNodeWebSocket` bridges `ws` onto
 * `globalThis.WebSocket` so the browser socket runs under Node; `installFakeChrome`
 * backs `buildSnapshot` + `executeCommand`. This exercises the WS protocol,
 * snapshot mappers, and command execution for real.
 */

import { rmSync } from "node:fs";
import { DaemonSocket } from "@george43g/extension-core";
import type { BrowserState, Snapshot } from "@george43g/shared-types";
import {
  type FakeChrome,
  installFakeChrome,
  makeChromeTab,
  makeChromeWindow,
  makeTmpDir,
  randomWsPort,
  withDaemonEnv,
} from "@george43g/test-kit";
import { installNodeWebSocket } from "@george43g/test-kit/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../src/client/daemon-client.js";
import { type DaemonHandle, startDaemon } from "../src/daemon/index.js";
import { ensureToken } from "../src/daemon/token.js";
import { buildStamp } from "../src/meta.js";

const WS_PORT = randomWsPort(22000, 400);
let tmp: string;
let daemon: DaemonHandle | null = null;
let env: { restore(): void } | null = null;
let ws: { restore(): void } | null = null;
let fc: FakeChrome | null = null;
let sock: DaemonSocket | null = null;
let token = "";

const fakeWindows = () => [
  makeChromeWindow({ id: 812, tabs: [makeChromeTab({ id: 4001, windowId: 812, pinned: true })] }),
];

beforeEach(async () => {
  tmp = makeTmpDir("browser-tab-extsock-");
  env = withDaemonEnv(tmp, { browsers: "chrome", wsPort: WS_PORT });
  ws = installNodeWebSocket();
  fc = installFakeChrome({ windows: fakeWindows() });
  token = ensureToken();
  daemon = await startDaemon();
  await daemon.loop.refresh();
});

afterEach(async () => {
  sock?.stop();
  sock = null;
  await daemon?.stop();
  daemon = null;
  fc?.restore();
  fc = null;
  ws?.restore();
  ws = null;
  env?.restore();
  env = null;
  rmSync(tmp, { recursive: true, force: true });
});

function connect(authToken = token, extVersion = "test"): DaemonSocket {
  const s = new DaemonSocket({
    port: WS_PORT,
    token: authToken,
    browser: "chrome",
    extVersion,
  });
  sock = s;
  s.start();
  return s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await sleep(20);
  }
}

async function pollChrome(
  client: DaemonClient,
  pred: (c: BrowserState | undefined) => boolean,
  ms = 2000,
): Promise<BrowserState | undefined> {
  const start = Date.now();
  for (;;) {
    const snapshot = await client.request<Snapshot>("getSnapshot");
    const chrome = snapshot.browsers.find((b) => b.browser === "chrome");
    if (pred(chrome)) return chrome;
    if (Date.now() - start > ms) throw new Error(`timeout; last dataSource=${chrome?.dataSource}`);
    await sleep(25);
  }
}

describe("DaemonSocket ↔ ExtensionServer", () => {
  it("streams a snapshot the daemon serves with extension x-handles", async () => {
    connect();
    const client = new DaemonClient();
    try {
      const chrome = await pollChrome(client, (c) => c?.dataSource === "extension");
      expect(chrome?.extensionConnected).toBe(true);
      expect(chrome?.windows[0]?.windowId).toBe("w:chrome:x812");
      expect(chrome?.windows[0]?.tabs[0]?.tabId).toBe("t:chrome:x4001");
      expect(chrome?.windows[0]?.tabs[0]?.pinned).toBe(true);
      // pid is backfilled from the poll side (fake adapter reports 4242).
      expect(chrome?.pid).toBe(4242);
    } finally {
      client.close();
    }
  });

  it("carries the extension's probed capability map into the served snapshot", async () => {
    connect();
    const client = new DaemonClient();
    try {
      const chrome = await pollChrome(
        client,
        (c) => c?.dataSource === "extension" && c.capabilities !== undefined,
      );
      // The fake models the full Chrome surface, so the probe (run in hello)
      // reports these as available and the daemon threads them through.
      expect(chrome?.capabilities?.tabGroups).toBe(true);
      expect(chrome?.capabilities?.captureVisibleTab).toBe(true);
      expect(chrome?.capabilities?.history).toBe(true);
      expect(chrome?.capabilities?.navigate).toBe(true);
    } finally {
      client.close();
    }
  });

  it("surfaces a bad token as lastError (daemon closes 4001)", async () => {
    const s = connect("wrong-token");
    await waitUntil(() => s.getState().lastError !== null);
    // The daemon closes with `close(4001, "bad token")`; socket.ts prefers the
    // non-empty close reason (its 4001 → "rejected: bad token" decode only
    // applies when a browser strips the reason). Either way, WHY is surfaced.
    expect(s.getState().lastError).toMatch(/bad token/i);
    expect(s.connected).toBe(false);
  });

  it("round-trips a move_tab command through the real executeCommand", async () => {
    connect();
    const client = new DaemonClient();
    try {
      await pollChrome(client, (c) => c?.dataSource === "extension");
      const result = await client.request<{ ok: boolean; windowId: string; index: number }>(
        "command",
        { kind: "move_tab", tabId: "t:chrome:x4001", newWindow: true },
      );
      expect(result.ok).toBe(true);
      // fake windows.create returns id 900 → mapped to an x-handle.
      expect(result.windowId).toBe("w:chrome:x900");
      expect(result.index).toBe(0);
      // proves the command actually reached the fake chrome API via runCommand.
      expect(fc?.calls["windows.create"]?.length).toBeGreaterThan(0);
    } finally {
      client.close();
    }
  });

  it("pushes a FRESH snapshot immediately after a command, not on the debounce", async () => {
    // The dogfood staleness bug: runCommand used the DEBOUNCED sender, so a
    // caller that wrote and then immediately read saw pre-write state. The
    // fix sends the post-command snapshot at once. The 100ms ceiling below is
    // the guard's teeth: it sits INSIDE the 150ms debounce window, so
    // reverting to sendSnapshotDebounced() turns this red rather than slow.
    connect();
    const client = new DaemonClient();
    try {
      await pollChrome(client, (c) => c?.dataSource === "extension");
      const before = fc?.calls["windows.getAll"]?.length ?? 0;
      await client.request("command", {
        kind: "tab_action",
        tabId: "t:chrome:x4001",
        action: "mute",
      });
      await vi.waitFor(
        () => {
          // buildSnapshot enumerates windows — a new getAll call IS the
          // fresh snapshot being taken. The command round trip is ~2ms here,
          // so a 100ms ceiling sits far inside the 150ms debounce window.
          expect(fc?.calls["windows.getAll"]?.length ?? 0).toBeGreaterThan(before);
        },
        { timeout: 100, interval: 10 },
      );
    } finally {
      client.close();
    }
  });

  it("falls back to AppleScript data when the socket stops", async () => {
    const s = connect();
    const client = new DaemonClient();
    try {
      await pollChrome(client, (c) => c?.dataSource === "extension");
      s.stop();
      const chrome = await pollChrome(client, (c) => c?.dataSource === "applescript");
      expect(chrome?.extensionConnected).toBe(false);
      expect(chrome?.windows[0]?.tabs[0]?.tabId).toMatch(/^t:chrome:\d+$/);
    } finally {
      client.close();
    }
  });
});

/**
 * The build-identity line the extension prints on connect.
 *
 * `doctor` already compares these stamps, but only from the DAEMON's side —
 * and "a rebuilt extension is not a reloaded one" is a browser-side fact, so
 * the extension console is the one place a human sees it without leaving the
 * browser. That console cannot be scraped from a test, so this pins the
 * behaviour at the real socket seam instead: daemon sends `daemonBuild` in
 * helloAck, extension compares and logs.
 *
 * The comparison is on COMMIT IDENTITY, not string equality — the two stamps
 * legitimately differ in their semver prefix (`0.2.0+54.abc` vs
 * `1.1.1+54.abc`), so equality would report a permanent false mismatch.
 */
describe("build identity is reported to the browser console", () => {
  let logs: string[];
  let spy: { mockRestore(): void };

  beforeEach(() => {
    logs = [];
    const push = (...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    };
    spy = vi.spyOn(console, "log").mockImplementation(push);
    vi.spyOn(console, "warn").mockImplementation(push);
  });
  afterEach(() => spy.mockRestore());

  it("logs a MATCH when only the semver prefix differs", async () => {
    // Read the stamp in-process rather than over IPC: an extra DaemonClient
    // here left a socket open and the daemon's stop() blocked on it, timing
    // out the shared afterEach.
    const daemonBuild = buildStamp();
    const commit = daemonBuild.slice(daemonBuild.indexOf("+") + 1);
    connect(token, `0.2.0+${commit}`);
    await waitUntil(() => logs.some((l) => /matches daemon/.test(l)), 4000);
    expect(logs.some((l) => l.includes("matches daemon"))).toBe(true);
  });

  it("warns on a genuine mismatch, naming both stamps", async () => {
    connect(token, "0.2.0+1.deadbee");
    await waitUntil(() => logs.some((l) => /BUILD MISMATCH/.test(l)), 4000);
    const line = logs.find((l) => l.includes("BUILD MISMATCH")) ?? "";
    expect(line).toContain("0.2.0+1.deadbee");
    expect(line).toMatch(/reload this extension/i);
  });
});
