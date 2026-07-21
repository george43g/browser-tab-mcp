/**
 * Factories for the extension→daemon *wire* shapes (`@george43g/shared-types`):
 * the `snapshot` frames a connector extension pushes over the WebSocket.
 */

import type {
  ExtSnapshot,
  ExtTab,
  ExtTabGroup,
  ExtWindow,
  WindowBounds,
} from "@george43g/shared-types";

const DEFAULT_BOUNDS: WindowBounds = { x: 0, y: 25, w: 1440, h: 875 };

export function makeExtTab(over: Partial<ExtTab> = {}): ExtTab {
  return {
    id: 4001,
    windowId: 812,
    index: 0,
    url: "https://ext.example/",
    title: "From extension",
    active: true,
    pinned: false,
    audible: false,
    discarded: false,
    muted: false,
    frozen: false,
    ...over,
  };
}

export function makeExtTabGroup(over: Partial<ExtTabGroup> = {}): ExtTabGroup {
  return {
    id: 77,
    windowId: 812,
    title: "Work",
    color: "blue",
    collapsed: false,
    ...over,
  };
}

export function makeExtWindow(over: Partial<ExtWindow> = {}): ExtWindow {
  return {
    id: 812,
    focused: true,
    incognito: false,
    bounds: DEFAULT_BOUNDS,
    ...over,
    tabs: over.tabs ?? [makeExtTab()],
  };
}

export function makeExtSnapshot(over: Partial<ExtSnapshot> = {}): ExtSnapshot {
  return {
    type: "snapshot",
    groups: over.groups ?? [],
    ...over,
    windows: over.windows ?? [makeExtWindow()],
  };
}
