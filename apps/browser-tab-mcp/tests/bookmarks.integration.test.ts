/**
 * bookmarks end-to-end: IPC `bookmarks` → daemon orchestrator → ext.sendCommand
 * → the REAL extension-core command → the fake chrome.bookmarks API, over a
 * real loopback WebSocket.
 *
 * Every layer here is the production one except the browser API itself, which
 * is the only part that cannot run in Node. That matters for a WRITE surface:
 * `remove` on a folder deletes a subtree, and a fixture-level test would not
 * have exercised the folder-vs-bookmark probe that makes it use `removeTree`.
 */

import { rmSync } from "node:fs";
import { DaemonSocket } from "@george43g/extension-core";
import type { BookmarksOutput, Snapshot } from "@george43g/shared-types";
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

const WS_PORT = randomWsPort(21500, 400);
let tmp: string;
let daemon: DaemonHandle | null = null;
let env: { restore(): void } | null = null;
let ws: { restore(): void } | null = null;
let fc: FakeChrome | null = null;
let sock: DaemonSocket | null = null;
let client: DaemonClient | null = null;
let token = "";

/** A bar with one folder ("Work") holding two bookmarks, plus a loose one. */
const seed = [
  { id: "1", title: "Bookmarks Bar" },
  { id: "10", parentId: "1", title: "Work" },
  { id: "11", parentId: "10", title: "Fastify", url: "https://fastify.dev" },
  { id: "12", parentId: "10", title: "GitHub", url: "https://github.com" },
  { id: "20", parentId: "1", title: "Search", url: "https://duckduckgo.com" },
];

beforeEach(async () => {
  tmp = makeTmpDir("browser-tab-bm-");
  env = withDaemonEnv(tmp, { browsers: "chrome", wsPort: WS_PORT });
  ws = installNodeWebSocket();
  fc = installFakeChrome({
    windows: [makeChromeWindow({ id: 900, tabs: [makeChromeTab({ id: 5001, windowId: 900 })] })],
    bookmarkNodes: seed,
  });
  token = ensureToken();
  daemon = await startDaemon();
  await daemon.loop.refresh();
});

afterEach(async () => {
  // MUST come before daemon.stop(): an open DaemonClient holds the socket and
  // stop() waits on it, which hangs this hook rather than failing a test.
  client?.close();
  client = null;
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

async function connected(): Promise<DaemonClient> {
  const s = new DaemonSocket({ port: WS_PORT, token, browser: "chrome", extVersion: "test" });
  sock = s;
  s.start();
  const c = new DaemonClient();
  client = c;
  const start = Date.now();
  for (;;) {
    const snap = await c.request<Snapshot>("getSnapshot");
    if (snap.browsers.find((b) => b.browser === "chrome")?.dataSource === "extension") break;
    if (Date.now() - start > 15_000) throw new Error("extension never became authoritative");
    await sleep(25);
  }
  return c;
}

const call = (c: DaemonClient, params: Record<string, unknown>) =>
  c.request<BookmarksOutput>("bookmarks", params);

describe("bookmarks over the real socket", () => {
  // 15s: this crossed vitest's 5s default at 5038ms on a cold ubuntu runner
  // (2026-08-20) — socket setup cost, not product latency.
  it("searches title and url", { timeout: 15_000 }, async () => {
    const c = await connected();
    const out = await call(c, { action: "search", query: "github" });
    expect(out.browser).toBe("chrome");
    expect(out.nodes.map((n) => n.id)).toEqual(["12"]);
    expect(out.nodes[0]?.url).toBe("https://github.com");
  });

  it("lists a folder's direct children, not its subtree", async () => {
    const c = await connected();
    const out = await call(c, { action: "list", folderId: "10" });
    expect(out.nodes.map((n) => n.title).sort()).toEqual(["Fastify", "GitHub"]);
  });

  it("distinguishes a folder from a bookmark by the ABSENCE of url", async () => {
    // This is the whole shape of the data — a folder that arrived with url:""
    // would be indistinguishable from a bookmark pointing nowhere.
    const c = await connected();
    const out = await call(c, { action: "list", folderId: "1" });
    const work = out.nodes.find((n) => n.title === "Work");
    expect(work, "the folder should be listed").toBeTruthy();
    expect(work?.url).toBeUndefined();
    expect(out.nodes.find((n) => n.title === "Search")?.url).toBe("https://duckduckgo.com");
  });

  it("lists the top-level BARS at the root, not their contents", async () => {
    // Chrome's getTree returns a synthetic root whose children are the bars
    // ("Bookmarks Bar", "Other Bookmarks"). Listing the root must return those,
    // one level down — not everything, and not the synthetic root itself.
    const c = await connected();
    const out = await call(c, { action: "list" });
    expect(out.nodes.map((n) => n.title)).toEqual(["Bookmarks Bar"]);
    expect(
      out.nodes.map((n) => n.id),
      "the synthetic root must not appear",
    ).not.toContain("0");
  });

  it("recursive flattens the subtree instead of nesting it", async () => {
    const c = await connected();
    const flat = await call(c, { action: "list", recursive: true });
    const titles = flat.nodes.map((n) => n.title);
    expect(titles).toContain("Work");
    expect(titles).toContain("Fastify");
    // Flat means every row is a row — parentId carries the structure.
    expect(flat.nodes.find((n) => n.title === "Fastify")?.parentId).toBe("10");
  });

  it("creates a bookmark and returns the new node", async () => {
    const c = await connected();
    const out = await call(c, {
      action: "create",
      parentId: "10",
      title: "Vitest",
      url: "https://vitest.dev",
    });
    expect(out.nodes).toHaveLength(1);
    expect(out.nodes[0]?.url).toBe("https://vitest.dev");
    const listed = await call(c, { action: "list", folderId: "10" });
    expect(listed.nodes.map((n) => n.title)).toContain("Vitest");
  });

  it("creates a FOLDER when url is omitted", async () => {
    const c = await connected();
    const out = await call(c, { action: "create", parentId: "1", title: "Reading" });
    expect(out.nodes[0]?.url).toBeUndefined();
  });

  it("updates a title", async () => {
    const c = await connected();
    const out = await call(c, { action: "update", id: "20", title: "DDG" });
    expect(out.nodes[0]?.title).toBe("DDG");
  });

  it("removes a NON-EMPTY folder by falling back to removeTree", async () => {
    // The fake rejects `remove` on a non-empty folder exactly as Chrome does,
    // so this proves the command probes the node and picks removeTree — the
    // one branch a fixture-level test could not reach.
    const c = await connected();
    const out = await call(c, { action: "remove", id: "10" });
    expect(out.removed).toBe("10");
    const left = await call(c, { action: "search", query: "fastify" });
    expect(left.nodes, "the subtree should be gone too").toEqual([]);
  });

  it("removes a plain bookmark", async () => {
    const c = await connected();
    await call(c, { action: "remove", id: "20" });
    expect((await call(c, { action: "search", query: "duckduckgo" })).nodes).toEqual([]);
  });

  it("errors, rather than returning empty, for a browser with no extension", async () => {
    // An empty list would be indistinguishable from "you have no bookmarks",
    // and a caller might act on that.
    const c = await connected();
    await expect(call(c, { action: "search", browser: "safari" })).rejects.toThrow(
      /no connected extension/i,
    );
  });

  it("reports the bookmarks capability so consumers can gate on the map", async () => {
    const c = await connected();
    const snap = await c.request<Snapshot>("getSnapshot");
    const chrome = snap.browsers.find((b) => b.browser === "chrome");
    expect(chrome?.capabilities?.bookmarks).toBe(true);
  });
});
