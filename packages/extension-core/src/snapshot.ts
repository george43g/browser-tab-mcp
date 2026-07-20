/**
 * Snapshot builder — chrome.windows/chrome.tabs state mapped into the
 * ExtSnapshot wire shape. Pure mapping functions are exported separately
 * for unit tests (no browser APIs needed).
 */

import type { ExtSnapshot, ExtTab, ExtWindow } from "@george43g/shared-types";
import { api } from "./runtime.js";

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
  tabs?: ChromeTabLike[] | undefined;
}

export function mapTab(tab: ChromeTabLike): ExtTab | null {
  if (tab.id === undefined || tab.id < 0) return null; // devtools etc.
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    url: tab.url ?? tab.pendingUrl ?? "",
    title: tab.title ?? "",
    active: tab.active,
    pinned: tab.pinned,
    audible: tab.audible ?? false,
    discarded: tab.discarded ?? false,
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
  return {
    id: win.id,
    focused: win.focused,
    incognito: win.incognito,
    bounds,
    tabs: (win.tabs ?? []).map(mapTab).filter((t): t is ExtTab => t !== null),
  };
}

export function mapWindows(windows: ChromeWindowLike[]): ExtSnapshot {
  return {
    type: "snapshot",
    windows: windows.map(mapWindow).filter((w): w is ExtWindow => w !== null),
  };
}

export async function buildSnapshot(): Promise<ExtSnapshot> {
  const windows = (await api.windows.getAll({
    populate: true,
    windowTypes: ["normal"],
  })) as unknown as ChromeWindowLike[];
  return mapWindows(windows);
}
