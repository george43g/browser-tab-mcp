/**
 * DaemonSocket — the extension side of the WebSocket protocol.
 *
 * Lifecycle: connect → hello(token) → helloAck → stream snapshots on every
 * tab/window event (debounced) → answer command messages → reply to pings.
 *
 * Reconnect: exponential backoff 1s → 30s. In Chrome MV3 the service
 * worker dies after ~30s idle; message traffic on an open WebSocket
 * resets the timer (Chrome 116+), and an alarms-driven watchdog in the
 * background script restarts the socket after a SW respawn.
 */

import type { ExtServerMessage } from "@george43g/shared-types";
import { probeCapabilities } from "./capabilities.js";
import { type CommandArgs, executeCommand } from "./commands.js";
import { debounce, type ExtEventInput, wireEvents } from "./events.js";
import { log, logError } from "./log.js";
import { api, type BrowserName } from "./runtime.js";
import { buildSnapshot } from "./snapshot.js";
import type { SnapshotSummary, SocketState } from "./status.js";

export interface DaemonSocketConfig {
  port: number;
  token: string;
  browser: BrowserName;
  extVersion: string;
}

/** Wire protocol version this extension speaks (v2: capabilities + enrichments). */
export const PROTOCOL_VERSION = 2;

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const SNAPSHOT_DEBOUNCE_MS = 150;

export class DaemonSocket {
  private ws: WebSocket | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private stopped = false;
  private eventsWired = false;
  private readonly sendSnapshotDebounced = debounce(() => {
    void this.sendSnapshot();
  }, SNAPSHOT_DEBOUNCE_MS);

  constructor(private readonly config: DaemonSocketConfig) {}

  /** True when the socket is open and authenticated. */
  connected = false;
  private connectedAt: number | null = null;
  private lastSnapshot: SnapshotSummary | null = null;
  private lastError: string | null = null;
  private reconnectAttempts = 0;

  /** Observable snapshot of liveness for the popup/options pages. */
  getState(): SocketState {
    return {
      connected: this.connected,
      connectedAt: this.connectedAt,
      lastSnapshot: this.lastSnapshot,
      lastError: this.lastError,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  start(): void {
    this.stopped = false;
    if (!this.eventsWired) {
      wireEvents(
        () => this.sendSnapshotDebounced(),
        (frame) => this.sendEvent(frame),
      );
      this.eventsWired = true;
    }
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }

  /** Called by the background alarm — reconnect if the SW respawned. */
  ensureConnected(): void {
    if (this.stopped) return;
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.connect();
    }
  }

  private connect(): void {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;
    const ws = new WebSocket(`ws://127.0.0.1:${this.config.port}/`);
    this.ws = ws;

    ws.addEventListener("open", () => {
      void this.sendHello(ws);
    });

    ws.addEventListener("message", (event) => {
      let msg: ExtServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ExtServerMessage;
      } catch {
        return;
      }
      if (msg.type === "helloAck") {
        this.connected = true;
        this.connectedAt = Date.now();
        this.lastError = null;
        this.reconnectAttempts = 0;
        this.reconnectDelay = RECONNECT_MIN_MS;
        log(`connected to daemon 127.0.0.1:${this.config.port} as ${this.config.browser}`);
        void this.sendSnapshot();
        return;
      }
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", ts: msg.ts }));
        return;
      }
      if (msg.type === "command") {
        void this.runCommand(msg.requestId, msg.kind, msg.args as CommandArgs);
      }
    });

    const scheduleReconnect = (info?: {
      code?: number | undefined;
      reason?: string | undefined;
    }) => {
      this.connected = false;
      this.connectedAt = null;
      if (info) {
        // Surface *why* we dropped — 4001 = bad token, 1006 = daemon
        // unreachable (or refused). This is what the pages/console show.
        this.lastError =
          info.reason && info.reason.length > 0
            ? info.reason
            : info.code === 4001
              ? "rejected: bad token"
              : info.code === 1006
                ? "daemon unreachable (is `browser-tab daemon` running?)"
                : `closed (${info.code ?? "?"})`;
      }
      if (this.stopped) return;
      this.reconnectAttempts += 1;
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
      setTimeout(() => this.ensureConnected(), delay);
    };
    ws.addEventListener("close", (event) => {
      const closeEvent = event as unknown as { code?: number; reason?: string };
      scheduleReconnect({ code: closeEvent.code, reason: closeEvent.reason });
    });
    ws.addEventListener("error", () => {
      this.lastError ??= "websocket error (daemon down or blocked)";
      logError(`websocket error → 127.0.0.1:${this.config.port}`);
      ws.close();
    });
  }

  /** Authenticate + advertise the runtime capability map. */
  private async sendHello(ws: WebSocket): Promise<void> {
    let sampleTab: Record<string, unknown> | undefined;
    try {
      const tabsApi = api.tabs as unknown as { query: (q: object) => Promise<unknown[]> };
      const tabs = await tabsApi.query({});
      sampleTab = (tabs[0] as Record<string, unknown> | undefined) ?? undefined;
    } catch {
      // No sample — API-existence capabilities are still accurate.
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: "hello",
        browser: this.config.browser,
        extVersion: this.config.extVersion,
        token: this.config.token,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: probeCapabilities(sampleTab),
      }),
    );
  }

  /** Send an immediate (undebounced) focus/nav event frame. Best-effort:
   *  drops silently if the socket isn't open — the next snapshot resyncs. */
  private sendEvent(frame: ExtEventInput): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "event", ts: Date.now(), ...frame }));
  }

  private async runCommand(requestId: number, kind: string, args: CommandArgs): Promise<void> {
    try {
      const result = await executeCommand(kind, args);
      this.ws?.send(JSON.stringify({ type: "commandResult", requestId, ok: true, result }));
      this.sendSnapshotDebounced();
    } catch (err) {
      this.ws?.send(
        JSON.stringify({
          type: "commandResult",
          requestId,
          ok: false,
          error: (err as Error).message,
        }),
      );
    }
  }

  private async sendSnapshot(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      const snapshot = await buildSnapshot();
      this.ws.send(JSON.stringify(snapshot));
      this.lastSnapshot = {
        windows: snapshot.windows.length,
        tabs: snapshot.windows.reduce((n, w) => n + w.tabs.length, 0),
        at: Date.now(),
      };
    } catch {
      // Snapshot failures are transient (mid-teardown); the next event retries.
    }
  }
}
