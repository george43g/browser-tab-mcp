/**
 * Command executors — the daemon's command messages mapped onto the
 * chrome.tabs / chrome.windows / chrome.tabGroups APIs. This is where true
 * state-preserving actions happen (tabs.move keeps scroll/forms/JS; grouping,
 * discard, mute and window geometry have no AppleScript equivalent).
 *
 * Native ids in, native ids out — the daemon converts to/from opaque handles.
 */

import { injectExtract } from "./inject.js";
import { api } from "./runtime.js";

/**
 * Grace period between acking a `reload_extension` and actually reloading.
 * Long enough for the WebSocket write to drain, short enough that the operator
 * does not notice. Not configurable: there is no reason to tune it, and an env
 * knob here would be one more thing to get wrong.
 */
const RELOAD_DELAY_MS = 150;

export interface CommandArgs {
  tabId?: number;
  mode?: string;
  maxBytes?: number;
  tabIds?: number[];
  windowId?: number;
  targetWindowId?: number;
  targetGroupId?: number;
  targetIndex?: number;
  index?: number;
  groupId?: number;
  newWindow?: boolean;
  url?: string;
  urls?: string[];
  activate?: boolean;
  pinned?: boolean;
  action?: string;
  quality?: number;
  text?: string;
  startTime?: number;
  endTime?: number;
  maxResults?: number;
  title?: string;
  color?: string;
  collapsed?: boolean;
  bounds?: { x: number; y: number; w: number; h: number };
  // bookmarks. `id` is a STRING here (Chrome issues opaque string bookmark
  // ids) unlike every tab/window id above, which are numbers.
  id?: string;
  query?: string;
  folderId?: string;
  parentId?: string;
  recursive?: boolean;
  state?: string;
  incognito?: boolean;
  focused?: boolean;
  raiseWindow?: boolean;
}

export interface CommandOutcome {
  tabId?: number;
  windowId?: number;
  groupId?: number;
  index?: number;
  payload?: unknown;
  /** Window state after the command (focus_tab). */
  windowState?: string;
  /** Whether the window was minimized BEFORE the command ran (focus_tab). */
  wasMinimized?: boolean;
  /** Whether the window is focused after the command (focus_tab). */
  windowFocused?: boolean;
}

function requireTab(args: CommandArgs): number {
  if (typeof args.tabId !== "number") throw new Error("missing tabId");
  return args.tabId;
}

function requireWindow(args: CommandArgs): number {
  if (typeof args.windowId !== "number") throw new Error("missing windowId");
  return args.windowId;
}

/** chrome.tabs typed loosely — the shim exposes both `chrome` and `browser`. */
type Tabs = typeof chrome.tabs;
type Windows = typeof chrome.windows;
type TabGroups = typeof chrome.tabGroups;

/**
 * Read a window without ever failing the command it decorates.
 *
 * `windows.get` is only used to report state (before/after a focus), never to
 * decide anything — a browser that lacks it, or a window that vanished between
 * two awaits, must degrade to "unknown" rather than turn a successful focus
 * into an error.
 */
async function peekWindow(
  windows: Windows,
  windowId: number,
): Promise<chrome.windows.Window | undefined> {
  if (typeof windows.get !== "function") return undefined;
  try {
    return await windows.get(windowId);
  } catch {
    return undefined;
  }
}

