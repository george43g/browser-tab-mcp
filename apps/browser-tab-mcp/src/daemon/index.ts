/**
 * runDaemon() — the long-lived process behind `browser-tab daemon run`.
 *
 * Owns: the polling engine loop, the source merger (extension feeds land
 * here in M5), the state store, the unix-socket IPC server, and the
 * snapshot file writer. Standard robustness harness applies: logger file
 * prefix, watchdog, heap monitor, shutdown registry.
 */

import { sanitize, sanitizeContent } from "@george43g/mcp-kit";
import {
  envNum,
  info,
  installShutdownHandlers,
  installWatchdog,
  logStartup,
  registerCleanup,
  setLogFilePrefix,
  startHeapMonitor,
} from "@george43g/robustness";
import type {
  AnnotateOutput,
  BrowserId,
  CommandResult,
  ExtractResult,
  GetPageOutput,
  Snapshot,
  TabAction,
  WindowBounds,
  WindowState,
} from "@george43g/shared-types";
import { ExtractResultSchema, WindowStateSchema } from "@george43g/shared-types";
import { correlationTier } from "../detect/correlate.js";
import { listDisplays } from "../detect/displays.js";
import { enabledBrowsers, makeAdapter } from "../detect/engine.js";
import {
  makeExtGroupId,
  makeExtTabId,
  makeExtWindowId,
  type ParsedTabId,
  type ParsedWindowId,
  parseGroupId,
  parseTabId,
  parseWindowId,
} from "../detect/ids.js";
import { APP_VERSION, buildStamp } from "../meta.js";
import { AnnotationStore } from "./annotations.js";
import { ContentCache } from "./content-cache.js";
import { EngineLoop, pollMs } from "./engine-loop.js";
import { history } from "./history.js";
import { IpcServer } from "./ipc-server.js";
import { JournalStore } from "./journal.js";
import { buildSeedRecords, ingestExtEvent, ingestStoreEvent } from "./journal-ingest.js";
import { SourceMerger } from "./merge.js";
import { socketPath } from "./paths.js";
import { ShotRateLimiter, screenshot } from "./screenshot.js";
import { ShotStore } from "./shots.js";
import { SnapshotWriter } from "./snapshot-writer.js";
import { StateStore } from "./state.js";
import { ensureToken } from "./token.js";
import { ExtensionServer, wsPort } from "./ws-server.js";

export interface DaemonHandle {
  store: StateStore;
  loop: EngineLoop;
  merger: SourceMerger;
  journal: JournalStore;
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
  const r = (raw ?? {}) as {
    tabId?: number;
    windowId?: number;
    groupId?: number;
    index?: number;
    payload?: unknown;
    windowState?: string;
    wasMinimized?: boolean;
    windowFocused?: boolean;
  };
  // The extension reports window state as chrome's own enum; anything outside
  // the contract's set is dropped rather than smuggled through as a string.
  const windowState = WindowStateSchema.safeParse(r.windowState);
  return {
    ok: true,
    command,
    browser,
    ...(r.tabId !== undefined ? { tabId: makeExtTabId(browser, r.tabId) } : {}),
    ...(r.windowId !== undefined ? { windowId: makeExtWindowId(browser, r.windowId) } : {}),
    ...(r.groupId !== undefined ? { groupId: makeExtGroupId(browser, r.groupId) } : {}),
    ...(r.index !== undefined ? { index: r.index } : {}),
    ...(r.payload !== undefined ? { payload: r.payload } : {}),
    ...(windowState.success ? { windowState: windowState.data } : {}),
    ...(r.wasMinimized !== undefined ? { wasMinimized: r.wasMinimized } : {}),
    ...(r.windowFocused !== undefined ? { windowFocused: r.windowFocused } : {}),
  };
}

/**
 * Attach the window post-state a window manager needs to act on a focus_tab
 * without a second `list_tabs`.
 *
 * Division of labour, deliberately: the acting pathway owns everything only it
 * could observe (`wasMinimized` is a BEFORE-state — no later snapshot can
 * recover it), and the freshly merged snapshot owns `cgWindowId`, because
 * CoreGraphics correlation only exists in the daemon. Snapshot values never
 * overwrite what the pathway already reported.
 *
 * What this deliberately does NOT do: move the window, change its Space, or
 * shell out to yabai. Visibility is the window manager's job — browser-tab
 * activates the tab and hands back enough state for the WM to decide.
 */
