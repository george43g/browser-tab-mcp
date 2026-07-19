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
import { type CommandArgs, executeCommand } from "./commands.js";
import { debounce, wireEvents } from "./events.js";
import type { BrowserName } from "./runtime.js";
import { buildSnapshot } from "./snapshot.js";

export interface DaemonSocketConfig {
  port: number;
  token: string;
  browser: BrowserName;
  extVersion: string;
}

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

  start(): void {
    this.stopped = false;
    if (!this.eventsWired) {
      wireEvents(() => this.sendSnapshotDebounced());
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
      ws.send(
        JSON.stringify({
          type: "hello",
          browser: this.config.browser,
          extVersion: this.config.extVersion,
          token: this.config.token,
        }),
      );
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
        this.reconnectDelay = RECONNECT_MIN_MS;
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

    const scheduleReconnect = () => {
      this.connected = false;
      if (this.stopped) return;
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
      setTimeout(() => this.ensureConnected(), delay);
    };
    ws.addEventListener("close", scheduleReconnect);
    ws.addEventListener("error", () => ws.close());
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
    } catch {
      // Snapshot failures are transient (mid-teardown); the next event retries.
    }
  }
}