async function tabActionOutcome(args: CommandArgs): Promise<CommandOutcome> {
  const tabId = requireTab(args);
  const action = args.action;
  const tabs = api.tabs as Tabs;
  switch (action) {
    case "mute":
      await tabs.update(tabId, { muted: true });
      break;
    case "unmute":
      await tabs.update(tabId, { muted: false });
      break;
    case "pin":
      await tabs.update(tabId, { pinned: true });
      break;
    case "unpin":
      await tabs.update(tabId, { pinned: false });
      break;
    case "reload":
      await tabs.reload(tabId);
      break;
    case "navigate": {
      if (!args.url) throw new Error("navigate requires url");
      await tabs.update(tabId, { url: args.url });
      break;
    }
    case "back":
      await tabs.goBack(tabId);
      break;
    case "forward":
      await tabs.goForward(tabId);
      break;
    case "discard": {
      const t = await tabs.discard(tabId);
      return { tabId: t?.id ?? tabId, payload: { action } };
    }
    case "duplicate": {
      const dup = await tabs.duplicate(tabId);
      return {
        ...(dup?.id !== undefined ? { tabId: dup.id } : { tabId }),
        ...(dup?.windowId !== undefined ? { windowId: dup.windowId } : {}),
        ...(dup?.index !== undefined ? { index: dup.index } : {}),
        payload: { action },
      };
    }
    default:
      throw new Error(`unknown tab action "${String(action)}"`);
  }
  return { tabId, payload: { action } };
}

/**
 * Split requested tab ids into live tabs and stale ids.
 *
 * Group operations take a LIST, and lists age: in a real cleanup run (103
 * tabs, 2026-08-20) one already-closed tab out of twelve failed the whole
 * call with Chrome's raw "No tab with id: …" — eleven perfectly good ids
 * done in by a twelfth. So every list-taking group action validates per-id
 * first, acts on what exists, and reports what it skipped. All-stale is
 * still an error: acting on nothing must not read as success.
 */
async function partitionLiveTabs(
  tabs: Tabs,
  tabIds: number[],
): Promise<{ live: chrome.tabs.Tab[]; skippedTabIds: number[] }> {
  const looked = await Promise.all(
    tabIds.map(async (id) => {
      try {
        return await tabs.get(id);
      } catch {
        return null;
      }
    }),
  );
  const live: chrome.tabs.Tab[] = [];
  const skippedTabIds: number[] = [];
  looked.forEach((t, i) => {
    const id = tabIds[i] as number;
    if (t) live.push(t);
    else skippedTabIds.push(id);
  });
  return { live, skippedTabIds };
}

async function groupTabsOutcome(args: CommandArgs): Promise<CommandOutcome> {
  const action = args.action;
  const tabs = api.tabs as Tabs;
  const tabGroups = api.tabGroups as TabGroups;
  const groupProps = (): chrome.tabGroups.UpdateProperties => ({
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.color !== undefined ? { color: args.color as chrome.tabGroups.ColorEnum } : {}),
    ...(args.collapsed !== undefined ? { collapsed: args.collapsed } : {}),
  });
  switch (action) {
    case "create": {
      if (!args.tabIds?.length) throw new Error("group create requires tabIds");
      const { live, skippedTabIds } = await partitionLiveTabs(tabs, args.tabIds);
      if (live.length === 0) {
        throw new Error(
          `none of the ${args.tabIds.length} tabs exist any more — re-run list_tabs for fresh handles`,
        );
      }
      // createProperties.windowId is NOT optional in spirit: omitting it makes
      // Chrome create the group in the CURRENT (focused) window and MOVE every
      // tab there — so grouping window-1 tabs while window 2 was focused
      // silently relocated ~40 tabs (dogfood run, 2026-08-20). Pinning to the
      // first live tab's own window makes grouping a grouping.
      const groupId = await tabs.group({
        tabIds: live.map((t) => t.id as number),
        createProperties: { windowId: (live[0] as chrome.tabs.Tab).windowId },
      });
      const props = groupProps();
      if (Object.keys(props).length > 0) await tabGroups.update(groupId, props);
      return {
        groupId,
        payload: { action, ...(skippedTabIds.length ? { skippedTabIds } : {}) },
      };
    }
    case "add": {
      if (typeof args.groupId !== "number") throw new Error("group add requires groupId");
      if (!args.tabIds?.length) throw new Error("group add requires tabIds");
      const { live, skippedTabIds } = await partitionLiveTabs(tabs, args.tabIds);
      if (live.length === 0) {
        throw new Error(
          `none of the ${args.tabIds.length} tabs exist any more — re-run list_tabs for fresh handles`,
        );
      }
      const groupId = await tabs.group({
        tabIds: live.map((t) => t.id as number),
        groupId: args.groupId,
      });
      return {
        groupId,
        payload: { action, ...(skippedTabIds.length ? { skippedTabIds } : {}) },
      };
    }
    case "remove": {
      if (!args.tabIds?.length) throw new Error("group remove requires tabIds");
      const { live, skippedTabIds } = await partitionLiveTabs(tabs, args.tabIds);
      if (live.length === 0) {
        throw new Error(
          `none of the ${args.tabIds.length} tabs exist any more — re-run list_tabs for fresh handles`,
        );
      }
      await tabs.ungroup(live.map((t) => t.id as number));
      return {
        payload: { action, ...(skippedTabIds.length ? { skippedTabIds } : {}) },
      };
    }
    case "update": {
      if (typeof args.groupId !== "number") throw new Error("group update requires groupId");
      const props = groupProps();
      if (Object.keys(props).length === 0)
        throw new Error("group update needs title/color/collapsed");
      await tabGroups.update(args.groupId, props);
      return { groupId: args.groupId, payload: { action } };
    }
    case "move": {
      if (typeof args.groupId !== "number") throw new Error("group move requires groupId");
      const moveProps: chrome.tabGroups.MoveProperties = {
        index: args.index ?? -1,
        ...(args.targetWindowId !== undefined ? { windowId: args.targetWindowId } : {}),
      };
      await tabGroups.move(args.groupId, moveProps);
      return { groupId: args.groupId, payload: { action } };
    }
    default:
      throw new Error(`unknown group action "${String(action)}"`);
  }
}

