/**
 * End-to-end write-side control: IPC `command` → daemon executeCommand →
 * ext.sendCommand → the REAL extension-core executeCommand → the fake chrome
 * API, over a real loopback WebSocket. Proves the PR3 commands (tab_action,
 * group_tabs, open_window, set_window, close_window) round-trip and land on
 * the right chrome.* calls with opaque handles converted at both ends.
 */

import { rmSync } from "node:fs";
import { DaemonSocket } from "@george43g/extension-core";
import type { CommandResult, Snapshot } from "@george43g/shared-types";
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

const WS_PORT = randomWsPort(23500, 400);
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
      makeChromeTab({ id: 4001, windowId: 812, index: 0, active: true }),
      makeChromeTab({ id: 4002, windowId: 812, index: 1, active: false }),
    ],
  }),
];

beforeEach(async () => {
  tmp = makeTmpDir("browser-tab-write-");
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

function connect(): DaemonSocket {
  const s = new DaemonSocket({ port: WS_PORT, token, browser: "chrome", extVersion: "test" });
  sock = s;
  s.start();
  return s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The budget covers a real WebSocket handshake plus the daemon's next merge
 * pass, so it is wall-clock sensitive. 2s was enough locally but flaked on
 * cold, shared macOS CI runners ("extension never became authoritative") —
 * this is a scheduling limit, not a correctness one, so the generous budget
 * costs nothing on the happy path (the loop returns as soon as it connects).
 */
async function waitConnected(client: DaemonClient, ms = 15_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const snap = await client.request<Snapshot>("getSnapshot");
    if (snap.browsers.find((b) => b.browser === "chrome")?.dataSource === "extension") return;
    if (Date.now() - start > ms) throw new Error("extension never became authoritative");
    await sleep(25);
  }
}

describe("write-side commands over the real socket", () => {
  it("open_window creates a window with the given urls", async () => {
    connect();
    const client = new DaemonClient();
    try {
      await waitConnected(client);
      const r = await client.request<CommandResult>("command", {
        kind: "open_window",
        urls: ["https://a.example/", "https://b.example/"],
      });
      expect(r.ok).toBe(true);
      // fake windows.create returns id 900 → x-handle.
      expect(r.windowId).toBe("w:chrome:x900");
      expect((r.payload as { tabCount?: number }).tabCount).toBe(2);
      const call = fc?.calls["windows.create"]?.[0]?.[0] as { url?: string[] };
      expect(call.url).toEqual(["https://a.example/", "https://b.example/"]);
    } finally {
      client.close();
    }
  });

  it("tab_action mute drives tabs.update({muted:true})", async () => {
    connect();
    const client = new DaemonClient();
    try {
      await waitConnected(client);
      const r = await client.request<CommandResult>("command", {
        kind: "tab_action",
        tabId: "t:chrome:x4001",
        action: "mute",
      });
      expect(r.ok).toBe(true);
      expect((r.payload as { action?: string }).action).toBe("mute");
      expect(
        fc?.calls["tabs.update"]?.some((c) => (c[1] as { muted?: boolean }).muted === true),
      ).toBe(true);
    } finally {
      client.close();
    }
  });

  it("group_tabs create returns a g-handle and calls tabs.group", async () => {
    connect();
    const client = new DaemonClient();
    try {
      await waitConnected(client);
      const r = await client.request<CommandResult>("command", {
        kind: "group_tabs",
        action: "create",
        tabIds: ["t:chrome:x4001", "t:chrome:x4002"],
        title: "Work",
        color: "blue",
      });
      expect(r.ok).toBe(true);
      expect(r.groupId).toBe("g:chrome:x700");
      const grouped = fc?.calls["tabs.group"]?.[0]?.[0] as { tabIds: number[] };
      expect(grouped.tabIds).toEqual([4001, 4002]);
      const updated = fc?.calls["tabGroups.update"]?.[0]?.[1] as { title?: string; color?: string };
      expect(updated).toMatchObject({ title: "Work", color: "blue" });
    } finally {
      client.close();
    }
  });

  it("set_window then close_window drive windows.update/remove with the native id", async () => {
    connect();
    const client = new DaemonClient();
    try {
      await waitConnected(client);
      const set = await client.request<CommandResult>("command", {
        kind: "set_window",
        windowId: "w:chrome:x812",
        bounds: { x: 10, y: 20, w: 800, h: 600 },
      });
      expect(set.ok).toBe(true);
      expect(fc?.calls["windows.update"]?.some((c) => c[0] === 812)).toBe(true);

      const closed = await client.request<CommandResult>("command", {
        kind: "close_window",
        windowId: "w:chrome:x812",
      });
      expect(closed.ok).toBe(true);
      expect(fc?.calls["windows.remove"]?.[0]?.[0]).toBe(812);
    } finally {
      client.close();
    }
  });

  // focus_tab's contract: raise by default, opt out explicitly, and hand back
  // enough window state for a window manager to act without a second read.
  it("focus_tab raises by default and returns the daemon-correlated cgWindowId", async () => {
    connect();
    const client = new DaemonClient();
    try {
      await waitConnected(client);
      const r = await client.request<CommandResult>("command", {
        kind: "focus_tab",
        tabId: "t:chrome:x4001",
      });
      expect(r.ok).toBe(true);
      expect(fc?.calls["windows.update"]?.[0]).toEqual([812, { focused: true }]);
      // Correlation only exists in the daemon, so the KEY being present is the
      // signal that the daemon enriched the result. Its value is null here
      // because nothing correlates a fake window to a CoreGraphics id.
      expect(Object.hasOwn(r, "cgWindowId")).toBe(true);
      expect(r.cgWindowId).toBeNull();
      expect(r.wasMinimized).toBe(false);
      expect(r.windowState).toBe("normal");
    } finally {
      client.close();
    }
  });

  it("focus_tab with raiseWindow:false never touches chrome.windows", async () => {
    connect();
    const client = new DaemonClient();
    try {
      await waitConnected(client);
      const r = await client.request<CommandResult>("command", {
        kind: "focus_tab",
        tabId: "t:chrome:x4001",
        raiseWindow: false,
      });
      expect(r.ok).toBe(true);
      expect(fc?.calls["tabs.update"]?.[0]).toEqual([4001, { active: true }]);
      expect(fc?.calls["windows.update"]).toBeUndefined();
    } finally {
      client.close();
    }
  });

  it("group_tabs on a browser without a connected extension errors cleanly", async () => {
    connect();
    const client = new DaemonClient();
    try {
      await waitConnected(client);
      await expect(
        client.request<CommandResult>("command", {
          kind: "group_tabs",
          action: "create",
          tabIds: ["t:safari:w1:i1"],
        }),
      ).rejects.toThrow(/extension/i);
    } finally {
      client.close();
    }
  });
});
