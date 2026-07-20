/**
 * Extension WebSocket pathway tests: a scripted fake extension client
 * (plain `ws`) drives auth, snapshot merge precedence, command round-trips
 * and disconnect fallback against a real daemon (fake AppleScript adapter,
 * temp socket, ephemeral WS port).
 */

import { rmSync } from "node:fs";
import type { Snapshot } from "@george43g/shared-types";
import {
  makeExtSnapshot,
  makeExtTab,
  makeExtWindow,
  makeTmpDir,
  randomWsPort,
  withDaemonEnv,
} from "@george43g/test-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { DaemonClient } from "../src/client/daemon-client.js";
import { type DaemonHandle, startDaemon } from "../src/daemon/index.js";
import { ensureToken } from "../src/daemon/token.js";

let tmp: string;
let daemon: DaemonHandle | null = null;
let token = "";
let env: { restore(): void } | null = null;
const WS_PORT = randomWsPort();

beforeEach(async () => {
  tmp = makeTmpDir("browser-tab-ws-test-");
  env = withDaemonEnv(tmp, { browsers: "chrome", wsPort: WS_PORT });
  token = ensureToken();
  daemon = await startDaemon();
  await daemon.loop.refresh();
});

afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  env?.restore();
  env = null;
  rmSync(tmp, { recursive: true, force: true });
});

interface FakeExtension {
  ws: WebSocket;
  send(msg: Record<string, unknown>): void;
  next(filter?: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  close(): void;
}

function connectFakeExtension(authToken: string): Promise<FakeExtension> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}/`);
    const queue: Record<string, unknown>[] = [];
    const waiters: {
      filter: (m: Record<string, unknown>) => boolean;
      resolve: (m: Record<string, unknown>) => void;
    }[] = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>;
      const idx = waiters.findIndex((w) => w.filter(msg));
      if (idx >= 0) {
        const [waiter] = waiters.splice(idx, 1);
        waiter?.resolve(msg);
      } else {
        queue.push(msg);
      }
    });
    ws.on("error", reject);
    ws.on("open", () => {
      ws.send(
        JSON.stringify({ type: "hello", browser: "chrome", extVersion: "test", token: authToken }),
      );
      resolve({
        ws,
        send: (msg) => ws.send(JSON.stringify(msg)),
        next: (filter = () => true) => {
          const queued = queue.findIndex((m) => filter(m));
          if (queued >= 0) {
            const [m] = queue.splice(queued, 1);
            return Promise.resolve(m as Record<string, unknown>);
          }
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error("timed out waiting for message")), 3000);
            waiters.push({
              filter,
              resolve: (m) => {
                clearTimeout(timer);
                res(m);
              },
            });
          });
        },
        close: () => ws.terminate(),
      });
    });
  });
}

const EXT_SNAPSHOT = makeExtSnapshot({
  windows: [makeExtWindow({ id: 812, tabs: [makeExtTab({ id: 4001, pinned: true })] })],
});

describe("extension WebSocket server", () => {
  it("rejects a bad token", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}/`);
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", browser: "chrome", extVersion: "t", token: "nope" }));
    });
    expect(await closed).toBe(4001);
  });

  it("acks a good token and merges extension snapshots (extension wins)", async () => {
    const ext = await connectFakeExtension(token);
    try {
      await ext.next((m) => m.type === "helloAck");
      ext.send(EXT_SNAPSHOT);
      await new Promise((r) => setTimeout(r, 150)); // remerge queue
      const client = new DaemonClient();
      try {
        const snapshot = await client.request<Snapshot>("getSnapshot");
        const chrome = snapshot.browsers.find((b) => b.browser === "chrome");
        expect(chrome?.dataSource).toBe("extension");
        expect(chrome?.extensionConnected).toBe(true);
        expect(chrome?.windows[0]?.windowId).toBe("w:chrome:x812");
        expect(chrome?.windows[0]?.tabs[0]?.tabId).toBe("t:chrome:x4001");
        expect(chrome?.windows[0]?.tabs[0]?.pinned).toBe(true);
        // pid backfilled from the poll side (fake adapter reports 4242).
        expect(chrome?.pid).toBe(4242);
      } finally {
        client.close();
      }
    } finally {
      ext.close();
    }
  });

  it("routes ext-handle commands over the socket and returns the mapped result", async () => {
    const ext = await connectFakeExtension(token);
    try {
      await ext.next((m) => m.type === "helloAck");
      ext.send(EXT_SNAPSHOT);
      await new Promise((r) => setTimeout(r, 150));

      // Answer the daemon's command like the real extension would.
      void ext
        .next((m) => m.type === "command")
        .then((cmd) => {
          expect(cmd.kind).toBe("move_tab");
          expect((cmd.args as { tabId: number }).tabId).toBe(4001);
          ext.send({
            type: "commandResult",
            requestId: cmd.requestId,
            ok: true,
            result: { tabId: 4001, windowId: 813, index: 2 },
          });
        });

      const client = new DaemonClient();
      try {
        const result = await client.request<{ ok: boolean; windowId: string; index: number }>(
          "command",
          { kind: "move_tab", tabId: "t:chrome:x4001", newWindow: true },
        );
        expect(result.ok).toBe(true);
        expect(result.windowId).toBe("w:chrome:x813");
        expect(result.index).toBe(2);
      } finally {
        client.close();
      }
    } finally {
      ext.close();
    }
  });

  it("falls back to AppleScript data when the extension disconnects", async () => {
    const ext = await connectFakeExtension(token);
    await ext.next((m) => m.type === "helloAck");
    ext.send(EXT_SNAPSHOT);
    await new Promise((r) => setTimeout(r, 150));
    ext.close();
    await new Promise((r) => setTimeout(r, 150));

    const client = new DaemonClient();
    try {
      const snapshot = await client.request<Snapshot>("getSnapshot");
      const chrome = snapshot.browsers.find((b) => b.browser === "chrome");
      expect(chrome?.dataSource).toBe("applescript");
      expect(chrome?.extensionConnected).toBe(false);
      expect(chrome?.windows[0]?.tabs[0]?.tabId).toMatch(/^t:chrome:\d+$/);
    } finally {
      client.close();
    }
  });

  it("rejects ext-generation handles when the extension is gone", async () => {
    const client = new DaemonClient();
    try {
      await expect(
        client.request("command", { kind: "focus_tab", tabId: "t:chrome:x4001" }),
      ).rejects.toThrow(/not\s+connected/i);
    } finally {
      client.close();
    }
  });
});
