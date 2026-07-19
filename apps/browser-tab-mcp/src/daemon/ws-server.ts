/**
 * Extension WebSocket server — 127.0.0.1-only, token-authenticated.
 *
 * One logical session per browser (a reconnect replaces the old socket).
 * Extensions stream debounced full snapshots; the daemon converts them to
 * the contract BrowserState shape (x-prefixed opaque ids) and feeds the
 * SourceMerger. Commands flow the other way with request ids + timeouts.
 *
 * Keepalive: the server sends a JSON {"type":"ping"} every 20s — actual
 * message traffic (not protocol-level ping frames) is what resets a
 * Chrome MV3 service worker's idle timer.
 */

import { sanitize } from "@george43g/mcp-kit";
import { envNum, info, error as logError, warn } from "@george43g/robustness";
import type {
  BrowserId,
  BrowserState,
  CommandResult,
  ExtServerMessage,
  ExtSnapshot,
} from "@george43g/shared-types";
import { ExtClientMessageSchema } from "@george43g/shared-types";
import { type WebSocket, WebSocketServer } from "ws";
import { specFor } from "../detect/engine.js";
import { makeExtTabId, makeExtWindowId } from "../detect/ids.js";
import { tokenMatches } from "./token.js";

const PING_INTERVAL_MS = 20_000;
const HELLO_TIMEOUT_MS = 3_000;
const COMMAND_TIMEOUT_MS = 5_000;

export function wsPort(): number {
  return envNum("BROWSER_TAB_WS_PORT", 8790);
}

interface Session {
  browser: BrowserId;
  socket: WebSocket;
}

export interface ExtensionServerOptions {
  port: number;
  token: string;
  onSnapshot: (browser: BrowserId, state: BrowserState) => void;
  onDisconnect: (browser: BrowserId) => void;
}

export class ExtensionServer {
  private wss: WebSocketServer | null = null;
  private sessions = new Map<BrowserId, Session>();
  private pending = new Map<
    number,
    { resolve: (r: CommandResult) => void; reject: (e: Error) => void }
  >();
  private nextRequestId = 1;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: ExtensionServerOptions) {}

  async start(): Promise<void> {
    this.wss = new WebSocketServer({ host: "127.0.0.1", port: this.opts.port });
    await new Promise<void>((resolve, reject) => {
      this.wss?.once("listening", resolve);
      this.wss?.once("error", reject);
    });
    this.wss.on("connection", (socket) => this.onConnection(socket));
    this.pingTimer = setInterval(() => this.pingAll(), PING_INTERVAL_MS);
    this.pingTimer.unref();
    info("ws_listening", { port: this.opts.port });
  }

  async stop(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const s of this.sessions.values()) s.socket.terminate();
    this.sessions.clear();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    this.wss = null;
  }

  isConnected(browser: BrowserId): boolean {
    return this.sessions.has(browser);
  }

  connectedBrowsers(): BrowserId[] {
    return [...this.sessions.keys()];
  }

  /** Send a command to a browser's extension and await its result. */
  async sendCommand(
    browser: BrowserId,
    kind: string,
    args: Record<string, unknown>,
  ): Promise<CommandResult> {
    const session = this.sessions.get(browser);
    if (!session) {
      throw new Error(
        `The ${browser} extension is not connected. Install/enable the browser-tab extension ` +
          `and paste the token from \`browser-tab daemon token\` into its options page.`,
      );
    }
    const requestId = this.nextRequestId++;
    const message: ExtServerMessage = { type: "command", requestId, kind: kind as never, args };
    return new Promise<CommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Extension command ${kind} timed out after ${COMMAND_TIMEOUT_MS}ms.`));
      }, COMMAND_TIMEOUT_MS);
      timer.unref();
      this.pending.set(requestId, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      session.socket.send(JSON.stringify(message));
    });
  }

  private pingAll(): void {
    const line = JSON.stringify({ type: "ping", ts: Date.now() });
    for (const s of this.sessions.values()) s.socket.send(line);
  }

  private onConnection(socket: WebSocket): void {
    let browser: BrowserId | null = null;
    const helloTimer = setTimeout(() => {
      if (!browser) socket.terminate();
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref();

    socket.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        socket.terminate();
        return;
      }
      const msg = ExtClientMessageSchema.safeParse(parsed);
      if (!msg.success) {
        warn("ws_bad_message", { issues: msg.error.issues.length });
        return;
      }
      const m = msg.data;
      if (m.type === "hello") {
        if (!tokenMatches(this.opts.token, m.token)) {
          logError("ws_auth_failed", { browser: m.browser });
          socket.close(4001, "bad token");
          return;
        }
        clearTimeout(helloTimer);
        browser = m.browser;
        const existing = this.sessions.get(browser);
        if (existing) existing.socket.terminate(); // newest wins
        this.sessions.set(browser, { browser, socket });
        socket.send(JSON.stringify({ type: "helloAck" }));
        info("ws_extension_connected", { browser, extVersion: m.extVersion });
        return;
      }
      if (!browser) {
        socket.terminate(); // data before hello
        return;
      }
      if (m.type === "snapshot") {
        this.opts.onSnapshot(browser, extSnapshotToBrowserState(browser, m));
      } else if (m.type === "commandResult") {
        const pending = this.pending.get(m.requestId);
        if (pending) {
          this.pending.delete(m.requestId);
          if (m.ok) pending.resolve(m.result as unknown as CommandResult);
          else pending.reject(new Error(m.error ?? "extension command failed"));
        }
      }
      // pong: traffic itself is the point; nothing to do.
    });

    const drop = () => {
      clearTimeout(helloTimer);
      if (browser && this.sessions.get(browser)?.socket === socket) {
        this.sessions.delete(browser);
        info("ws_extension_disconnected", { browser });
        this.opts.onDisconnect(browser);
      }
    };
    socket.on("close", drop);
    socket.on("error", drop);
  }
}

/** Convert an extension snapshot into the contract BrowserState shape. */
export function extSnapshotToBrowserState(browser: BrowserId, snap: ExtSnapshot): BrowserState {
  const spec = specFor(browser);
  return {
    browser,
    bundleId: spec.bundleId,
    pid: null, // merger backfills from the poll
    running: true,
    extensionConnected: true,
    dataSource: "extension",
    windows: snap.windows.map((w) => {
      const activeIdx = Math.max(
        0,
        w.tabs.findIndex((t) => t.active),
      );
      return {
        windowId: makeExtWindowId(browser, w.id),
        cgWindowId: null, // correlation enrichment happens post-merge
        title: sanitize(w.tabs.find((t) => t.active)?.title ?? "") ?? "",
        bounds: w.bounds,
        focused: w.focused,
        incognito: w.incognito,
        activeTabIndex: activeIdx,
        tabCount: w.tabs.length,
        tabs: w.tabs.map((t) => ({
          tabId: makeExtTabId(browser, t.id),
          index: t.index,
          url: sanitize(t.url) ?? "",
          title: sanitize(t.title) ?? "",
          active: t.active,
          pinned: t.pinned,
          audible: t.audible,
          discarded: t.discarded,
        })),
      };
    }),
  };
}
