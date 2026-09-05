/**
 * Unix-socket IPC server — the client API for MCP/CLI/TUI/wm-stack.
 *
 * Protocol: NDJSON, one JSON object per line.
 *   request:  { id, method: "getSnapshot"|"subscribe"|"unsubscribe"|"command"|"status"|"refresh"|"journal"|"getPage"|"annotate"|"screenshot"|"history"|"bookmarks"|"selectTabs"|"getSelection"|"planTabChange"|"getPlan"|"applyTabLayout"|"applyDestructivePlan"|"copyTabs"|"cutTabs"|"listOperations"|"getOperation"|"listClosedTabs"|"reopenTab", params? }
 *   response: { id, ok: true, result } | { id, ok: false, error, hint? }
 *   events (after subscribe): DaemonEvent objects (see state.ts)
 *
 * Stale-socket handling: if the socket file exists, probe it — a live
 * daemon answers, a dead one gets its socket unlinked and we bind fresh.
 */

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { info, error as logError, registerCleanup } from "@george43g/robustness";
import { isPipe } from "./paths.js";
import type { DaemonEvent, StateStore } from "./state.js";

export interface IpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export type CommandHandler = (params: Record<string, unknown>) => Promise<unknown>;

export interface IpcServerOptions {
  socketPath: string;
  store: StateStore;
  onCommand: CommandHandler;
  onStatus: () => Promise<unknown>;
  onRefresh: () => Promise<unknown>;
  onJournal: (params: Record<string, unknown>) => Promise<unknown>;
  onGetPage: (params: Record<string, unknown>) => Promise<unknown>;
  onAnnotate: (params: Record<string, unknown>) => Promise<unknown>;
  onScreenshot: (params: Record<string, unknown>) => Promise<unknown>;
  onHistory: (params: Record<string, unknown>) => Promise<unknown>;
  onBookmarks: (params: Record<string, unknown>) => Promise<unknown>;
  onSelectTabs: (params: Record<string, unknown>) => Promise<unknown>;
  onGetSelection: (params: Record<string, unknown>) => Promise<unknown>;
  onPlanTabChange: (params: Record<string, unknown>) => Promise<unknown>;
  onGetPlan: (params: Record<string, unknown>) => Promise<unknown>;
  onApplyTabLayout: (params: Record<string, unknown>) => Promise<unknown>;
  onApplyDestructivePlan: (params: Record<string, unknown>) => Promise<unknown>;
  onCopyTabs: (params: Record<string, unknown>) => Promise<unknown>;
  onCutTabs: (params: Record<string, unknown>) => Promise<unknown>;
  onListOperations: (params: Record<string, unknown>) => Promise<unknown>;
  onListClosedTabs: (params: Record<string, unknown>) => Promise<unknown>;
  onReopenTab: (params: Record<string, unknown>) => Promise<unknown>;
  onGetOperation: (params: Record<string, unknown>) => Promise<unknown>;
}

export class IpcServer {
  private server: Server | null = null;
  private subscribers = new Set<Socket>();
  private unsubscribeStore: (() => void) | null = null;

  constructor(private readonly opts: IpcServerOptions) {}

  subscriberCount(): number {
    return this.subscribers.size;
  }

