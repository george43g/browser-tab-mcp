/**
 * End-to-end page content & annotations: IPC `getPage` → daemon getPage →
 * ext.sendCommand("extract_content") → the REAL extension-core executeCommand
 * → the fake chrome scripting.executeScript (returns a fixture payload), over
 * a real loopback WebSocket. Proves the two-step injection round-trips,
 * content is sanitized + cached per navEpoch, and the annotation IPC works.
 */

import { rmSync } from "node:fs";
import { DaemonSocket } from "@george43g/extension-core";
import type { AnnotateOutput, GetPageOutput, Snapshot } from "@george43g/shared-types";
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

// Disjoint port band from the other integration suites (default 18790–19289)
// so parallel test files can't collide on the WS server port.
const WS_PORT = randomWsPort(20100, 400);
let tmp: string;
let daemon: DaemonHandle | null = null;
let env: { restore(): void } | null = null;
let ws: { restore(): void } | null = null;
let fc: FakeChrome | null = null;
let sock: DaemonSocket | null = null;
let token = "";

const FIXTURE = {
  mode: "text",
  url: "https://tab.example/",
  title: "Fixture Article",
  text: `Reader mode body${String.fromCharCode(0)}with a control char.`,
  byline: "By Nobody",
};

const fakeWindows = () => [
  makeChromeWindow({
    id: 812,
    tabs: [
      makeChromeTab({
        id: 4001,
        windowId: 812,
        index: 0,
        active: true,
        url: "https://tab.example/",
      }),
    ],
  }),
];

beforeEach(async () => {
  tmp = makeTmpDir("browser-tab-content-");
  env = withDaemonEnv(tmp, { browsers: "chrome", wsPort: WS_PORT });
  ws = installNodeWebSocket();
  fc = installFakeChrome({
    windows: fakeWindows(),
    scriptResult: (mode?: string) => ({ ...FIXTURE, mode }),
  });
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

describe("page content over the real socket", () => {
  it("extracts, sanitizes, and returns content with navEpoch + cached flag", async () => {
    connect();
    const client = new DaemonClient();
    try {
      await waitConnected(client);
      const page = await client.request<GetPageOutput>("getPage", {
        tabId: "t:chrome:x4001",
        mode: "text",
      });
      expect(page.cached).toBe(false);
      expect(page.title).toBe("Fixture Article");
      // Control char replaced (sanitizeContent), not truncated.
      expect(page.text).toBe(`Reader mode body${String.fromCharCode(0xfffd)}with a control char.`);
      expect(typeof page.navEpoch).toBe("number");

      // The two-step injection ran: a files-define then a func-call.
      const calls = fc?.calls["scripting.executeScript"] ?? [];
      expect(calls.length).toBeGreaterThanOrEqual(2);
      const define = calls[0]?.[0] as { target: { tabId: number }; files?: string[] };
      expect(define.target.tabId).toBe(4001);
      expect(define.files).toEqual(["extract.js"]);
    } finally {
      client.close();
    }
  });

  it("serves the second identical request from cache", async () => {
    connect();
    const client = new DaemonClient();
    try {
      await waitConnected(client);
      const first = await client.request<GetPageOutput>("getPage", {
        tabId: "t:chrome:x4001",
        mode: "text",
      });
      expect(first.cached).toBe(false);
      const injectionsAfterFirst = fc?.calls["scripting.executeScript"]?.length ?? 0;

      const second = await client.request<GetPageOutput>("getPage", {
        tabId: "t:chrome:x4001",
        mode: "text",
      });
      expect(second.cached).toBe(true);
      expect(second.text).toBe(first.text);
      // No new injection on the cache hit.
      expect(fc?.calls["scripting.executeScript"]?.length ?? 0).toBe(injectionsAfterFirst);
    } finally {
      client.close();
    }
  });

  it("force re-extracts even on a cache hit", async () => {
    connect();
    const client = new DaemonClient();
    try {
      await waitConnected(client);
      await client.request<GetPageOutput>("getPage", { tabId: "t:chrome:x4001", mode: "text" });
      const after = fc?.calls["scripting.executeScript"]?.length ?? 0;
      const forced = await client.request<GetPageOutput>("getPage", {
        tabId: "t:chrome:x4001",
        mode: "text",
        force: true,
      });
      expect(forced.cached).toBe(false);
      expect(fc?.calls["scripting.executeScript"]?.length ?? 0).toBeGreaterThan(after);
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
        client.request<GetPageOutput>("getPage", { tabId: "t:safari:w1:i1", mode: "text" }),
      ).rejects.toThrow(/extension/i);
    } finally {
      client.close();
    }
  });
});

describe("annotations over the real socket", () => {
  it("writes then reads a URL-keyed note", async () => {
    const client = new DaemonClient();
    try {
      const set = await client.request<AnnotateOutput>("annotate", {
        url: "https://tab.example/x",
        note: "cached summary",
      });
      expect(set.existed).toBe(false);
      const get = await client.request<AnnotateOutput>("annotate", {
        url: "https://tab.example/x",
      });
      expect(get.existed).toBe(true);
      expect(get.note).toBe("cached summary");
    } finally {
      client.close();
    }
  });
});
