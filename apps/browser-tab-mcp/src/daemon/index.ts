/**
 * runDaemon() — the long-lived process behind `browser-tab daemon run`.
 *
 * Owns: the polling engine loop, the source merger (extension feeds land
 * here in M5), the state store, the unix-socket IPC server, and the
 * snapshot file writer. Standard robustness harness applies: logger file
 * prefix, watchdog, heap monitor, shutdown registry.
 */

import {
  info,
  installShutdownHandlers,
  installWatchdog,
  logStartup,
  registerCleanup,
  setLogFilePrefix,
  startHeapMonitor,
} from "@george43g/robustness";
import type { BrowserId, CommandResult, Snapshot } from "@george43g/shared-types";
import { correlationTier } from "../detect/correlate.js";
import { enabledBrowsers, makeAdapter } from "../detect/engine.js";
import {
  makeExtTabId,
  makeExtWindowId,
  type ParsedTabId,
  type ParsedWindowId,
  parseTabId,
  parseWindowId,
} from "../detect/ids.js";
import { APP_VERSION } from "../meta.js";
import { EngineLoop, pollMs } from "./engine-loop.js";
import { IpcServer } from "./ipc-server.js";
import { SourceMerger } from "./merge.js";
import { socketPath } from "./paths.js";
import { SnapshotWriter } from "./snapshot-writer.js";
import { StateStore } from "./state.js";
import { ensureToken } from "./token.js";
import { ExtensionServer, wsPort } from "./ws-server.js";

export interface DaemonHandle {
  store: StateStore;
  loop: EngineLoop;
  merger: SourceMerger;
  ipc: IpcServer;
  ext: ExtensionServer | null;
  stop(): Promise<void>;
}

export interface DaemonCommandParams {
  kind?: string;
  [key: string]: unknown;
}

function parseHandle(id: string | undefined): ParsedTabId | ParsedWindowId {
  if (!id) throw new Error("Missing tabId/windowId/browser target.");
  const parsed = parseTabId(id) ?? parseWindowId(id);
  if (!parsed) throw new Error(`Malformed handle "${id}" — use handles from list_tabs.`);
  return parsed;
}

/** Map a numeric extension command result into the opaque CommandResult shape. */
function extResult(browser: BrowserId, command: string, raw: unknown): CommandResult {
  const r = (raw ?? {}) as { tabId?: number; windowId?: number; index?: number };
  return {
    ok: true,
    command,
    browser,
    ...(r.tabId !== undefined ? { tabId: makeExtTabId(browser, r.tabId) } : {}),
    ...(r.windowId !== undefined ? { windowId: makeExtWindowId(browser, r.windowId) } : {}),
    ...(r.index !== undefined ? { index: r.index } : {}),
  };
}

/** Ext handles carry the extension's numeric ids; reject mixed generations. */
function extNum(parsed: ParsedTabId | ParsedWindowId, what: string): number {
  if (!parsed.ext || !("nativeId" in parsed) || parsed.nativeId === undefined) {
    throw new Error(
      `${what} is an AppleScript-generation handle but this command runs over the extension — ` +
        `re-run list_tabs and use the fresh handles.`,
    );
  }
  return Number.parseInt(parsed.nativeId, 10);
}

/**
 * Route an IPC command. Extension-generation handles (x-ids) go over the
 * extension socket (true state-preserving moves); AppleScript-generation
 * handles use the adapters. open_tab prefers the extension when connected.
 */