  async start(): Promise<void> {
    await this.reclaimStaleSocket();
    // A Windows named pipe has no parent directory to create — `dirname` of
    // `\\.\pipe\x` is a path that does not exist and cannot be made.
    if (!isPipe(this.opts.socketPath)) {
      mkdirSync(dirname(this.opts.socketPath), { recursive: true });
    }

    this.server = createServer((socket) => this.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.opts.socketPath, () => resolve());
    });
    info("ipc_listening", { socket: this.opts.socketPath });

    this.unsubscribeStore = this.opts.store.onEvent((e) => this.broadcast(e));
    registerCleanup(async () => this.stop());
  }

  async stop(): Promise<void> {
    this.unsubscribeStore?.();
    for (const s of this.subscribers) s.destroy();
    this.subscribers.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
    // Windows reclaims a pipe when its last handle closes, so there is nothing
    // to unlink — and unlinking a pipe NAME throws.
    if (isPipe(this.opts.socketPath)) return;
    try {
      unlinkSync(this.opts.socketPath);
    } catch {
      // already gone
    }
  }

  private broadcast(event: DaemonEvent): void {
    const line = `${JSON.stringify(event)}\n`;
    for (const s of this.subscribers) {
      s.write(line);
    }
  }

  private onConnection(socket: Socket): void {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) void this.handleLine(socket, line);
      }
    });
    socket.on("close", () => this.subscribers.delete(socket));
    socket.on("error", () => this.subscribers.delete(socket));
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let req: IpcRequest;
    try {
      req = JSON.parse(line) as IpcRequest;
    } catch {
      socket.write(`${JSON.stringify({ id: null, ok: false, error: "unparseable request" })}\n`);
      return;
    }
    const reply = (payload: Record<string, unknown>) => {
      socket.write(`${JSON.stringify({ id: req.id, ...payload })}\n`);
    };
    try {
      switch (req.method) {
        case "getSnapshot":
          reply({ ok: true, result: this.opts.store.getSnapshot() });
          break;
        case "subscribe":
          this.subscribers.add(socket);
          reply({ ok: true, result: { subscribed: true } });
          // Prime the subscriber with the current state.
          socket.write(
            `${JSON.stringify({ event: "snapshot", ts: Date.now(), data: this.opts.store.getSnapshot() })}\n`,
          );
          break;
        case "unsubscribe":
          this.subscribers.delete(socket);
          reply({ ok: true, result: { subscribed: false } });
          break;
        case "command":
          reply({ ok: true, result: await this.opts.onCommand(req.params ?? {}) });
          break;
        case "status":
          reply({ ok: true, result: await this.opts.onStatus() });
          break;
        case "refresh":
          reply({ ok: true, result: await this.opts.onRefresh() });
          break;
        case "journal":
          reply({ ok: true, result: await this.opts.onJournal(req.params ?? {}) });
          break;
        case "getPage":
          reply({ ok: true, result: await this.opts.onGetPage(req.params ?? {}) });
          break;
        case "annotate":
          reply({ ok: true, result: await this.opts.onAnnotate(req.params ?? {}) });
          break;
        case "screenshot":
          reply({ ok: true, result: await this.opts.onScreenshot(req.params ?? {}) });
          break;
        case "history":
          reply({ ok: true, result: await this.opts.onHistory(req.params ?? {}) });
          break;
        case "bookmarks":
          reply({ ok: true, result: await this.opts.onBookmarks(req.params ?? {}) });
          break;
        case "selectTabs":
          reply({ ok: true, result: await this.opts.onSelectTabs(req.params ?? {}) });
          break;
        case "getSelection":
          reply({ ok: true, result: await this.opts.onGetSelection(req.params ?? {}) });
          break;
        case "planTabChange":
          reply({ ok: true, result: await this.opts.onPlanTabChange(req.params ?? {}) });
          break;
        case "getPlan":
          reply({ ok: true, result: await this.opts.onGetPlan(req.params ?? {}) });
          break;
        case "applyTabLayout":
          reply({ ok: true, result: await this.opts.onApplyTabLayout(req.params ?? {}) });
          break;
        case "applyDestructivePlan":
          reply({ ok: true, result: await this.opts.onApplyDestructivePlan(req.params ?? {}) });
          break;
        case "copyTabs":
          reply({ ok: true, result: await this.opts.onCopyTabs(req.params ?? {}) });
          break;
        case "cutTabs":
          reply({ ok: true, result: await this.opts.onCutTabs(req.params ?? {}) });
          break;
        case "reopenTab":
          reply({ ok: true, result: await this.opts.onReopenTab(req.params ?? {}) });
          break;
        case "listClosedTabs":
          reply({ ok: true, result: await this.opts.onListClosedTabs(req.params ?? {}) });
          break;
        case "listOperations":
          reply({ ok: true, result: await this.opts.onListOperations(req.params ?? {}) });
          break;
        case "getOperation":
          reply({ ok: true, result: await this.opts.onGetOperation(req.params ?? {}) });
          break;
        default:
          reply({ ok: false, error: `unknown method "${req.method}"` });
      }
    } catch (err) {
      reply({ ok: false, error: (err as Error).message });
    }
  }

  /**
   * If a socket file exists: live daemon → throw; dead socket → unlink.
   *
   * On Windows the file test is meaningless (a pipe is not on the filesystem)
   * but the LIVENESS probe still is, and it is the half that matters: it is how
   * a second daemon is refused. A dead pipe simply does not accept, so the
   * probe fails and `listen` succeeds — no cleanup step needed.
   */
  private async reclaimStaleSocket(): Promise<void> {
    const pipe = isPipe(this.opts.socketPath);
    if (!pipe && !existsSync(this.opts.socketPath)) return;
    const alive = await new Promise<boolean>((resolve) => {
      const probe = createConnection(this.opts.socketPath);
      const timer = setTimeout(() => {
        probe.destroy();
        resolve(false);
      }, 500);
      timer.unref();
      probe.once("connect", () => {
        clearTimeout(timer);
        probe.destroy();
        resolve(true);
      });
      probe.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (alive) {
      throw new Error(
        `Another daemon is already listening on ${this.opts.socketPath}. ` +
          `Stop it first (browser-tab daemon stop) or point BROWSER_TAB_SOCKET_PATH elsewhere.`,
      );
    }
    if (pipe) return;
    logError("stale_socket_reclaimed", { socket: this.opts.socketPath });
    unlinkSync(this.opts.socketPath);
  }
}
