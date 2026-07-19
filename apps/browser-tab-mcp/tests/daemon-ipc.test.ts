/**
 * In-process daemon tests: start the daemon components against the fake
 * adapter and a temp socket, then drive them through DaemonClient —
 * exactly the pathway MCP/CLI/TUI clients use.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Snapshot } from "@george43g/shared-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonClient, DaemonUnavailableError } from "../src/client/daemon-client.js";
import { type DaemonHandle, startDaemon } from "../src/daemon/index.js";
import type { DaemonEvent } from "../src/daemon/state.js";
import { diffSnapshots } from "../src/daemon/state.js";

let tmp: string;
let daemon: DaemonHandle | null = null;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "browser-tab-test-"));
  process.env.BROWSER_TAB_FAKE_ADAPTER = "1";
  process.env.BROWSER_TAB_BROWSERS = "chrome,safari";
  process.env.BROWSER_TAB_SOCKET_PATH = join(tmp, "daemon.sock");
  process.env.BROWSER_TAB_SNAPSHOT_PATH = join(tmp, "snapshot.json");
  process.env.BROWSER_TAB_CACHE_DIR = tmp;
  process.env.BROWSER_TAB_POLL_MS = "60000"; // no surprise ticks mid-test
});

afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  for (const key of [
    "BROWSER_TAB_FAKE_ADAPTER",
    "BROWSER_TAB_BROWSERS",
    "BROWSER_TAB_SOCKET_PATH",
    "BROWSER_TAB_SNAPSHOT_PATH",
    "BROWSER_TAB_CACHE_DIR",
    "BROWSER_TAB_POLL_MS",
  ]) {
    delete process.env[key];
  }
  rmSync(tmp, { recursive: true, force: true });
});

async function startTestDaemon(): Promise<DaemonHandle> {
  daemon = await startDaemon();
  // Wait for the first scan so getSnapshot has real content.
  await daemon.loop.refresh();
  return daemon;
}

describe("daemon IPC", () => {
  it("serves getSnapshot with daemon source and fake data", async () => {
    await startTestDaemon();
    const client = new DaemonClient();
    try {
      const snapshot = await client.request<Snapshot>("getSnapshot");
      expect(snapshot.source).toBe("daemon");
      expect(snapshot.browsers.map((b) => b.browser).sort()).toEqual(["chrome", "safari"]);
      expect(snapshot.browsers[0]?.windows.length).toBeGreaterThan(0);
    } finally {
      client.close();
    }
  });

  it("answers status with poll interval and per-browser counts", async () => {
    await startTestDaemon();
    const client = new DaemonClient();
    try {
      const status = await client.request<Record<string, unknown>>("status");
      expect(status.pid).toBe(process.pid);
      expect(status.pollMs).toBe(60000);
      const browsers = status.browsers as { browser: string; tabCount: number }[];
      expect(browsers.find((b) => b.browser === "chrome")?.tabCount).toBeGreaterThan(0);
    } finally {
      client.close();
    }
  });

  it("routes commands to the owning adapter", async () => {
    await startTestDaemon();
    const client = new DaemonClient();
    try {
      const result = await client.request<{ ok: boolean; command: string; browser: string }>(
        "command",
        { kind: "focus_tab", tabId: "t:chrome:9900" },
      );
      expect(result.ok).toBe(true);
      expect(result.command).toBe("focus_tab");
      expect(result.browser).toBe("chrome");
    } finally {
      client.close();
    }
  });

  it("rejects malformed command handles with a usable error", async () => {
    await startTestDaemon();
    const client = new DaemonClient();
    try {
      await expect(
        client.request("command", { kind: "focus_tab", tabId: "not-a-handle" }),
      ).rejects.toThrow(/Malformed handle/);
    } finally {
      client.close();
    }
  });

  it("subscribe primes with a snapshot event and unsubscribes cleanly", async () => {
    await startTestDaemon();
    const client = new DaemonClient();
    try {
      const events: DaemonEvent[] = [];
      const unsubscribe = await client.subscribe((e) => events.push(e));
      await new Promise((r) => setTimeout(r, 50));
      expect(events.some((e) => e.event === "snapshot")).toBe(true);
      unsubscribe();
    } finally {
      client.close();
    }
  });

  it("refresh returns a fresh snapshot", async () => {
    await startTestDaemon();
    const client = new DaemonClient();
    try {
      const snapshot = await client.request<Snapshot>("refresh");
      expect(snapshot.browsers.length).toBe(2);
    } finally {
      client.close();
    }
  });

  it("writes the snapshot cache file", async () => {
    const d = await startTestDaemon();
    // Writer is debounced; force the flush through stop().
    await d.stop();
    daemon = null;
    expect(existsSync(join(tmp, "snapshot.json"))).toBe(true);
    expect(existsSync(join(tmp, "last.json"))).toBe(true);
  });

  it("shutdown unlinks the socket", async () => {
    const d = await startTestDaemon();
    const path = process.env.BROWSER_TAB_SOCKET_PATH ?? "";
    expect(existsSync(path)).toBe(true);
    await d.stop();
    daemon = null;
    expect(existsSync(path)).toBe(false);
  });

  it("client throws DaemonUnavailableError when nothing listens", async () => {
    const client = new DaemonClient(join(tmp, "nonexistent.sock"));
    await expect(client.request("getSnapshot")).rejects.toThrow(DaemonUnavailableError);
  });

  it("a second daemon on the same socket refuses to start", async () => {
    await startTestDaemon();
    await expect(startDaemon()).rejects.toThrow(/already listening/);
  });
});

describe("diffSnapshots", () => {
  function snap(tabs: { tabId: string; url: string; index: number; active?: boolean }[]): Snapshot {
    return {
      version: 1,
      generatedAt: 0,
      source: "daemon",
      browsers: [
        {
          browser: "chrome",
          bundleId: "x",
          pid: 1,
          running: true,
          extensionConnected: false,
          dataSource: "applescript",
          windows: [
            {
              windowId: "w:chrome:1",
              cgWindowId: null,
              title: "t",
              bounds: null,
              focused: false,
              incognito: false,
              activeTabIndex: 0,
              tabCount: tabs.length,
              tabs: tabs.map((t) => ({
                tabId: t.tabId,
                index: t.index,
                url: t.url,
                title: "t",
                active: t.active ?? false,
                pinned: false,
                audible: false,
                discarded: false,
              })),
            },
          ],
        },
      ],
    };
  }

  it("emits tab-created / tab-removed / tab-moved / tab-activated", () => {
    const prev = snap([
      { tabId: "t:chrome:1", url: "https://a.test/", index: 0, active: true },
      { tabId: "t:chrome:2", url: "https://b.test/", index: 1 },
    ]);
    const next = snap([
      { tabId: "t:chrome:2", url: "https://b.test/", index: 0, active: true },
      { tabId: "t:chrome:3", url: "https://c.test/", index: 1 },
    ]);
    const kinds = diffSnapshots(prev, next).map((e) => e.event);
    expect(kinds).toContain("tab-created"); // t:chrome:3
    expect(kinds).toContain("tab-removed"); // t:chrome:1
    expect(kinds).toContain("tab-moved"); // t:chrome:2 index 1→0
    expect(kinds).toContain("tab-activated"); // t:chrome:2 became active
  });

  it("emits tab-updated on url change", () => {
    const prev = snap([{ tabId: "t:chrome:1", url: "https://a.test/", index: 0 }]);
    const next = snap([{ tabId: "t:chrome:1", url: "https://a.test/other", index: 0 }]);
    const events = diffSnapshots(prev, next);
    expect(events.map((e) => e.event)).toEqual(["tab-updated"]);
  });

  it("emits nothing when nothing changed", () => {
    const s = snap([{ tabId: "t:chrome:1", url: "https://a.test/", index: 0 }]);
    expect(diffSnapshots(s, s)).toEqual([]);
  });
});
