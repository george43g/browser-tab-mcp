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
  state?: string;
  incognito?: boolean;
  focused?: boolean;
}

export interface CommandOutcome {
  tabId?: number;
  windowId?: number;
  groupId?: number;
  index?: number;
  payload?: unknown;
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
      const groupId = await tabs.group({ tabIds: args.tabIds });
      const props = groupProps();
      if (Object.keys(props).length > 0) await tabGroups.update(groupId, props);
      return { groupId, payload: { action } };
    }
    case "add": {
      if (typeof args.groupId !== "number") throw new Error("group add requires groupId");
      if (!args.tabIds?.length) throw new Error("group add requires tabIds");
      const groupId = await tabs.group({ tabIds: args.tabIds, groupId: args.groupId });
      return { groupId, payload: { action } };
    }
    case "remove": {
      if (!args.tabIds?.length) throw new Error("group remove requires tabIds");
      await tabs.ungroup(args.tabIds);
      return { payload: { action } };
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

  // chrome.windows.update rejects a state alongside explicit geometry, so a
  // request carrying BOTH has to become two sequential updates. It previously
  // took `bounds` and silently discarded `state` while still returning ok —
  // `--bounds … --state normal` left a minimized window minimized.
  //
  // Order is state-then-bounds: "restore it, then put it here" means the
  // caller's explicit geometry must land last and win.
  const steps: chrome.windows.UpdateInfo[] = [];

  if (args.state) {
    const state = args.state as chrome.windows.windowStateEnum;
    const step: chrome.windows.UpdateInfo = { state };
    // focused is invalid alongside a minimized state; safe otherwise.
    if (args.focused !== undefined && state !== "minimized") step.focused = args.focused;
    steps.push(step);
  }

  if (args.bounds) {
    const step: chrome.windows.UpdateInfo = {
      left: args.bounds.x,
      top: args.bounds.y,
      width: args.bounds.w,
      height: args.bounds.h,
    };
    // Only carry focus here when there was no state step to carry it.
    if (args.focused !== undefined && !args.state) step.focused = args.focused;
    steps.push(step);
  }

  if (steps.length === 0) {
    if (args.focused === undefined) {
      throw new Error("set_window needs at least one of bounds, display, state, focused");
    }
    steps.push({ focused: args.focused });
  }

  let win: chrome.windows.Window | undefined;
  for (const step of steps) {
    win = await windows.update(windowId, step);
  }
  return { windowId: win?.id ?? windowId, payload: {} };
}

export async function executeCommand(kind: string, args: CommandArgs): Promise<CommandOutcome> {
  const tabs = api.tabs as Tabs;
  const windows = api.windows as Windows;
  switch (kind) {
    case "focus_tab": {
      const tabId = requireTab(args);
      const tab = await tabs.update(tabId, { active: true });
      if (tab?.windowId !== undefined) {
        await windows.update(tab.windowId, { focused: true });
      }
      return {
        tabId,
        ...(tab?.windowId !== undefined ? { windowId: tab.windowId } : {}),
        ...(tab?.index !== undefined ? { index: tab.index } : {}),
      };
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
    default:
      throw new Error(`unknown command kind "${kind}"`);
  }
}