async function openWindowOutcome(args: CommandArgs): Promise<CommandOutcome> {
  const urls = args.urls ?? [];
  if (urls.length === 0) throw new Error("open_window requires at least one url");
  const windows = api.windows as Windows;
  const createData: chrome.windows.CreateData = {
    url: urls,
    incognito: args.incognito ?? false,
  };
  // chrome.windows.create forbids minimized/maximized/fullscreen alongside
  // explicit geometry. Rather than dropping one, create WITH the geometry and
  // apply the state as a follow-up update. ("normal" needs no follow-up — it is
  // what an explicitly-placed window already is.)
  const deferredState =
    args.bounds && args.state && args.state !== "normal"
      ? (args.state as chrome.windows.windowStateEnum)
      : undefined;

  if (args.bounds) {
    createData.left = args.bounds.x;
    createData.top = args.bounds.y;
    createData.width = args.bounds.w;
    createData.height = args.bounds.h;
    createData.focused = args.focused ?? true;
  } else if (args.state) {
    createData.state = args.state as chrome.windows.windowStateEnum;
    // focused:true is invalid with a minimized state.
    if (args.state !== "minimized") createData.focused = args.focused ?? true;
  } else {
    createData.focused = args.focused ?? true;
  }
  const win = await windows.create(createData);
  if (deferredState !== undefined && win?.id !== undefined) {
    await windows.update(win.id, { state: deferredState });
  }
  return {
    ...(win?.id !== undefined ? { windowId: win.id } : {}),
    payload: { tabCount: win?.tabs?.length ?? urls.length },
  };
}

