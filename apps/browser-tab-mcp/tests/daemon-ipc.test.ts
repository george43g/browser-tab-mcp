/**
 * In-process daemon tests: start the daemon components against the fake
 * adapter and a temp socket, then drive them through DaemonClient —
 * exactly the pathway MCP/CLI/TUI clients use.
 */

import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Snapshot } from "@george43g/shared-types";
import {
  makeBrowserState,
  makeContractTab,
  makeContractWindow,
  makeSnapshot,
  makeTmpDir,
  withDaemonEnv,
} from "@george43g/test-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonClient, DaemonUnavailableError } from "../src/client/daemon-client.js";
import { type DaemonHandle, startDaemon } from "../src/daemon/index.js";
import type { DaemonEvent } from "../src/daemon/state.js";
import { diffSnapshots } from "../src/daemon/state.js";

let tmp: string;
let daemon: DaemonHandle | null = null;
let env: { restore(): void } | null = null;

beforeEach(() => {
  tmp = makeTmpDir();
  env = withDaemonEnv(tmp, { browsers: "chrome,safari" });
});

afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  env?.restore();
  env = null;
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
      // Revision rides IPC: contract version stays 2, state revision is separate.
      expect(snapshot.version).toBe(2);
      expect(snapshot.revision).toBeGreaterThanOrEqual(1);
      expect(snapshot.snapshotToken).toMatch(/^[0-9a-f]{8}:\d+$/);
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
    // The cached file is the stamped store snapshot, not an unstamped copy.
    const cached = JSON.parse(readFileSync(join(tmp, "snapshot.json"), "utf8")) as Snapshot;
    expect(cached.version).toBe(2);
    expect(cached.revision).toBeGreaterThanOrEqual(1);
    expect(cached.snapshotToken).toMatch(/^[0-9a-f]{8}:\d+$/);
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
    return makeSnapshot({
      browsers: [
        makeBrowserState({
          windows: [
            makeContractWindow({
              bounds: null,
              focused: false,
              tabs: tabs.map((t) =>
                makeContractTab({
                  tabId: t.tabId,
                  index: t.index,
                  url: t.url,
                  title: "t",
                  active: t.active ?? false,
                }),
              ),
            }),
          ],
        }),
      ],
    });
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

/**
 * The heartbeat is the liveness signal shell consumers (sketchybar plugins)
 * stat instead of forking `daemon status`. It must ride a COMPLETED engine
 * tick — a bare timer would keep beating while the read loop is wedged, which
 * is exactly the failure the consumer is trying to detect.
 */
describe("daemon heartbeat file", () => {
  const heartbeatFile = (): string => join(tmp, "heartbeat.json");

  it("appears once the daemon has completed a tick", async () => {
    await startTestDaemon();
    expect(existsSync(heartbeatFile())).toBe(true);
  });

  it("advances on each subsequent tick while the snapshot stays unchanged", async () => {
    const d = await startTestDaemon();
    const first = JSON.parse(readFileSync(heartbeatFile(), "utf8")) as { ts: number };
    const snapshotBefore = existsSync(join(tmp, "snapshot.json"))
      ? statSync(join(tmp, "snapshot.json")).mtimeMs
      : 0;

    const spin = Date.now();
    while (Date.now() === spin) {
      /* ensure ts can move */
    }
    await d.loop.refresh();

    const second = JSON.parse(readFileSync(heartbeatFile(), "utf8")) as { ts: number };
    expect(second.ts).toBeGreaterThan(first.ts);
    // ...and the unchanged snapshot was NOT rewritten: the two files carry
    // different meanings and must not be collapsed into one.
    const snapshotAfter = existsSync(join(tmp, "snapshot.json"))
      ? statSync(join(tmp, "snapshot.json")).mtimeMs
      : 0;
    expect(snapshotAfter).toBe(snapshotBefore);
  });

  it("is removed on a clean stop so a stopped daemon reads as down", async () => {
    const d = await startTestDaemon();
    expect(existsSync(heartbeatFile())).toBe(true);
    await d.stop();
    daemon = null;
    expect(existsSync(heartbeatFile())).toBe(false);
  });
});
