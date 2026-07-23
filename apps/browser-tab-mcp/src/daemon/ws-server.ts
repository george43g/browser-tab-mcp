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
import { envBool, envNum, info, error as logError, warn } from "@george43g/robustness";
import type {
  BrowserId,
  BrowserState,
  Capabilities,
  CommandResult,
  ExtEvent,
  ExtServerMessage,
  ExtSnapshot,
  TabGroup,
} from "@george43g/shared-types";
import {
  ExtClientMessageSchema,
  FAVICON_MAX_BYTES,
  pickEnrichment,
  sanitizeFavicon,
} from "@george43g/shared-types";
import { type WebSocket, WebSocketServer } from "ws";
import { specFor } from "../detect/engine.js";
import { makeExtGroupId, makeExtTabId, makeExtWindowId } from "../detect/ids.js";
import { tokenMatches } from "./token.js";

const PING_INTERVAL_MS = 20_000;
const HELLO_TIMEOUT_MS = 3_000;
const COMMAND_TIMEOUT_MS = 5_000;
/** Kinds that inject/scrape a page and may legitimately take a while. */
const LONG_COMMAND_TIMEOUT_MS = 10_000;
const LONG_KINDS = new Set(["extract_content", "capture_tab", "history_search"]);
const DEFAULT_MAX_PAYLOAD = 16 * 1024 * 1024;
/** Wire protocol version the daemon speaks (v2: capabilities + enrichments). */
const PROTOCOL_VERSION = 2;

export function wsPort(): number {
  return envNum("BROWSER_TAB_WS_PORT", 8790);
}

/** Tighten ws's 100MB default — content payloads are capped far below this. */
function wsMaxPayload(): number {
  return envNum("BROWSER_TAB_WS_MAX_PAYLOAD", DEFAULT_MAX_PAYLOAD);
}

/** Cap for inline data: favicons, re-applied daemon-side — can only tighten the source cap. */
function faviconMaxBytes(): number {
  return envNum("BROWSER_TAB_FAVICON_MAX_BYTES", FAVICON_MAX_BYTES);
}

/** Capture-on-blur policy pushed to extensions via helloAck.config. */
export function blurCaptureEnabled(): boolean {
  return envBool("BROWSER_TAB_BLUR_CAPTURE", true);
}

interface Session {
  browser: BrowserId;
  socket: WebSocket;
  /** Set on every inbound frame; the heartbeat clears it before each ping and
   *  terminates a session that produced nothing since the previous ping. */
  alive: boolean;
  /** Runtime capability map reported in the extension's hello (v2+). */
  capabilities?: Capabilities;
}

export interface ExtensionServerOptions {
  port: number;
  token: string;
  onSnapshot: (browser: BrowserId, state: BrowserState) => void;
  onDisconnect: (browser: BrowserId) => void;
  /** Called on each immediate focus/nav event frame (for the journals). */
  onEvent?: (browser: BrowserId, frame: ExtEvent) => void;
  /** Called on any inbound frame from a live session (snapshot, commandResult,
   *  or pong) so the merger can keep an idle-but-connected feed authoritative. */
  onLiveness?: (browser: BrowserId) => void;
  /** Ping/heartbeat cadence; defaults to PING_INTERVAL_MS. Injectable for tests. */
  pingIntervalMs?: number;
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
  private readonly pingIntervalMs: number;

  constructor(private readonly opts: ExtensionServerOptions) {
    this.pingIntervalMs = opts.pingIntervalMs ?? PING_INTERVAL_MS;
  }

