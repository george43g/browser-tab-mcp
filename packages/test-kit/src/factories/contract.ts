/**
 * Factories for the daemon *contract* shapes (`@george43g/shared-types`):
 * the merged Snapshot the daemon serves and its CLI/MCP/TUI clients consume.
 *
 * Each builder takes a shallow `Partial<T>` override; nest via composition:
 *   makeSnapshot({ browsers: [makeBrowserState({ windows: [makeContractWindow()] })] })
 */

import type {
  BrowserState,
  BrowserWindow,
  Snapshot,
  Tab,
  WindowBounds,
} from "@george43g/shared-types";

const DEFAULT_BOUNDS: WindowBounds = { x: 0, y: 25, w: 1440, h: 875 };

export function makeContractTab(over: Partial<Tab> = {}): Tab {
  return {
    tabId: "t:chrome:101",
    index: 0,
    url: "https://example.test/",
    title: "Example",
    active: true,
    pinned: false,
    audible: false,
    discarded: false,
    ...over,
  };
}

export function makeContractWindow(over: Partial<BrowserWindow> = {}): BrowserWindow {
  const tabs = over.tabs ?? [makeContractTab()];
  return {
    windowId: "w:chrome:100",
    cgWindowId: null,
    title: "Example",
    bounds: DEFAULT_BOUNDS,
    focused: true,
    incognito: false,
    activeTabIndex: 0,
    tabCount: tabs.length,
    ...over,
    tabs,
  };
}

export function makeBrowserState(over: Partial<BrowserState> = {}): BrowserState {
  return {
    browser: "chrome",
    bundleId: "com.google.Chrome",
    pid: 4242,
    running: true,
    extensionConnected: false,
    dataSource: "applescript",
    windows: over.windows ?? [makeContractWindow()],
    ...over,
  };
}

export function makeSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    version: 1,
    generatedAt: 0,
    source: "daemon",
    browsers: over.browsers ?? [makeBrowserState()],
    ...over,
  };
}