async function setWindowOutcome(args: CommandArgs): Promise<CommandOutcome> {
  const windowId = requireWindow(args);
  const windows = api.windows as Windows;
  const state = args.state as chrome.windows.windowStateEnum | undefined;
  const bounds = args.bounds;
  const focused = args.focused;

  if (!state && !bounds) {
    if (focused === undefined) {
      throw new Error("set_window needs at least one of bounds, display, state, focused");
    }
    const only = await windows.update(windowId, { focused });
    return { windowId: only?.id ?? windowId, payload: {} };
  }

  // chrome.windows.update rejects a state alongside explicit geometry, so a
  // request carrying BOTH has to become two sequential updates. Which order,
  // and what to wait on, took four attempts to get right. What was measured:
  //
  //  - Sending geometry to a MINIMISED window poisons it. The window visibly
  //    restores, then re-minimises a second or two later, because the geometry
  //    update is applied asynchronously and re-asserts the state it captured.
  //    This happens in EITHER order, so ordering alone never fixed it, and it
  //    happens even when the bounds are unchanged.
  //  - Sending geometry to a NORMAL window is safe and sticks.
  //  - `windows.get().state` cannot be used to detect the transition: it reports
  //    the requested state as soon as the update is accepted, so a poll returns
  //    "normal" while the window is still mid-restore. (At rest it IS accurate —
  //    it agrees with AppleScript's `minimized` — which is what made this
  //    confusing.)
  //
  // So the rule is not about ordering, it is about WHAT STATE THE WINDOW IS IN
  // when geometry arrives: never send geometry to a non-normal window. Restore
  // first, let the restore actually finish, then place it, then apply the
  // caller's target state.
  const stateStep = (): chrome.windows.UpdateInfo => {
    const step: chrome.windows.UpdateInfo = { state };
    // focused is invalid alongside a minimized state; safe otherwise.
    if (focused !== undefined && state !== "minimized") step.focused = focused;
    return step;
  };
  const boundsStep = (): chrome.windows.UpdateInfo => {
    const step: chrome.windows.UpdateInfo = {
      left: bounds?.x,
      top: bounds?.y,
      width: bounds?.w,
      height: bounds?.h,
    };
    // Only carry focus here when there is no state step to carry it.
    if (focused !== undefined && !state) step.focused = focused;
    return step;
  };

  let win: chrome.windows.Window | undefined;
  if (bounds) {
    win = (await ensureRestored(windows, windowId)) ?? win;
    win = await windows.update(windowId, boundsStep());
  }
  if (state) win = await windows.update(windowId, stateStep());
  return { windowId: win?.id ?? windowId, payload: {} };
}

/**
 * How long to let a restore actually complete before touching geometry.
 *
 * This is a real sleep rather than a poll on purpose: `windows.get().state`
 * flips to the requested value as soon as the update is ACCEPTED, so polling it
 * returns immediately while the window is still mid-restore — that was the bug
 * in two earlier fixes. There is no accurate in-flight signal to wait on, so the
 * wait is bounded by time and only paid when a restore was actually needed.
 */