  async start(): Promise<void> {
    this.wss = new WebSocketServer({
      host: "127.0.0.1",
      port: this.opts.port,
      maxPayload: wsMaxPayload(),
    });
    await new Promise<void>((resolve, reject) => {
      this.wss?.once("listening", resolve);
      this.wss?.once("error", reject);
    });
    this.wss.on("connection", (socket) => this.onConnection(socket));
    this.pingTimer = setInterval(() => this.heartbeat(), this.pingIntervalMs);
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

  /** Send a command to a browser's extension and await its result. Content
   *  commands (extract_content) get a longer timeout; override via opts. */
  async sendCommand(
    browser: BrowserId,
    kind: string,
    args: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<CommandResult> {
    const session = this.sessions.get(browser);
    if (!session) {
      throw new Error(
        `The ${browser} extension is not connected. Install/enable the browser-tab extension ` +
          `and paste the token from \`browser-tab daemon token\` into its options page.`,
      );
    }
    const timeoutMs =
      opts?.timeoutMs ?? (LONG_KINDS.has(kind) ? LONG_COMMAND_TIMEOUT_MS : COMMAND_TIMEOUT_MS);
    const requestId = this.nextRequestId++;
    const message: ExtServerMessage = { type: "command", requestId, kind: kind as never, args };
    return new Promise<CommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Extension command ${kind} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
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

  /**
   * Ping every session; first drop any that produced no frame since the last
   * ping (a dead/half-open socket whose `close` never fired). Terminating
   * triggers the socket's `close` → drop() → onDisconnect → clearExtension,
   * so a wedged extension can't keep serving stale x-handles.
   */
  private heartbeat(): void {
    const line = JSON.stringify({ type: "ping", ts: Date.now() });
    for (const s of [...this.sessions.values()]) {
      if (!s.alive) {
        s.socket.terminate();
        continue;
      }
      s.alive = false;
      s.socket.send(line);
    }
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
        this.sessions.set(browser, {
          browser,
          socket,
          alive: true,
          ...(m.capabilities ? { capabilities: m.capabilities } : {}),
        });
        socket.send(
          JSON.stringify({
            type: "helloAck",
            protocolVersion: PROTOCOL_VERSION,
            config: { blurCapture: blurCaptureEnabled() },
          }),
        );
        info("ws_extension_connected", {
          browser,
          extVersion: m.extVersion,
          protocolVersion: m.protocolVersion ?? 1,
        });
        return;
      }
      if (!browser) {
        socket.terminate(); // data before hello
        return;
      }
      // Any post-hello frame (snapshot, commandResult, pong) proves liveness.
      const session = this.sessions.get(browser);
      if (session?.socket === socket) {
        session.alive = true;
        this.opts.onLiveness?.(browser);
      }
      if (m.type === "snapshot") {
        this.opts.onSnapshot(browser, extSnapshotToBrowserState(browser, m, session?.capabilities));
      } else if (m.type === "event") {
        this.opts.onEvent?.(browser, m);
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
export function extSnapshotToBrowserState(
  browser: BrowserId,
  snap: ExtSnapshot,
  capabilities?: Capabilities,
): BrowserState {
  const spec = specFor(browser);
  const favMax = faviconMaxBytes();
  const tabGroups: TabGroup[] = snap.groups.map((g) => ({
    groupId: makeExtGroupId(browser, g.id),
    windowId: makeExtWindowId(browser, g.windowId),
    title: g.title,
    color: g.color,
    collapsed: g.collapsed,
  }));
  return {
    browser,
    bundleId: spec.bundleId,
    pid: null, // merger backfills from the poll
    running: true,
    extensionConnected: true,
    dataSource: "extension",
    ...(capabilities ? { capabilities } : {}),
    tabGroups,
    windows: snap.windows.map((w) => {
      const activeTab = w.tabs.find((t) => t.active);
      const activeIdx = Math.max(
        0,
        w.tabs.findIndex((t) => t.active),
      );
      return {
        windowId: makeExtWindowId(browser, w.id),
        cgWindowId: null, // correlation enrichment happens post-merge
        title: sanitize(activeTab?.title ?? "") ?? "",
        bounds: w.bounds,
        focused: w.focused,
        incognito: w.incognito,
        activeTabIndex: activeIdx,
        ...(activeTab ? { activeTabId: makeExtTabId(browser, activeTab.id) } : {}),
        ...(w.state ? { state: w.state } : {}),
        tabCount: w.tabs.length,
        tabs: w.tabs.map((t) => {
          const favicon = sanitizeFavicon(t.favicon, favMax);
          return {
            tabId: makeExtTabId(browser, t.id),
            index: t.index,
            url: sanitize(t.url) ?? "",
            title: sanitize(t.title) ?? "",
            active: t.active,
            ...(t.groupId !== undefined && t.groupId >= 0
              ? { groupId: makeExtGroupId(browser, t.groupId) }
              : {}),
            ...(favicon ? { favicon } : {}),
            ...pickEnrichment(t),
          };
        }),
      };
    }),
  };
}
