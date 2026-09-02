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
import { callMcpTool } from "../dispatcher.js";
import { APP_VERSION, buildStamp } from "../meta.js";
import { AnnotationStore } from "./annotations.js";
import { applyTabLayout as runApplyTabLayout } from "./apply.js";
import { bookmarks } from "./bookmarks.js";
import { ContentCache } from "./content-cache.js";
import { makeIdempotencyCache, copyTabs as runCopyTabs } from "./copy.js";
import { cutTabs as runCutTabs } from "./cut.js";
import { EngineLoop, pollMs } from "./engine-loop.js";
import { history } from "./history.js";
import { HttpServer, httpPort } from "./http-server.js";
import { IpcServer } from "./ipc-server.js";
import { JournalStore } from "./journal.js";
import { buildSeedRecords, ingestExtEvent, ingestStoreEvent } from "./journal-ingest.js";
import { SourceMerger } from "./merge.js";
import { findTabLocation, findWindowTabCount, resolveSignedIndex } from "./move-resolve.js";
import { OperationStore } from "./operations.js";
import { socketPath } from "./paths.js";
import { planTabChange as runPlanTabChange } from "./plan-change.js";
import { PlanStore } from "./plans.js";
import { ShotRateLimiter, screenshot } from "./screenshot.js";
import { selectTabs as runSelectTabs } from "./select.js";
import { SelectionStore } from "./selections.js";
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
  http: HttpServer | null;
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

/**
 * Numeric ids inside a command payload become handles before leaving the
 * daemon. The first consumer is group_tabs' `skippedTabIds` (stale tabs the
 * extension validated out and worked around): a caller holding `t:chrome:x…`
 * handles cannot act on a bare `523242703`, and handing numerics back would
 * reintroduce exactly the raw-id confusion the handle scheme exists to end.
 */
function mapPayloadHandles(browser: BrowserId, payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return payload;
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.skippedTabIds)) return payload;
  return {
    ...p,
    skippedTabIds: p.skippedTabIds.map((n) =>
      typeof n === "number" ? makeExtTabId(browser, n) : n,
    ),
  };
}

/**
 * `ext.sendCommand`, with Chrome's raw errors translated into this API's own
 * vocabulary. Chrome says `No tab with id: 523242703` — a bare numeric in a
 * system whose callers only ever hold `t:<browser>:x…` handles, with no hint
 * which input it was or what to do. The regex rewrite names the handle and
 * the recovery. Unrecognized errors pass through untouched.
 */