const RESTORE_SETTLE_MS = 400;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Bring `windowId` to `normal` if it isn't already, so geometry can be applied.
 *
 * Geometry sent to a minimised window is applied asynchronously and re-asserts
 * the old state when it lands — the window visibly pops up and then drops back
 * a second later. Restoring FIRST and letting it finish avoids that entirely.
 *
 * A no-op when the window is already normal, so the common case costs one
 * `windows.get` and no delay. Degrades to a no-op where `windows.get` is absent
 * (Safari's shim) rather than blindly sleeping, and never throws — the read
 * itself is `peekWindow`, which owns both of those guarantees.
 */
async function ensureRestored(
  windows: Windows,
  windowId: number,
): Promise<chrome.windows.Window | undefined> {
  const seen = await peekWindow(windows, windowId);
  if (!seen || seen.state === "normal") return seen;
  try {
    const restored = await windows.update(windowId, { state: "normal" });
    await delay(RESTORE_SETTLE_MS);
    return restored;
  } catch {
    return undefined; // window vanished — the next update will surface it
  }
}

export async function executeCommand(kind: string, args: CommandArgs): Promise<CommandOutcome> {
  const tabs = api.tabs as Tabs;
  const windows = api.windows as Windows;
  switch (kind) {
    case "focus_tab": {
      // raiseWindow defaults TRUE: that is what this pathway always did, and
      // the AppleScript pathway now matches it (it clears `minimized` first).
      // false = activate the tab in place, leaving window placement to whoever
      // owns it — browser-tab does not manage Spaces or visibility.
      const raiseWindow = args.raiseWindow !== false;
      const tabId = requireTab(args);
      const tab = await tabs.update(tabId, { active: true });
      const outcome: CommandOutcome = {
        tabId,
        ...(tab?.index !== undefined ? { index: tab.index } : {}),
      };
      const windowId = tab?.windowId;
      if (windowId === undefined) return outcome;
      outcome.windowId = windowId;

      // Read BEFORE raising — the pre-state is the one thing a later snapshot
      // can never recover, and it is what tells a WM the tab was somewhere the
      // user could not see.
      const before = await peekWindow(windows, windowId);
      if (before?.state !== undefined) outcome.wasMinimized = before.state === "minimized";
      if (raiseWindow) {
        // Clear `minimized` FIRST, then focus — the same ordering the
        // AppleScript adapters use, and for the same reason: a minimized
        // window cannot be raised, so the order IS the fix.
        //
        // This path used to pass only `{focused:true}` and lean on Chrome
        // un-minimizing as a side effect. That side effect is not contractual
        // and does not always happen: measured 2026-08-24 on Chromium under
        // `--headless=new`, `windows.update({focused:true})` on a minimized
        // window returns `focused:true` with `state` still `"minimized"` — a
        // focused tab inside a window the user cannot see, which is exactly
        // the bug the AppleScript pathway was fixed for. The two pathways
        // disagreeing about one documented contract is how that bug survived.
        //
        // CONDITIONAL ON `minimized` on purpose: sending `state:"normal"`
        // unconditionally would un-maximize a maximized window, turning a
        // focus call into an unrequested resize.
        if (before?.state === "minimized") await windows.update(windowId, { state: "normal" });
        await windows.update(windowId, { focused: true });
      }
      const after = (await peekWindow(windows, windowId)) ?? before;
      if (after?.state !== undefined) outcome.windowState = after.state;
      if (after?.focused !== undefined) outcome.windowFocused = after.focused;
      return outcome;
    }
    case "close_tab": {
      const tabId = requireTab(args);
      await tabs.remove(tabId);
      return { tabId };
    }
    case "move_tab": {
      const tabId = requireTab(args);
      let outcome: CommandOutcome;
      if (args.newWindow) {
        const win = await windows.create({ tabId });
        outcome = { tabId, ...(win?.id !== undefined ? { windowId: win.id } : {}), index: 0 };
      } else if (typeof args.targetWindowId === "number") {
        const moved = await tabs.move(tabId, {
          windowId: args.targetWindowId,
          index: args.targetIndex ?? -1,
        });
        const tab = Array.isArray(moved) ? moved[0] : moved;
        outcome = {
          tabId,
          windowId: args.targetWindowId,
          ...(tab?.index !== undefined ? { index: tab.index } : {}),
        };
      } else {
        throw new Error("move_tab needs targetWindowId or newWindow:true");
      }
      // Optional re-group after the move (Chrome-family only).
      if (typeof args.targetGroupId === "number") {
        await tabs.group({ tabIds: [tabId], groupId: args.targetGroupId });
        outcome.groupId = args.targetGroupId;
      }
      // Report where the tab ACTUALLY ended up, not what the intermediate
      // calls claimed. `tabs.move` with index -1 has returned indices past the
      // end of the window (80-85 in a 41-tab window, dogfood 2026-08-20), and
      // the re-group above can shift the tab again — so any caller doing
      // follow-up targetIndex math off the echoed value was being misled.
      // One final read is the honest answer; degrade silently if it fails,
      // because the move itself already succeeded.
      try {
        const settled = await tabs.get(tabId);
        if (settled?.index !== undefined) outcome.index = settled.index;
        if (settled?.windowId !== undefined) outcome.windowId = settled.windowId;
      } catch {
        // keep the intermediate values — better than failing a completed move
      }
      return outcome;
    }
    case "open_tab": {
      if (!args.url) throw new Error("missing url");
      const tab = await tabs.create({
        url: args.url,
        active: args.activate ?? true,
        pinned: args.pinned ?? false,
        ...(typeof args.windowId === "number" ? { windowId: args.windowId } : {}),
        ...(typeof args.index === "number" ? { index: args.index } : {}),
      });
      if ((args.activate ?? true) && tab?.windowId !== undefined) {
        await windows.update(tab.windowId, { focused: true });
      }
      if (typeof args.groupId === "number" && tab?.id !== undefined) {
        await tabs.group({ tabIds: [tab.id], groupId: args.groupId });
      }
      return {
        ...(tab?.id !== undefined ? { tabId: tab.id } : {}),
        ...(tab?.windowId !== undefined ? { windowId: tab.windowId } : {}),
        ...(tab?.index !== undefined ? { index: tab.index } : {}),
        ...(typeof args.groupId === "number" ? { groupId: args.groupId } : {}),
      };
    }
    case "tab_action":
      return tabActionOutcome(args);
    case "group_tabs":
      return groupTabsOutcome(args);
    case "open_window":
      return openWindowOutcome(args);
    case "set_window":
      return setWindowOutcome(args);
    case "close_window": {
      const windowId = requireWindow(args);
      await windows.remove(windowId);
      return { windowId, payload: {} };
    }
    case "extract_content": {
      const tabId = requireTab(args);
      const result = await injectExtract(tabId, args.mode ?? "text", args.maxBytes ?? 0);
      return { tabId, payload: result };
    }
    case "capture_tab": {
      // captureVisibleTab grabs the *active* tab of a window — the daemon
      // preflights that this tab is active, or (with focus) activates it first.
      const tabId = requireTab(args);
      const windowId = requireWindow(args);
      if (args.activate) await tabs.update(tabId, { active: true });
      const quality = typeof args.quality === "number" ? args.quality : 70;
      const dataUrl = await tabs.captureVisibleTab(windowId, { format: "jpeg", quality });
      return { tabId, windowId, payload: { dataUrl } };
    }
    /**
     * Restart this extension from disk.
     *
     * THE ORDERING IS THE WHOLE TRICK. `runtime.reload()` tears down the
     * background context immediately, so calling it inline would kill us
     * before the result frame reaches the daemon — every successful reload
     * would be reported as a command timeout. So we return FIRST and reload on
     * a later turn of the event loop, once the socket write has drained.
     *
     * This is also why a self-disable via `chrome.management` could never
     * work: an extension that disables itself is gone and never gets to
     * re-enable. `runtime.reload()` is atomic and needs no second party —
     * which is why there is no "manager" mini-extension here. It is also the
     * only mechanism present in BOTH Chrome (25+) and Safari (14+);
     * `chrome.management` is absent from Safari entirely.
     *
     * The daemon does not trust this `ok` as proof of anything: it watches for
     * the socket to drop and come back. See `reloadExtension` in
     * daemon/index.ts.
     */
    case "reload_extension": {
      const runtime = api.runtime as typeof chrome.runtime | undefined;
      if (typeof runtime?.reload !== "function") {
        throw new Error("runtime.reload is unavailable in this browser");
      }
      setTimeout(() => {
        runtime.reload();
      }, RELOAD_DELAY_MS);
      return { payload: { scheduled: true, delayMs: RELOAD_DELAY_MS } };
    }

    case "history_search": {
      const history = api.history as typeof chrome.history | undefined;
      if (typeof history?.search !== "function") {
        throw new Error("history API unavailable in this browser");
      }
      const items = await history.search({
        text: args.text ?? "",
        ...(typeof args.startTime === "number" ? { startTime: args.startTime } : {}),
        ...(typeof args.endTime === "number" ? { endTime: args.endTime } : {}),
        maxResults: typeof args.maxResults === "number" ? args.maxResults : 100,
      });
      // Map chrome HistoryItem → the daemon's raw row shape (it tags browser).
      // lastVisitTime is already epoch ms; the daemon leaves it as-is.
      const rows = items.map((it) => ({
        url: it.url ?? "",
        ...(it.title !== undefined ? { title: it.title } : {}),
        visitTime: Math.round(it.lastVisitTime ?? 0),
        visitCount: it.visitCount ?? 0,
      }));
      return { payload: { rows } };
    }
    case "bookmarks": {
      const bookmarks = api.bookmarks as typeof chrome.bookmarks | undefined;
      if (!bookmarks) throw new Error("bookmarks API unavailable in this browser");
      const action = String(args.action ?? "search");
      const max = typeof args.maxResults === "number" ? args.maxResults : 100;

      // Chrome's tree nodes nest; every consumer here wants rows. `parentId`
      // preserves the structure without a recursive schema.
      const flatten = (nodes: chrome.bookmarks.BookmarkTreeNode[]): BookmarkRow[] => {
        const out: BookmarkRow[] = [];
        const walk = (n: chrome.bookmarks.BookmarkTreeNode): void => {
          out.push({
            id: n.id,
            ...(n.parentId !== undefined ? { parentId: n.parentId } : {}),
            title: n.title ?? "",
            // A node with no `url` IS a folder — that distinction is the whole
            // shape of the data, so it must survive the mapping intact.
            ...(n.url !== undefined ? { url: n.url } : {}),
            ...(n.dateAdded !== undefined ? { dateAdded: n.dateAdded } : {}),
            ...(n.index !== undefined ? { index: n.index } : {}),
          });
          for (const c of n.children ?? []) walk(c);
        };
        for (const n of nodes) walk(n);
        return out;
      };

      if (action === "search") {
        const found = await bookmarks.search(String(args.query ?? ""));
        const rows = flatten(found);
        return { payload: { nodes: rows.slice(0, max), truncated: rows.length > max } };
      }
      if (action === "list") {
        const folderId = args.folderId === undefined ? undefined : String(args.folderId);
        // `getSubTree` on a folder returns that folder WITH its children; taking
        // `children` skips re-reporting the folder as its own first row.
        const roots = folderId ? await bookmarks.getSubTree(folderId) : await bookmarks.getTree();
        const children = roots.flatMap((r) => r.children ?? []);
        const rows = args.recursive === true ? flatten(children) : flatten(shallow(children));
        return { payload: { nodes: rows.slice(0, max), truncated: rows.length > max } };
      }
      if (action === "create") {
        const created = await bookmarks.create({
          ...(args.parentId !== undefined ? { parentId: String(args.parentId) } : {}),
          ...(args.title !== undefined ? { title: String(args.title) } : {}),
          // Omitting url is what makes a FOLDER — passing an empty string
          // would create a bookmark pointing nowhere instead.
          ...(args.url !== undefined ? { url: String(args.url) } : {}),
          ...(typeof args.index === "number" ? { index: args.index } : {}),
        });
        return { payload: { nodes: flatten([created]) } };
      }
      if (action === "update") {
        const id = String(args.id ?? "");
        if (!id) throw new Error("bookmarks update needs an id");
        const updated = await bookmarks.update(id, {
          ...(args.title !== undefined ? { title: String(args.title) } : {}),
          ...(args.url !== undefined ? { url: String(args.url) } : {}),
        });
        return { payload: { nodes: flatten([updated]) } };
      }
      if (action === "remove") {
        const id = String(args.id ?? "");
        if (!id) throw new Error("bookmarks remove needs an id");
        // A folder needs removeTree; `remove` throws on a non-empty one. Probe
        // the node first so the caller does not have to know which it is.
        const [node] = await bookmarks.get(id);
        if (node && node.url === undefined) await bookmarks.removeTree(id);
        else await bookmarks.remove(id);
        return { payload: { removed: id, nodes: [] } };
      }
      throw new Error(`unknown bookmarks action "${action}"`);
    }
    default:
      throw new Error(`unknown command kind "${kind}"`);
  }
}

/** The flat row shape the daemon maps into `BookmarkNodeSchema`. */
interface BookmarkRow {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
  dateAdded?: number;
  index?: number;
}

/** Strip children so `flatten` yields direct members only. */
function shallow(nodes: chrome.bookmarks.BookmarkTreeNode[]): chrome.bookmarks.BookmarkTreeNode[] {
  return nodes.map((n) => ({ ...n, children: undefined }));
}
