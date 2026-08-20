/**
 * Snapshot builder — chrome.windows/chrome.tabs/chrome.tabGroups state
 * mapped into the ExtSnapshot wire shape. Pure mapping functions are
 * exported separately for unit tests (no browser APIs needed).
 *
 * Enrichment fields (audio/mute/sleep/etc.) are copied through a single
 * shared point — `pickEnrichment` in shared-types — so adding a field can
 * never drift the extension wire and the daemon contract apart.
 */

import type { ExtSnapshot, ExtTab, ExtTabGroup, ExtWindow } from "@george43g/shared-types";
import { pickEnrichment, redactUrlUserinfo, sanitizeFavicon } from "@george43g/shared-types";
import { api } from "./runtime.js";

export interface ChromeMutedInfoLike {
  muted: boolean;
  reason?: string | undefined;
}

export interface ChromeTabLike {
  id?: number | undefined;
  windowId: number;
  index: number;
  url?: string | undefined;
  pendingUrl?: string | undefined;
  title?: string | undefined;
  active: boolean;
  pinned: boolean;
  audible?: boolean | undefined;
  discarded?: boolean | undefined;
  mutedInfo?: ChromeMutedInfoLike | undefined;
  frozen?: boolean | undefined;
  lastAccessed?: number | undefined;
  status?: string | undefined;
  groupId?: number | undefined;
  favIconUrl?: string | undefined;
}

export interface ChromeWindowLike {
  id?: number | undefined;
  focused: boolean;
  incognito: boolean;
  left?: number | undefined;
  top?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  type?: string | undefined;
  state?: string | undefined;
  tabs?: ChromeTabLike[] | undefined;
}

export interface ChromeTabGroupLike {
  id: number;
  windowId: number;
  title?: string | undefined;
  color: string;
  collapsed: boolean;
}

const WINDOW_STATES = ["normal", "minimized", "maximized", "fullscreen"] as const;
type WindowState = (typeof WINDOW_STATES)[number];

function normalizeWindowState(state: string | undefined): WindowState | undefined {
  return WINDOW_STATES.includes(state as WindowState) ? (state as WindowState) : undefined;
}

function normalizeStatus(
  status: string | undefined,
): "loading" | "complete" | "unloaded" | undefined {
  return status === "loading" || status === "complete" || status === "unloaded"
    ? status
    : undefined;
}

export function mapTab(tab: ChromeTabLike): ExtTab | null {
  if (tab.id === undefined || tab.id < 0) return null; // devtools etc.
  const status = normalizeStatus(tab.status);
  const enrichment = pickEnrichment({
    pinned: tab.pinned,
    audible: tab.audible ?? false,
    discarded: tab.discarded ?? false,
    muted: tab.mutedInfo?.muted ?? false,
    ...(tab.mutedInfo?.reason !== undefined ? { mutedReason: tab.mutedInfo.reason } : {}),
    frozen: tab.frozen ?? false,
    ...(tab.lastAccessed !== undefined ? { lastAccessed: tab.lastAccessed } : {}),
    ...(status !== undefined ? { status } : {}),
  });
  const favicon = sanitizeFavicon(tab.favIconUrl);
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    // Basic-auth userinfo never leaves the browser: redacting at the mapper
    // keeps credentials out of the WS frames, the daemon's snapshot files,
    // journals, logs, and every agent context downstream.
    url: redactUrlUserinfo(tab.url ?? tab.pendingUrl ?? ""),
    title: tab.title ?? "",
    active: tab.active,
    ...(typeof tab.groupId === "number" && tab.groupId >= 0 ? { groupId: tab.groupId } : {}),
    ...(favicon ? { favicon } : {}),
    ...enrichment,
  };
}

export function mapWindow(win: ChromeWindowLike): ExtWindow | null {
  if (win.id === undefined) return null;
  if (win.type !== undefined && win.type !== "normal") return null; // popups/devtools
  const bounds =
    win.left !== undefined &&
    win.top !== undefined &&
    win.width !== undefined &&
    win.height !== undefined
      ? { x: win.left, y: win.top, w: win.width, h: win.height }
      : null;
  const state = normalizeWindowState(win.state);
  return {
    id: win.id,
    focused: win.focused,
    incognito: win.incognito,
    bounds,
    ...(state !== undefined ? { state } : {}),
    tabs: (win.tabs ?? []).map(mapTab).filter((t): t is ExtTab => t !== null),
  };
}

export function mapTabGroup(group: ChromeTabGroupLike): ExtTabGroup {
  return {
    id: group.id,
    windowId: group.windowId,
    title: group.title ?? "",
    color: group.color,
    collapsed: group.collapsed,
  };
}

export function mapWindows(
  windows: ChromeWindowLike[],
  groups: ChromeTabGroupLike[] = [],
): ExtSnapshot {
  return {
    type: "snapshot",
    windows: windows.map(mapWindow).filter((w): w is ExtWindow => w !== null),
    groups: groups.map(mapTabGroup),
  };
}

/** Query tab groups when the API exists (Chrome-family); [] on Safari. */
async function queryTabGroups(): Promise<ChromeTabGroupLike[]> {
  const tabGroups = (api as unknown as { tabGroups?: { query?: (q: object) => Promise<unknown> } })
    .tabGroups;
  if (typeof tabGroups?.query !== "function") return [];
  try {
    const groups = (await tabGroups.query({})) as ChromeTabGroupLike[];
    return groups;
  } catch {
    return [];
  }
}

export async function buildSnapshot(): Promise<ExtSnapshot> {
  const windows = (await api.windows.getAll({
    populate: true,
    windowTypes: ["normal"],
  })) as unknown as ChromeWindowLike[];
  const groups = await queryTabGroups();
  return mapWindows(windows, groups);
}