function enrichFocusResult(result: CommandResult, snapshot: Snapshot | undefined): CommandResult {
  if (!snapshot || !result.windowId) return result;
  const win = snapshot.browsers
    .find((b) => b.browser === result.browser)
    ?.windows.find((w) => w.windowId === result.windowId);
  if (!win) return result;
  return {
    ...result,
    cgWindowId: win.cgWindowId,
    ...(result.windowState === undefined && win.state !== undefined
      ? { windowState: win.state }
      : {}),
    ...(result.windowFocused === undefined ? { windowFocused: win.focused } : {}),
  };
}

/** The stock "this x-handle's extension session is gone" error, shared by the routers. */
function notConnectedHint(handle: string, browser: BrowserId): string {
  return (
    `Handle "${handle}" belongs to the ${browser} extension session, which is not connected. ` +
    `Re-run list_tabs for current handles.`
  );
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
 * Handles are opaque and browser-scoped, but the numeric id inside them is NOT
 * globally unique — every browser numbers its own tabs/windows from its own
 * sequence. So a handle from browser B, unpacked into a command aimed at
 * browser A, hands A a number that means something completely different there.
 *
 * Left unchecked that is not merely an error: `group_tabs` infers its target
 * browser from `tabIds[0]` alone, so a stray handle from another browser used
 * to contribute its raw number and could group an unrelated tab that happened
 * to share it. `move_tab` leaked the same way, surfacing the foreign numeric id
 * verbatim ("No window with id: 38").
 *
 * Every site that accepts a second handle must therefore anchor it against the
 * browser the command is actually routed to.
 */
function crossBrowserError(what: string, handle: string, actual: BrowserId, anchor: BrowserId) {
  return new Error(
    `${what} "${handle}" is a ${actual} handle but this command targets ${anchor}. ` +
      `Tabs, windows and groups can only be combined within a single browser — ` +
      `re-run list_tabs and use handles from ${anchor}.`,
  );
}

/** Parse a secondary tab/window handle, asserting it belongs to `anchor`. */
function extNumOf(anchor: BrowserId, handle: string, what: string): number {
  const parsed = parseHandle(handle);
  if (parsed.browser !== anchor) {
    throw crossBrowserError(what, handle, parsed.browser, anchor);
  }
  return extNum(parsed, what);
}

/** Parse a group handle, asserting it belongs to `anchor`. */
function groupNumOf(anchor: BrowserId, handle: string, what: string): number {
  const g = parseGroupId(handle);
  if (!g) throw new Error(`${what} "${handle}" is not a tab-group handle from list_tabs.`);
  if (g.browser !== anchor) {
    throw crossBrowserError(what, handle, g.browser, anchor);
  }
  return Number.parseInt(g.nativeId, 10);
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
      // Default TRUE in every pathway — focus_tab has always raised, and this
      // flag exists to make that opt-OUTable, not to change the default.
      const raiseWindow = (params.raiseWindow as boolean | undefined) !== false;
      if (parsed.ext && ext?.isConnected(parsed.browser)) {
        const raw = await ext.sendCommand(parsed.browser, kind, {
          tabId: extNum(parsed, "tabId"),
          ...(kind === "focus_tab" ? { raiseWindow } : {}),
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
          kind === "focus_tab"
            ? await adapter.focusTab(tabId, { raiseWindow })
            : await adapter.closeTab(tabId);
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
          args.targetWindowId = extNumOf(parsed.browser, targetWindowId, "targetWindowId");
        }
        if (params.targetIndex !== undefined) args.targetIndex = params.targetIndex;
        if (params.targetGroupId !== undefined) {
          args.targetGroupId = groupNumOf(
            parsed.browser,
            params.targetGroupId as string,
            "targetGroupId",
          );
        }
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
      const askedBrowser = params.browser as BrowserId | undefined;
      // An explicit `browser` that disagrees with the windowId's is a caller
      // mistake, not a preference — the window handle used to win silently.
      if (parsedWindow && askedBrowser && parsedWindow.browser !== askedBrowser) {
        throw crossBrowserError("windowId", windowId as string, parsedWindow.browser, askedBrowser);
      }
      const browser = parsedWindow?.browser ?? askedBrowser ?? enabledBrowsers()[0];
      if (!browser) throw new Error("No browser enabled.");
      const useExt =
        ext?.isConnected(browser) === true && (parsedWindow === null || parsedWindow.ext);
      if (useExt && ext) {
        const args: Record<string, unknown> = {
          url: params.url,
          activate: (params.activate as boolean | undefined) ?? true,
          pinned: (params.pinned as boolean | undefined) ?? false,
        };
        if (parsedWindow) args.windowId = extNum(parsedWindow, "windowId");
        if (params.index !== undefined) args.index = params.index;
        if (params.groupId !== undefined) {
          args.groupId = groupNumOf(browser, params.groupId as string, "groupId");
        }
        const raw = await ext.sendCommand(browser, "open_tab", args);
        result = extResult(browser, "open_tab", raw);
      } else {
        result = await makeAdapter(browser).openTab({
          url: params.url as string,
          browser,
          windowId,
          activate: (params.activate as boolean | undefined) ?? true,
          pinned: (params.pinned as boolean | undefined) ?? false,
        });
      }
      break;
    }
    case "tab_action": {
      const tabId = params.tabId as string;
      const parsed = parseHandle(tabId);
      const action = params.action as TabAction;
      const url = params.url as string | undefined;
      if (parsed.ext && ext?.isConnected(parsed.browser)) {
        const raw = await ext.sendCommand(parsed.browser, "tab_action", {
          tabId: extNum(parsed, "tabId"),
          action,
          ...(url !== undefined ? { url } : {}),
        });
        result = extResult(parsed.browser, "tab_action", raw);
      } else if (parsed.ext) {
        throw new Error(notConnectedHint(tabId, parsed.browser));
      } else {
        result = await makeAdapter(parsed.browser).tabAction({
          tabId,
          action,
          ...(url !== undefined ? { url } : {}),
        });
      }
      break;
    }
    case "group_tabs": {
      // Extension-only (chrome.tabGroups). Infer the browser from any handle.
      const tabIds = params.tabIds as string[] | undefined;
      const groupId = params.groupId as string | undefined;
      const targetWindowId = params.targetWindowId as string | undefined;
      const anchor = tabIds?.[0] ?? groupId ?? targetWindowId;
      let browser: BrowserId | undefined;
      if (anchor === groupId && groupId) browser = parseGroupId(groupId)?.browser;
      else if (anchor) browser = (parseTabId(anchor) ?? parseWindowId(anchor))?.browser;
      browser ??= params.browser as BrowserId | undefined;
      if (!browser)
        throw new Error("Could not determine the browser — pass tabIds, groupId, or browser.");
      if (!ext?.isConnected(browser)) {
        throw new Error(
          `Tab groups require the browser-tab extension (Chrome-family). The ${browser} extension ` +
            `isn't connected — AppleScript can't manage tab groups.`,
        );
      }
      const args: Record<string, unknown> = { action: params.action };
      // EVERY tabId is anchored, not just tabIds[0] which picked the browser —
      // an unvalidated tail element could otherwise group a same-numbered tab
      // belonging to a different browser.
      if (tabIds) args.tabIds = tabIds.map((h) => extNumOf(browser, h, "tabId"));
      if (groupId) args.groupId = groupNumOf(browser, groupId, "groupId");
      if (targetWindowId) args.targetWindowId = extNumOf(browser, targetWindowId, "targetWindowId");
      for (const k of ["title", "color", "collapsed", "index"] as const) {
        if (params[k] !== undefined) args[k] = params[k];
      }
      result = extResult(browser, "group_tabs", await ext.sendCommand(browser, "group_tabs", args));
      break;
    }
    case "open_window": {
      const browser = (params.browser as BrowserId | undefined) ?? enabledBrowsers()[0];
      if (!browser) throw new Error("No browser enabled.");
      const urls = params.urls as string[];
      const bounds = params.bounds as WindowBounds | undefined; // resolved by the client
      const state = params.state as WindowState | undefined;
      const incognito = (params.incognito as boolean | undefined) ?? false;
      const focused = (params.focused as boolean | undefined) ?? true;
      if (ext?.isConnected(browser)) {
        const args: Record<string, unknown> = { urls, incognito, focused };
        if (bounds !== undefined) args.bounds = bounds;
        if (state !== undefined) args.state = state;
        result = extResult(
          browser,
          "open_window",
          await ext.sendCommand(browser, "open_window", args),
        );
      } else {
        result = await makeAdapter(browser).openWindow({
          urls,
          browser,
          incognito,
          focused,
          ...(bounds !== undefined ? { bounds } : {}),
          ...(state !== undefined ? { state } : {}),
        });
      }
      break;
    }
    case "set_window": {
      const windowId = params.windowId as string;
      const parsed = parseHandle(windowId);
      const bounds = params.bounds as WindowBounds | undefined;
      const state = params.state as WindowState | undefined;
      const focused = params.focused as boolean | undefined;
      if (parsed.ext && ext?.isConnected(parsed.browser)) {
        const args: Record<string, unknown> = { windowId: extNum(parsed, "windowId") };
        if (bounds !== undefined) args.bounds = bounds;
        if (state !== undefined) args.state = state;
        if (focused !== undefined) args.focused = focused;
        result = extResult(
          parsed.browser,
          "set_window",
          await ext.sendCommand(parsed.browser, "set_window", args),
        );
      } else if (parsed.ext) {
        throw new Error(notConnectedHint(windowId, parsed.browser));
      } else {
        result = await makeAdapter(parsed.browser).setWindow({
          windowId,
          ...(bounds !== undefined ? { bounds } : {}),
          ...(state !== undefined ? { state } : {}),
          ...(focused !== undefined ? { focused } : {}),
        });
      }
      break;
    }
    case "close_window": {
      const windowId = params.windowId as string;
      const parsed = parseHandle(windowId);
      if (parsed.ext && ext?.isConnected(parsed.browser)) {
        const raw = await ext.sendCommand(parsed.browser, "close_window", {
          windowId: extNum(parsed, "windowId"),
        });
        result = extResult(parsed.browser, "close_window", raw);
      } else if (parsed.ext) {
        throw new Error(notConnectedHint(windowId, parsed.browser));
      } else {
        result = await makeAdapter(parsed.browser).closeWindow({ windowId });
      }
      break;
    }
    default:
      throw new Error(`Unknown command kind "${String(kind)}".`);
  }
  // Reconcile state immediately so the next getSnapshot reflects the change —
  // and, for focus_tab, so the correlated window is available to enrich with.
  const snapshot = await deps.refresh().catch(() => undefined);
  return kind === "focus_tab" ? enrichFocusResult(result, snapshot) : result;
}

/** Current URL for a tab handle from the merged snapshot (for the cache key). */
function lookupTabUrl(store: StateStore, tabId: string): string {
  for (const b of store.getSnapshot().browsers) {
    for (const w of b.windows) {
      for (const t of w.tabs) {
        if (t.tabId === tabId) return t.url;
      }
    }
  }
  return "";
}

function extractMaxBytes(): number {
  return envNum("BROWSER_TAB_EXTRACT_MAX_BYTES", 200 * 1024);
}

/** Sanitize the extension's raw extraction, then validate into ExtractResult. */
function finalizeExtract(payload: unknown): ExtractResult {
  const raw = (payload ?? {}) as Record<string, unknown>;
  if (typeof raw.error === "string" && raw.error) {
    throw new Error(`Page extraction failed: ${raw.error}`);
  }
  const cleaned: Record<string, unknown> = { ...raw };
  if (typeof raw.text === "string") cleaned.text = sanitizeContent(raw.text);
  for (const k of ["title", "byline", "excerpt", "url"] as const) {
    if (typeof raw[k] === "string") cleaned[k] = sanitize(raw[k] as string, 8192) ?? "";
  }
  if (raw.metadata && typeof raw.metadata === "object") {
    const md = raw.metadata as Record<string, unknown>;
    const cleanMd: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(md)) {
      cleanMd[k] = typeof v === "string" ? (sanitize(v, 4096) ?? "") : v;
    }
    cleaned.metadata = cleanMd;
  }
  return ExtractResultSchema.parse(cleaned);
}

