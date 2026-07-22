/**
 * End-to-end journals: the REAL extension-core DaemonSocket emits immediate
 * focus/nav event frames (driven by firing the fake chrome events), the REAL
 * daemon ingests them into the JournalStore, and we read them back over the
 * IPC `journal` method via DaemonClient.
 */

import { rmSync } from "node:fs";
import { DaemonSocket } from "@george43g/extension-core";
import type { BrowserState, JournalOutput, Snapshot } from "@george43g/shared-types";
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

const WS_PORT = randomWsPort();
let tmp: string;
let daemon: DaemonHandle | null = null;
let env: { restore(): void } | null = null;
let ws: { restore(): void } | null = null;
let fc: FakeChrome | null = null;
let sock: DaemonSocket | null = null;

const fakeWindows = () => [
  makeChromeWindow({ id: 812, tabs: [makeChromeTab({ id: 4001, windowId: 812 })] }),
];

beforeEach(async () => {
  tmp = makeTmpDir("browser-tab-journal-int-");
  env = withDaemonEnv(tmp, { browsers: "chrome", wsPort: WS_PORT });
  ws = installNodeWebSocket();
  fc = installFakeChrome({ windows: fakeWindows() });
  const token = ensureToken();
  daemon = await startDaemon();
  await daemon.loop.refresh();
  sock = new DaemonSocket({ port: WS_PORT, token, browser: "chrome", extVersion: "test" });
  sock.start();
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitExtension(client: DaemonClient): Promise<void> {
  const start = Date.now();
  for (;;) {
    const snap = await client.request<Snapshot>("getSnapshot");
    const chrome = snap.browsers.find((b: BrowserState) => b.browser === "chrome");
    if (chrome?.dataSource === "extension") return;
    if (Date.now() - start > 2000) throw new Error("extension never became authoritative");
    await sleep(25);
  }
}

async function pollJournal(
  client: DaemonClient,
  params: Record<string, unknown>,
  pred: (j: JournalOutput) => boolean,
): Promise<JournalOutput> {
  const start = Date.now();
  for (;;) {
    const j = await client.request<JournalOutput>("journal", params);
    if (pred(j)) return j;
    if (Date.now() - start > 2000) throw new Error("journal condition not met");
    await sleep(25);
  }
}

describe("journals over the real socket", () => {
  it("records a tab focus emitted as an event frame", async () => {
    const client = new DaemonClient();
    try {
      await waitExtension(client);
      fc?.emit("tabs.onActivated", { tabId: 4001, windowId: 812 });
      const j = await pollJournal(client, { view: "recent", limit: 10 }, (out) =>
        out.focus.some((r) => r.tabId === "t:chrome:x4001" && r.source === "ext"),
      );
      const rec = j.focus.find((r) => r.tabId === "t:chrome:x4001");
      expect(rec?.kind).toBe("tab-focus");
      expect(rec?.windowId).toBe("w:chrome:x812");
    } finally {
      client.close();
    }
  });

  it("records a committed navigation as a journey entry with a navEpoch", async () => {
    const client = new DaemonClient();
    try {
      await waitExtension(client);
      fc?.emit("webNavigation.onCommitted", {
        tabId: 4001,
        url: "https://nav.example/",
        frameId: 0,
        transitionType: "link",
      });
      const j = await pollJournal(
        client,
        { view: "journey", tabId: "t:chrome:x4001", limit: 10 },
        (out) => out.nav.some((r) => r.url === "https://nav.example/"),
      );
      const rec = j.nav.find((r) => r.url === "https://nav.example/");
      expect(rec?.source).toBe("ext");
      expect(rec?.transition).toBe("link");
      expect(rec?.navEpoch).toBeGreaterThanOrEqual(1);
    } finally {
      client.close();
    }
  });

  it("ignores subframe navigations (frameId !== 0)", async () => {
    const client = new DaemonClient();
    try {
      await waitExtension(client);
      fc?.emit("webNavigation.onCommitted", {
        tabId: 4001,
        url: "https://iframe.example/",
        frameId: 7,
        transitionType: "auto_subframe",
      });
      await sleep(150);
      const j = await client.request<JournalOutput>("journal", {
        view: "journey",
        tabId: "t:chrome:x4001",
        limit: 10,
      });
      expect(j.nav.some((r) => r.url === "https://iframe.example/")).toBe(false);
    } finally {
      client.close();
    }
  });
});
