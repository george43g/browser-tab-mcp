/**
 * Factories for the raw `chrome.*` INPUT shapes the extension-core mappers
 * (`mapTab`/`mapWindow`/`mapWindows`) and `buildSnapshot` consume. These
 * mirror extension-core's structural `ChromeTabLike`/`ChromeWindowLike` (a
 * subset of `chrome.tabs.Tab` / `chrome.windows.Window`) — redeclared here so
 * test-kit never has to import `extension-core` (which would be a cycle).
 *
 * Return types are intentionally left to inference so callers can override a
 * field with `undefined` (e.g. `makeChromeTab({ url: undefined })`) to exercise
 * the mappers' fallback branches, exactly like the builders they replace.
 */

export interface ChromeMutedInfoLike {
  muted: boolean;
  reason?: string;
}

export interface ChromeTabLike {
  id?: number;
  windowId: number;
  index: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
  active: boolean;
  pinned: boolean;
  audible?: boolean;
  discarded?: boolean;
  mutedInfo?: ChromeMutedInfoLike;
  frozen?: boolean;
  lastAccessed?: number;
  status?: string;
  groupId?: number;
  favIconUrl?: string;
}

export interface ChromeWindowLike {
  id?: number;
  focused: boolean;
  incognito: boolean;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  type?: string;
  state?: string;
  tabs?: ChromeTabLike[];
}

export interface ChromeTabGroupLike {
  id: number;
  windowId: number;
  title?: string;
  color: string;
  collapsed: boolean;
}

export function makeChromeTab(over: Partial<ChromeTabLike> = {}) {
  return {
    id: 42,
    windowId: 7,
    index: 0,
    url: "https://example.com/",
    title: "Example",
    active: true,
    pinned: false,
    audible: false,
    discarded: false,
    ...over,
  };
}

export function makeChromeWindow(over: Partial<ChromeWindowLike> = {}) {
  return {
    id: 7,
    focused: true,
    incognito: false,
    left: 0,
    top: 25,
    width: 1440,
    height: 875,
    type: "normal",
    ...over,
    tabs: over.tabs ?? [makeChromeTab()],
  };
}

export function makeChromeTabGroup(over: Partial<ChromeTabGroupLike> = {}) {
  return {
    id: 77,
    windowId: 7,
    title: "Work",
    color: "blue",
    collapsed: false,
    ...over,
  };
}
