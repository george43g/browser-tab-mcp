/**
 * Unix-socket client for the daemon's NDJSON IPC protocol.
 *
 * One-shot use (CLI/MCP): connect() → request() → close().
 * Streaming use (TUI): connect() → subscribe(handler) → close().
 *
 * Connect timeout is deliberately tight (300ms) — when the daemon is down
 * the caller falls back to the in-process osascript engine, and a slow
 * probe would make every degraded call feel broken.
 */

import { createConnection, type Socket } from "node:net";
import { socketPath } from "../daemon/paths.js";
import type { DaemonEvent } from "../daemon/state.js";

const CONNECT_TIMEOUT_MS = 300;
const REQUEST_TIMEOUT_MS = 15_000;

interface IpcResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export class DaemonUnavailableError extends Error {
  constructor(path: string) {
    super(`browser-tab daemon is not reachable at ${path}.`);
    this.name = "DaemonUnavailableError";
  }
}

export class DaemonClient {
  private socket: Socket | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, (r: IpcResponse) => void>();
  private eventHandlers = new Set<(e: DaemonEvent) => void>();
  private closeHandlers = new Set<() => void>();
  /** Set by close() so an intentional teardown doesn't look like a drop. */
  private closing = false;

  constructor(private readonly path: string = socketPath()) {}

  /**
   * Notified when the socket drops on its own (daemon restart, crash, kill).
   * The client deliberately does NOT auto-reconnect — a subscriber is a
   * long-lived UI that needs to decide how to degrade (the TUI falls back to
   * polling and retries), whereas one-shot callers just want the error.
   */
  onClose(cb: () => void): () => void {
    this.closeHandlers.add(cb);
    return () => {
      this.closeHandlers.delete(cb);
    };
  }

  async connect(): Promise<void> {
    if (this.socket) return;
    this.socket = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection(this.path);
      const timer = setTimeout(() => {
        s.destroy();
        reject(new DaemonUnavailableError(this.path));
      }, CONNECT_TIMEOUT_MS);
      timer.unref();
      s.once("connect", () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once("error", () => {
        clearTimeout(timer);
        reject(new DaemonUnavailableError(this.path));
      });
    });
    this.socket.on("data", (chunk) => this.onData(chunk));
    this.socket.on("close", () => {
      for (const cb of this.pending.values()) {
        cb({ id: -1, ok: false, error: "daemon connection closed" });
      }
      this.pending.clear();
      this.socket = null;
      if (!this.closing) {
        for (const cb of [...this.closeHandlers]) cb();
      }
    });
  }

  close(): void {
    this.closing = true;
    this.socket?.destroy();
    this.socket = null;
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: IpcResponse & Partial<DaemonEvent>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const cb = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        cb?.(msg as IpcResponse);
      } else if (typeof msg.event === "string") {
        for (const h of this.eventHandlers) h(msg as DaemonEvent);
      }
    }
  }

  async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    await this.connect();
    const id = this.nextId++;
    const response = await new Promise<IpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`daemon request "${method}" timed out`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.socket?.write(`${JSON.stringify({ id, method, ...(params ? { params } : {}) })}\n`);
    });
    if (!response.ok) throw new Error(response.error ?? "daemon request failed");
    return response.result as T;
  }

  /** Subscribe to daemon events. Returns an unsubscribe function. */
  async subscribe(handler: (e: DaemonEvent) => void): Promise<() => void> {
    this.eventHandlers.add(handler);
    await this.request("subscribe");
    return () => {
      this.eventHandlers.delete(handler);
      if (this.eventHandlers.size === 0) {
        void this.request("unsubscribe").catch(() => {});
      }
    };
  }
}