export async function executeCommand(
  params: DaemonCommandParams,
  deps: { refresh: () => Promise<Snapshot>; ext: ExtensionServer | null },
): Promise<CommandResult> {
  const kind = params.kind;
  const ext = deps.ext;

  let result: CommandResult;
  switch (kind) {
    case "focus_tab":
    case "close_tab": {
      const tabId = params.tabId as string;
      const parsed = parseHandle(tabId);
      if (parsed.ext && ext?.isConnected(parsed.browser)) {
        const raw = await ext.sendCommand(parsed.browser, kind, {
          tabId: extNum(parsed, "tabId"),
        });
        result = extResult(parsed.browser, kind, raw);
      } else if (parsed.ext) {
        throw new Error(
          `Handle "${tabId}" belongs to the ${parsed.browser} extension session, which is not ` +
            `connected. Re-run list_tabs for current handles.`,
        );
      } else {
        const adapter = makeAdapter(parsed.browser);
        result =
          kind === "focus_tab" ? await adapter.focusTab(tabId) : await adapter.closeTab(tabId);
      }
      break;
    }
    case "move_tab": {
      const tabId = params.tabId as string;
      const parsed = parseHandle(tabId);
      const targetWindowId = params.targetWindowId as string | undefined;
      if (parsed.ext && ext?.isConnected(parsed.browser)) {
        const args: Record<string, unknown> = {
          tabId: extNum(parsed, "tabId"),
          newWindow: (params.newWindow as boolean | undefined) ?? false,
        };
        if (targetWindowId !== undefined) {
          args.targetWindowId = extNum(parseHandle(targetWindowId), "targetWindowId");
        }
        if (params.targetIndex !== undefined) args.targetIndex = params.targetIndex;
        const raw = await ext.sendCommand(parsed.browser, "move_tab", args);
        result = extResult(parsed.browser, "move_tab", raw);
      } else if (parsed.ext) {
        throw new Error(
          `Handle "${tabId}" belongs to the ${parsed.browser} extension session, which is not ` +
            `connected. Re-run list_tabs for current handles.`,
        );
      } else {
        result = await makeAdapter(parsed.browser).moveTab({
          tabId,
          targetWindowId,
          targetIndex: params.targetIndex as number | undefined,
          newWindow: (params.newWindow as boolean | undefined) ?? false,
          allowReload: (params.allowReload as boolean | undefined) ?? false,
        });
      }
      break;
    }
    case "open_tab": {
      const windowId = params.windowId as string | undefined;
      const parsedWindow = windowId ? parseHandle(windowId) : null;
      const browser =
        parsedWindow?.browser ?? (params.browser as BrowserId | undefined) ?? enabledBrowsers()[0];
      if (!browser) throw new Error("No browser enabled.");
      const useExt =
        ext?.isConnected(browser) === true && (parsedWindow === null || parsedWindow.ext);
      if (useExt && ext) {
        const args: Record<string, unknown> = {
          url: params.url,
          activate: (params.activate as boolean | undefined) ?? true,
        };
        if (parsedWindow) args.windowId = extNum(parsedWindow, "windowId");
        const raw = await ext.sendCommand(browser, "open_tab", args);
        result = extResult(browser, "open_tab", raw);
      } else {
        result = await makeAdapter(browser).openTab({
          url: params.url as string,
          browser,
          windowId,
          activate: (params.activate as boolean | undefined) ?? true,
        });
      }
      break;
    }
    default:
      throw new Error(`Unknown command kind "${String(kind)}".`);
  }
  // Reconcile state immediately so the next getSnapshot reflects the change.
  await deps.refresh().catch(() => {});
  return result;
}

export async function startDaemon(): Promise<DaemonHandle> {
  const store = new StateStore();
  const merger = new SourceMerger();
  const loop = new EngineLoop(store, merger);
  const writer = new SnapshotWriter(() => loop.lastScanDuration());

  const unsubscribeWriter = store.onEvent((e) => {
    if (e.event === "snapshot") writer.schedule(e.data as Snapshot);
  });

  // Extension WebSocket server — failure to bind degrades (osascript-only)
  // rather than killing the daemon.
  let ext: ExtensionServer | null = new ExtensionServer({
    port: wsPort(),
    token: ensureToken(),
    onSnapshot: (browser, state) => {
      merger.setExtensionState(browser, state);
      void loop.remerge();
    },
    onLiveness: (browser) => merger.touch(browser),
    onDisconnect: (browser) => {
      merger.clearExtension(browser);
      void loop.remerge();
    },
  });
  try {
    await ext.start();
  } catch (err) {
    info("ws_disabled", { message: (err as Error).message, port: wsPort() });
    ext = null;
  }

  const startedAt = Date.now();
  const ipc: IpcServer = new IpcServer({
    socketPath: socketPath(),
    store,
    onCommand: (params) => executeCommand(params, { refresh: () => loop.refresh(), ext }),
    onStatus: async () => ({
      pid: process.pid,
      version: APP_VERSION,
      uptimeS: Math.floor((Date.now() - startedAt) / 1000),
      pollMs: pollMs(),
      wsPort: ext ? wsPort() : null,
      extensions: ext?.connectedBrowsers() ?? [],
      correlationTier: await correlationTier(),
      subscribers: ipc.subscriberCount(),
      browsers: store.getSnapshot().browsers.map((b) => ({
        browser: b.browser,
        running: b.running,
        extensionConnected: b.extensionConnected,
        dataSource: b.dataSource,
        windowCount: b.windows.length,
        tabCount: b.windows.reduce((a, w) => a + w.tabCount, 0),
        ...(b.error !== undefined ? { error: b.error } : {}),
      })),
    }),
    onRefresh: () => loop.refresh(),
  });

  await ipc.start();
  loop.start();

  const stop = async (): Promise<void> => {
    loop.stop();
    unsubscribeWriter();
    writer.stop();
    await ext?.stop();
    await ipc.stop();
  };
  registerCleanup(stop);

  return { store, loop, merger, ipc, ext, stop };
}

/** Entry for `browser-tab daemon run` — never returns until shutdown. */
export async function runDaemon(): Promise<void> {
  setLogFilePrefix("browser-tab-daemon");
  installShutdownHandlers();
  installWatchdog();
  startHeapMonitor();
  logStartup("browser-tab-daemon");
  await startDaemon();
  info("daemon_started", { socket: socketPath(), pollMs: pollMs() });
  // Keep the process alive: the IPC server + interval timers are unref'd,
  // so hold an explicit ref until shutdown() exits the process.
  await new Promise<never>(() => {});
}