export interface GetPageDeps {
  ext: ExtensionServer | null;
  store: StateStore;
  journal: JournalStore;
  cache: ContentCache;
  sessionId: string;
}

/**
 * Extract page content/state for a tab. Extension-only (there is no
 * AppleScript way to read a page); results are cached per navEpoch so an
 * unchanged page serves instantly. `force` re-extracts.
 */
export async function getPage(
  params: DaemonCommandParams,
  deps: GetPageDeps,
): Promise<GetPageOutput> {
  const tabId = params.tabId as string;
  const parsed = parseHandle(tabId);
  const mode = (params.mode as string | undefined) ?? "text";
  if (!parsed.ext) {
    throw new Error(
      `Content extraction needs the browser extension — "${tabId}" is an AppleScript-generation ` +
        `handle. Connect the extension and re-run list_tabs for x-handles.`,
    );
  }
  const browser = parsed.browser;
  if (!deps.ext?.isConnected(browser)) throw new Error(notConnectedHint(tabId, browser));

  const url = lookupTabUrl(deps.store, tabId);
  const navEpoch = deps.journal.navEpoch(tabId);
  const keyParts = { browser, handle: tabId, url, navEpoch, sessionId: deps.sessionId, mode };

  if (!(params.force as boolean | undefined)) {
    const hit = deps.cache.get(keyParts) as ExtractResult | undefined;
    if (hit) return { ...hit, navEpoch, cached: true };
  }

  const raw = await deps.ext.sendCommand(browser, "extract_content", {
    tabId: extNum(parsed, "tabId"),
    mode,
    maxBytes: extractMaxBytes(),
  });
  const extract = finalizeExtract((raw as { payload?: unknown }).payload);
  deps.cache.set(keyParts, extract);
  return { ...extract, navEpoch, cached: false };
}