async function sendExtMapped(
  ext: ExtensionServer,
  browser: BrowserId,
  kind: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await ext.sendCommand(browser, kind, args);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    const rewritten = msg.replace(
      /No (tab|window|group) with id:? (\d+)/g,
      (_m, what: string, id: string) => {
        const handle =
          what === "tab"
            ? makeExtTabId(browser, Number(id))
            : what === "window"
              ? makeExtWindowId(browser, Number(id))
              : makeExtGroupId(browser, Number(id));
        return `No ${what} ${handle} (it may have been closed — re-run list_tabs for fresh handles)`;
      },
    );
    throw rewritten === msg ? err : new Error(rewritten);
  }
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
    ...(r.payload !== undefined ? { payload: mapPayloadHandles(browser, r.payload) } : {}),
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
      let targetWindowId = params.targetWindowId as string | undefined;
      let targetIndex = params.targetIndex as number | undefined;
      const to = params.to as number | undefined;
      const by = params.by as number | undefined;
      const wantsNewWindow = (params.newWindow as boolean | undefined) ?? false;
      // Cross-browser guards stay BEFORE any I/O — the signed-form resolution
      // below refreshes the snapshot, and a foreign handle must not get that far.
      if (targetWindowId !== undefined) {
        const wp = parseHandle(targetWindowId);
        if (wp.browser !== parsed.browser) {
          throw crossBrowserError("targetWindowId", targetWindowId, wp.browser, parsed.browser);
        }
      }
      if (params.targetGroupId !== undefined) {
        groupNumOf(parsed.browser, params.targetGroupId as string, "targetGroupId");
      }
      // Signed (`to`/`by`) and bare same-window forms resolve HERE, against a
      // fresh snapshot, into the absolute form both executors already speak —
      // so the wire and the deployed extension bundle stay unchanged. The
      // snapshot can lag the browser; the extension's settled `tabs.get` at
      // the end of the move reports the ACTUAL final position either way.
      if (
        to !== undefined ||
        by !== undefined ||
        (targetWindowId === undefined && !wantsNewWindow)
      ) {
        const snap = await deps.refresh();
        const loc = findTabLocation(snap, tabId);
        if (!loc) {
          throw new Error(
            `Tab "${tabId}" is not in the current snapshot — it may have closed or its handle ` +
              `may be stale. Re-run list_tabs.`,
          );
        }
        if (targetWindowId === undefined && !wantsNewWindow) targetWindowId = loc.windowId;
        const sameWindow = targetWindowId === loc.windowId;
        if (to !== undefined || by !== undefined) {
          const destTabCount = sameWindow
            ? loc.windowTabCount
            : findWindowTabCount(snap, targetWindowId as string);
          if (destTabCount === null) {
            throw new Error(
              `Window "${targetWindowId}" is not in the current snapshot — re-run list_tabs ` +
                `for current window handles.`,
            );
          }
          targetIndex = resolveSignedIndex({
            to,
            by,
            currentIndex: loc.index,
            sameWindow,
            destTabCount,
          });
        }
      }
      if (parsed.ext && ext?.isConnected(parsed.browser)) {
        const args: Record<string, unknown> = {
          tabId: extNum(parsed, "tabId"),
          newWindow: wantsNewWindow,
        };
        if (targetWindowId !== undefined) {
          args.targetWindowId = extNumOf(parsed.browser, targetWindowId, "targetWindowId");
        }
        if (targetIndex !== undefined) args.targetIndex = targetIndex;
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
          targetIndex,
          newWindow: wantsNewWindow,
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
      result = extResult(
        browser,
        "group_tabs",
        await sendExtMapped(ext, browser, "group_tabs", args),
      );
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
    case "reload_extension": {
      const browser = params.browser as BrowserId;
      if (!ext?.isConnected(browser)) {
        throw new Error(notConnectedHint(String(browser), browser));
      }
      result = await reloadExtension(ext, browser);
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

/** How long to wait for the extension's socket to drop after it acks. */
const RELOAD_DOWN_TIMEOUT_MS = 5_000;
/** How long to then wait for it to come back. */
const RELOAD_UP_TIMEOUT_MS = 20_000;

/**
 * Reload one browser's extension and REPORT WHAT ACTUALLY HAPPENED.
 *
 * The extension acks before it reloads (see extension-core `reload_extension`),
 * so that `ok` proves only that the message was received — never that the
 * reload worked. Treating it as success would be exactly the "passed while
 * measuring nothing" failure this repo has been burning down all week, and the
 * failure mode is real: if the reloaded manifest asks for a NEW PERMISSION,
 * Chrome leaves the extension disabled pending user approval and it never
 * comes back.
 *
 * So the truth is the socket. Watch it go down, then watch it come back:
 *
 *   down + up      → reconnected: true. It genuinely restarted.
 *   down, no up    → reconnected: false, and say to go look at the browser.
 *   never went down → acked but no restart observed; do not claim success.
 *
 * SAFARI CAVEAT, worth knowing before you trust this there: `runtime.reload()`
 * restarts the extension and re-reads its resources, but on Safari those live
 * inside a signed `.appex` that macOS has registered. `scripts/rebuild.sh`
 * produces a NEW app and `open`s it to re-register; the Settings toggle is what
 * makes Safari adopt that new registration. A reload very likely restarts the
 * OLD bundle, so this probably does not replace the toggle. Unverified — the
 * command is wired up for Safari precisely so it can be tested.
 */
async function reloadExtension(ext: ExtensionServer, browser: BrowserId): Promise<CommandResult> {
  // THE BOOTSTRAP CASE. A bundle old enough to predate this command rejects the
  // kind outright, and "unknown command kind" tells an operator nothing about
  // what to do. Say the actual thing: this one time, reload by hand.
  const raw = await ext.sendCommand(browser, "reload_extension", {}).catch((err: unknown) => {
    const message = (err as Error).message;
    if (/unknown command kind/i.test(message)) {
      throw new Error(
        `The ${browser} extension is running a bundle that predates self-reload support, so it ` +
          `cannot reload itself yet. Reload it by hand ONCE — chrome://extensions, or Safari > ` +
          `Settings > Extensions toggle off/on — and this command works from then on.`,
      );
    }
    throw err;
  });
  const wentDown = await waitFor(() => !ext.isConnected(browser), RELOAD_DOWN_TIMEOUT_MS);
  if (!wentDown) {
    // MEASURED 2026-08-18: this is what Safari does. It accepts
    // `chrome.runtime.reload()` and then does nothing observable — the
    // background page never drops its socket. Do NOT blame a stale bundle
    // here: the bootstrap case is already caught above by "unknown command
    // kind", so reaching this point means the extension DOES support reload
    // and the browser simply ignored it.
    //
    // Safari does not need this command anyway: rebuilding via
    // `pnpm --filter @george43g/safari-extension sideload` re-registers the
    // app and Safari adopts the new bundle by itself within ~15s.
    const safariNote =
      browser === "safari"
        ? " Safari accepts runtime.reload() and ignores it — this is expected. Use " +
          "`pnpm --filter @george43g/safari-extension sideload` instead; Safari picks the " +
          "rebuilt bundle up on its own."
        : "";
    throw new Error(
      `The ${browser} extension acknowledged the reload but its connection never dropped, so ` +
        `no restart happened.${safariNote}`,
    );
  }
  const cameBack = await waitFor(() => ext.isConnected(browser), RELOAD_UP_TIMEOUT_MS);
  if (!cameBack) {
    throw new Error(
      `The ${browser} extension restarted but has not reconnected within ` +
        `${RELOAD_UP_TIMEOUT_MS}ms. If the rebuilt manifest requests a NEW permission, the ` +
        `browser leaves the extension disabled pending your approval and it will not come ` +
        `back on its own — check chrome://extensions (or Safari > Settings > Extensions).`,
    );
  }
  return {
    ok: true,
    command: "reload_extension",
    browser,
    payload: { reconnected: true, acked: raw?.ok !== false },
  };
}

/** Poll `predicate` until true or the deadline passes. Resolution is coarse on purpose. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100).unref());
  }
  return predicate();
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
  const writer = new SnapshotWriter(
    () => loop.lastScanDuration(),
    () => store.getSnapshot().revision ?? 0,
  );
  // Liveness beacon rides the tick, not a timer — a wedged read loop must stop
  // the beat rather than keep reporting "alive" (see SnapshotWriter.heartbeat).
  loop.setOnTick(() => writer.heartbeat());
  const journal = new JournalStore();
  const selections = new SelectionStore();
  const plans = new PlanStore();
  const copyIdempotency = makeIdempotencyCache();
  const operations = new OperationStore();
  operations.warmFromDisk();
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
      snapshotRevision: store.getSnapshot().revision ?? 0,
      snapshotToken: store.getSnapshot().snapshotToken ?? null,
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
    onBookmarks: (params) =>
      bookmarks(params, {
        ext,
        // Only browsers with a LIVE feed can answer; the merge's authority
        // check is the same signal the snapshot uses for `dataSource`.
        connected: () =>
          store
            .getSnapshot()
            .browsers.filter((b) => b.extensionConnected)
            .map((b) => b.browser),
      }),
    onSelectTabs: async (params) => runSelectTabs(params, { store, journal, selections }),
    onPlanTabChange: async (params) =>
      runPlanTabChange(params, { store, journal, selections, plans }),
    onCopyTabs: (params) =>
      runCopyTabs(params, {
        store,
        journal,
        selections,
        idempotency: copyIdempotency,
        operations,
        runCommand: (p) => executeCommand(p, { refresh: () => loop.refresh(), ext }),
      }),
    onCutTabs: (params) =>
      runCutTabs(params, {
        store,
        journal,
        selections,
        idempotency: copyIdempotency,
        operations,
        runCommand: (p) => executeCommand(p, { refresh: () => loop.refresh(), ext }),
      }),
    onApplyTabLayout: (params) =>
      runApplyTabLayout(params, {
        store,
        plans,
        operations,
        runCommand: (p) => executeCommand(p, { refresh: () => loop.refresh(), ext }),
        refresh: () => loop.refresh(),
        // conflict:"replan" — identity-preserving by design: the SAME members
        // (stored keys, missing ⇒ error), never the original selector, so a
        // conflict retry cannot silently widen scope.
        replan: (stale) =>
          runPlanTabChange(
            {
              selector: { kind: "ids", ids: stale.selectionKeys },
              transform: stale.transform,
              ...(stale.pinPolicy !== undefined ? { pinPolicy: stale.pinPolicy } : {}),
            },
            { store, journal, selections, plans },
          ),
      }),
    onListOperations: async (params) =>
      operations.list(Number((params as { limit?: unknown }).limit ?? 20)),
    onGetOperation: async (params) => {
      const id = String((params as { operationId?: unknown }).operationId ?? "");
      const rec = operations.get(id);
      if (rec === undefined) {
        throw new Error(
          `operation "${id}" is not in the ring — older operations live in ` +
            "operations.ndjson under the journal directory.",
        );
      }
      return rec;
    },
    onGetPlan: async (params) => {
      const id = String((params as { planId?: unknown }).planId ?? "");
      const rec = plans.get(id, store.getSnapshot().snapshotToken);
      if (rec === undefined) {
        throw new Error(
          `plan "${id}" is unknown or expired — plans are snapshot-bound and short-lived; ` +
            `re-run plan_tab_change.`,
        );
      }
      return rec;
    },
    onGetSelection: async (params) => {
      const id = String((params as { selectionId?: unknown }).selectionId ?? "");
      const rec = selections.get(id, store.getSnapshot().snapshotToken);
      if (rec === undefined) {
        throw new Error(
          `selection "${id}" is unknown or expired — selections are snapshot-bound and ` +
            `short-lived; re-run select_tabs.`,
        );
      }
      return rec;
    },
  });

  await ipc.start();

  // HTTP interface — OPT-IN. This is the first surface that accepts
  // connections from anything but our own extension, so it stays off unless
  // BROWSER_TAB_HTTP_PORT is set. Failure to bind degrades (the socket keeps
  // working) rather than killing the daemon, exactly like the WS server.
  let http: HttpServer | null = null;
  const port = httpPort();
  if (port > 0) {
    http = new HttpServer({
      port,
      token: ensureToken(),
      store,
      // Dispatch through the SAME entry point the CLI and MCP host use, so an
      // HTTP caller cannot get different behaviour from the same tool name.
      // The tools reach this daemon back over its own unix socket, which is one
      // extra local hop in exchange for exactly one dispatch path.
      callTool: async (name, args) => {
        const result = await callMcpTool(name, args);
        if (result.isError) {
          const first = result.content?.find((b: { type: string }) => b.type === "text");
          const text = first && first.type === "text" ? (first as { text: string }).text : null;
          throw new Error(text ?? "tool failed");
        }
        return result.structuredContent ?? {};
      },
    });
    try {
      await http.start();
    } catch (err) {
      info("http_disabled", { message: (err as Error).message, port });
      http = null;
    }
  }

  loop.start();

  const stop = async (): Promise<void> => {
    loop.stop();
    unsubscribeWriter();
    writer.stop();
    journal.stop();
    await ext?.stop();
    await http?.stop();
    await ipc.stop();
  };
  registerCleanup(stop);

  return { store, loop, merger, journal, ipc, ext, http, stop };
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
