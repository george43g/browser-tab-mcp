/**
 * End-to-end tier-1 screenshots: IPC `screenshot` → daemon screenshot →
 * ext.sendCommand("capture_tab") → the REAL extension-core executeCommand →
 * the fake chrome captureVisibleTab (returns a jpeg data URL), over a real
 * loopback WebSocket. Proves the active-tab preflight, the jpeg is written to
 * the shot cache, the second call cache-hits, and focus:true captures a
 * background tab.
 */

import { existsSync, rmSync, statSync } from "node:fs";
import { DaemonSocket } from "@george43g/extension-core";
import type { ScreenshotOutput, Snapshot } from "@george43g/shared-types";
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonClient } from "../src/client/daemon-client.js";
import { type DaemonHandle, startDaemon } from "../src/daemon/index.js";
import { ensureToken } from "../src/daemon/token.js";

// Disjoint port band from the other integration suites (18790–19289 default,
// content uses 20100–20499) so parallel test files can't collide.
const WS_PORT = randomWsPort(20600, 400);
const CAPTURE_URL = "data:image/jpeg;base64,/9j/4AAQ";

let tmp: string;
let daemon: DaemonHandle | null = null;
let env: { restore(): void } | null = null;
let ws: { restore(): void } | null = null;
let fc: FakeChrome | null = null;
let sock: DaemonSocket | null = null;
let token = "";

const fakeWindows = () => [
  makeChromeWindow({
    id: 812,
    tabs: [
      makeChromeTab({ id: 4001, windowId: 812, index: 0, active: true, url: "https://a.example/" }),
      makeChromeTab({
        id: 4002,
        windowId: 812,
        index: 1,
        active: false,
        url: "https://b.example/",
      }),
    ],
  }),
];

beforeEach(async () => {
  tmp = makeTmpDir("browser-tab-shot-");
  env = withDaemonEnv(tmp, { browsers: "chrome", wsPort: WS_PORT });
  ws = installNodeWebSocket();
  fc = installFakeChrome({ windows: fakeWindows(), captureDataUrl: CAPTURE_URL });
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

function connect(): DaemonSocket {
  const s = new DaemonSocket({ port: WS_PORT, token, browser: "chrome", extVersion: "test" });
  sock = s;
  s.start();
  return s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitConnected(client: DaemonClient, ms = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const snap = await client.request<Snapshot>("getSnapshot");
    if (snap.browsers.find((b) => b.browser === "chrome")?.dataSource === "extension") return;
    if (Date.now() - start > ms) throw new Error("extension never became authoritative");
    await sleep(25);
  }
}

describe("tier-1 screenshots over the real socket", () => {
  it("captures the active tab, writes a jpeg, and reports metadata", async () => {
    connect();
    const client = new DaemonClient();
    try {
      await waitConnected(client);
      const shot = await client.request<ScreenshotOutput>("screenshot", {
        tabId: "t:chrome:x4001",
      });
      expect(shot.tier).toBe("tab");
      expect(shot.cached).toBe(false);
      expect(shot.format).toBe("jpeg");
      expect(typeof shot.navEpoch).toBe("number");
      expect(existsSync(shot.path)).toBe(true);
      expect(statSync(shot.path).size).toBe(shot.bytes);
      // captureVisibleTab was called for window 812.
      const calls = fc?.calls["tabs.captureVisibleTab"] ?? [];
      expect(calls.length).toBe(1);
      expect(calls[0]?.[0]).toBe(812);
    } finally {
      client.close();
    }
  });

  it("serves the second identical request from cache (no new capture)", async () => {
    connect();
    const client = new DaemonClient();
    try {
      await waitConnected(client);
      const first = await client.request<ScreenshotOutput>("screenshot", {
        tabId: "t:chrome:x4001",
      });
      expect(first.cached).toBe(false);
      const second = await client.request<ScreenshotOutput>("screenshot", {
        tabId: "t:chrome:x4001",
      });
      expect(second.cached).toBe(true);
      expect(second.path).toBe(first.path);
      expect(fc?.calls["tabs.captureVisibleTab"]?.length).toBe(1);
    } finally {
      client.close();
    }
  });

  it("refuses a non-active tab without focus, captures it with focus:true", async () => {
    connect();
    const client = new DaemonClient();
    try {
      await waitConnected(client);
      await expect(
        client.request<ScreenshotOutput>("screenshot", { tabId: "t:chrome:x4002" }),
      ).rejects.toThrow(/active tab/i);

      const shot = await client.request<ScreenshotOutput>("screenshot", {
        tabId: "t:chrome:x4002",
        focus: true,
      });
      expect(shot.tier).toBe("tab");
      // focus:true activated the background tab before capturing.
      const updates = fc?.calls["tabs.update"] ?? [];
      expect(
        updates.some((c) => c[0] === 4002 && (c[1] as { active?: boolean })?.active === true),
      ).toBe(true);
    } finally {
      client.close();
    }
  });

  it("errors clearly for an AppleScript-generation handle", async () => {
    connect();
    const client = new DaemonClient();
    try {
      await waitConnected(client);
      await expect(
        client.request<ScreenshotOutput>("screenshot", { tabId: "t:safari:w1:i1" }),
      ).rejects.toThrow(/extension/i);
    } finally {
      client.close();
    }
  });
});