/** Read or write a URL-keyed annotation (consumer's own summary cache). */
export function annotate(params: DaemonCommandParams, store: AnnotationStore): AnnotateOutput {
  const url = params.url as string | undefined;
  if (!url) throw new Error("annotate requires a url.");
  const note = params.note as string | undefined;
  return note !== undefined ? store.set(url, note) : store.get(url);
}

export async function startDaemon(): Promise<DaemonHandle> {
  const store = new StateStore();
  const merger = new SourceMerger();
  const loop = new EngineLoop(store, merger);
  const writer = new SnapshotWriter(() => loop.lastScanDuration());
  const journal = new JournalStore();
  journal.warmFromDisk();
  const contentCache = new ContentCache();
  const annotations = new AnnotationStore();
  const shots = new ShotStore();
  const shotLimiter = new ShotRateLimiter();
  // Per-boot session id — content cache keys include it so a restarted daemon
  // never serves content keyed to a now-dead handle generation.
  const sessionId = Date.now().toString(36);

  // One journal ingest source per browser: extension `event` frames when a
  // browser is extension-authoritative, poll-derived StateStore diffs
  // otherwise. Gating store-diff ingestion on !extensionConnected prevents
  // double-counting an extension-fed browser's focus/nav.
  const unsubscribeWriter = store.onEvent((e) => {
    if (e.event === "snapshot") {
      writer.schedule(e.data as Snapshot);
    } else if (e.browser && !merger.extensionConnected(e.browser as BrowserId)) {
      ingestStoreEvent(journal, store, e);
    }
  });

  // Extension WebSocket server — failure to bind degrades (osascript-only)
  // rather than killing the daemon.
  let ext: ExtensionServer | null = new ExtensionServer({
    port: wsPort(),
    token: ensureToken(),
    onSnapshot: (browser, state) => {
      merger.setExtensionState(browser, state);
      // Seed tab-MRU once per session from the extension's lastAccessed data.
      if (!journal.isSeeded(browser)) journal.seedTabMru(browser, buildSeedRecords(state));
      void loop.remerge();
    },
    onEvent: (browser, frame) => ingestExtEvent(journal, store, browser, frame),
    onLiveness: (browser) => merger.touch(browser),
    onDisconnect: (browser) => {
      merger.clearExtension(browser);
      journal.clearSeed(browser);
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
      // Build identity, so a consumer can tell WHICH build of this version is
      // serving it — semver alone cannot (see scripts/build-stamp.mjs).
      build: buildStamp(),
      contractVersion: store.getSnapshot().version,
      uptimeS: Math.floor((Date.now() - startedAt) / 1000),
      pollMs: pollMs(),
      wsPort: ext ? wsPort() : null,
      extensions: ext?.connectedBrowsers() ?? [],
      extensionInfo: ext?.extensionInfo() ?? [],
      correlationTier: await correlationTier(),
      displays: listDisplays(),
      focusedBrowser: store.getSnapshot().focusedBrowser ?? null,
      subscribers: ipc.subscriberCount(),
      browsers: store.getSnapshot().browsers.map((b) => ({
        browser: b.browser,
        running: b.running,
        extensionConnected: b.extensionConnected,
        dataSource: b.dataSource,
        windowCount: b.windows.length,
        tabCount: b.windows.reduce((a, w) => a + w.tabCount, 0),
        ...(b.capabilities !== undefined ? { capabilities: b.capabilities } : {}),
        ...(b.error !== undefined ? { error: b.error } : {}),
      })),
    }),
    onRefresh: () => loop.refresh(),
    onJournal: async (params) => journal.query(params),
    onGetPage: (params) => getPage(params, { ext, store, journal, cache: contentCache, sessionId }),
    onAnnotate: async (params) => annotate(params, annotations),
    onScreenshot: (params) =>
      screenshot(params, { ext, store, journal, shots, limiter: shotLimiter }),
    onHistory: (params) => history(params, { ext }),
  });

  await ipc.start();
  loop.start();

  const stop = async (): Promise<void> => {
    loop.stop();
    unsubscribeWriter();
    writer.stop();
    journal.stop();
    await ext?.stop();
    await ipc.stop();
  };
  registerCleanup(stop);

  return { store, loop, merger, journal, ipc, ext, stop };
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
