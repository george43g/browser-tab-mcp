/**
 * End-to-end Chrome-family history: IPC `history` → daemon history orchestrator
 * → ext.sendCommand("history_search") → the REAL extension-core executeCommand →
 * the fake chrome.history.search (returns configured HistoryItems), over a real
 * loopback WebSocket. Proves the command round-trips, lastVisitTime becomes
 * visitTime, and rows are tagged browser:"chrome".
 */

import { DaemonSocket } from "@george43g/extension-core";
import type { HistoryOutput, Snapshot } from "@george43g/shared-types";
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
// content 20100–20499, screenshot 20600–20999) so parallel files can't collide.
const WS_PORT = randomWsPort(21000, 400);

const HISTORY_ITEMS = [
  { url: "https://alpha.example/", title: "Alpha", lastVisitTime: 5000, visitCount: 3 },
  { url: "https://bravo.example/", title: "Bravo", lastVisitTime: 2000, visitCount: 1 },
];

let tmp: string;
let daemon: DaemonHandle | null = null;
let env: { restore(): void } | null = null;
let ws: { restore(): void } | null = null;
let fc: FakeChrome | null = null;
let sock: DaemonSocket | null = null;
let token = "";

const fakeWindows = () => [
  makeChromeWindow({
    id: 700,
    tabs: [makeChromeTab({ id: 5001, windowId: 700, index: 0, active: true, url: "https://x/" })],
  }),
];

beforeEach(async () => {
  tmp = makeTmpDir("browser-tab-history-");
  env = withDaemonEnv(tmp, { browsers: "chrome", wsPort: WS_PORT });
  ws = installNodeWebSocket();
  fc = installFakeChrome({ windows: fakeWindows(), historyItems: HISTORY_ITEMS });
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

describe("chrome history over the real socket", () => {
  it("round-trips history_search and maps HistoryItems to rows", async () => {
    connect();
    const client = new DaemonClient();
    try {
      await waitConnected(client);
      const out = await client.request<HistoryOutput>("history", { browser: "chrome" });
      expect(out.rows).toHaveLength(2);
      expect(out.rows[0]).toMatchObject({
        url: "https://alpha.example/",
        title: "Alpha",
        visitTime: 5000, // lastVisitTime passthrough
        visitCount: 3,
        browser: "chrome",
      });
      // Newest-first ordering.
      expect(out.rows[1]?.visitTime).toBe(2000);
      // The extension's chrome.history.search was actually invoked.
      expect(fc?.calls["history.search"]?.length).toBe(1);
    } finally {
      client.close();
    }
  });

  it("errors clearly when asking for a browser whose extension is absent", async () => {
    connect();
    const client = new DaemonClient();
    try {
      await waitConnected(client);
      await expect(client.request<HistoryOutput>("history", { browser: "brave" })).rejects.toThrow(
        /extension connected/i,
      );
    } finally {
      client.close();
    }
  });
});
