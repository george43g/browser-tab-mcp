/**
 * WS server ping/pong heartbeat: a session that stops answering pings is
 * terminated (so a dead/half-open extension can't keep serving stale
 * x-handles), while a session that keeps ponging survives indefinitely.
 * Drives ExtensionServer directly with a short ping interval so the two
 * outcomes are deterministic without real time.
 */

import type { BrowserId, BrowserState } from "@george43g/shared-types";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ExtensionServer } from "../src/daemon/ws-server.js";

const PORT = 19100 + Math.floor(Math.random() * 400);
const TOKEN = "hb-token";
const PING_MS = 40;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: ExtensionServer | null = null;
const disconnects: BrowserId[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets) s.terminate();
  sockets.length = 0;
  disconnects.length = 0;
  await server?.stop();
  server = null;
});

async function startServer(): Promise<ExtensionServer> {
  const srv = new ExtensionServer({
    port: PORT,
    token: TOKEN,
    pingIntervalMs: PING_MS,
    onSnapshot: (_b: BrowserId, _s: BrowserState) => {},
    onDisconnect: (b) => disconnects.push(b),
  });
  await srv.start();
  return srv;
}

/** Connect, say hello, wait for helloAck. If autoPong, reply to every ping. */
function connect(browser: BrowserId, autoPong: boolean): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
    sockets.push(ws);
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string; ts?: number };
      if (msg.type === "helloAck") resolve(ws);
      if (msg.type === "ping" && autoPong) ws.send(JSON.stringify({ type: "pong", ts: msg.ts }));
    });
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", browser, extVersion: "test", token: TOKEN }));
    });
  });
}

describe("WS heartbeat", () => {
  it("terminates a session that stops answering pings", async () => {
    server = await startServer();
    await connect("chrome", false); // never pongs
    expect(server.isConnected("chrome")).toBe(true);

    await sleep(PING_MS * 5); // two+ ping cycles with no pong → dropped
    expect(server.isConnected("chrome")).toBe(false);
    expect(disconnects).toContain("chrome");
  });

  it("keeps a session that keeps ponging", async () => {
    server = await startServer();
    await connect("brave", true); // auto-pongs

    await sleep(PING_MS * 5);
    expect(server.isConnected("brave")).toBe(true);
    expect(disconnects).not.toContain("brave");
  });
});
