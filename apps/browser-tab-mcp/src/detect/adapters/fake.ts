/**
 * Fixture adapter — enabled with BROWSER_TAB_FAKE_ADAPTER=1 so integration
 * tests and the stress harness never need a real browser (mirrors the
 * MCP_TEST_NOOP_DELAY_MS test-hook pattern).
 *
 * Deterministic data, including one title carrying an ANSI escape so tests
 * can assert sanitization end-to-end.
 */

import { sanitize } from "@george43g/mcp-kit";
import type {
  BrowserId,
  BrowserState,
  BrowserWindow,
  CommandResult,
  MoveTabInput,
  OpenTabInput,
} from "@george43g/shared-types";
import { makeChromiumTabId, makeSafariTabId, makeWindowId } from "../ids.js";
import type { AdapterSpec, BrowserAdapter } from "./types.js";

const FAKE_BUNDLES: Record<BrowserId, string> = {
  chrome: "com.google.Chrome",
  brave: "com.brave.Browser",
  chromium: "org.chromium.Chromium",
  safari: "com.apple.Safari",
};

interface FakeTabSeed {
  url: string;
  title: string;
}

const CHROMIUM_WINDOWS: FakeTabSeed[][] = [
  [
    { url: "https://mail.google.com/mail/u/0/#inbox", title: "Inbox (3) - Gmail" },
    { url: "https://github.com/george43g/browser-tab-mcp", title: "browser-tab-mcp" },
    { url: "https://news.ycombinator.com/", title: "Hacker News \u001b[31mANSI\u001b[0m" },
  ],
  [{ url: "https://developer.apple.com/documentation/", title: "Apple Developer" }],
];

const SAFARI_WINDOWS: FakeTabSeed[][] = [
  [
    { url: "https://www.apple.com/", title: "Apple" },
    { url: "https://developer.apple.com/safari/", title: "Safari - Apple Developer" },
  ],
];

function buildWindows(browser: BrowserId, seeds: FakeTabSeed[][]): BrowserWindow[] {
  return seeds.map((tabs, wi) => {
    const nativeWinId = 100 + wi;
    return {
      windowId: makeWindowId(browser, nativeWinId),
      cgWindowId: null,
      title: sanitize(tabs[0]?.title ?? "") ?? "",
      bounds: { x: 0, y: 25, w: 1440, h: 875 },
      focused: wi === 0,
      incognito: false,
      activeTabIndex: 0,
      tabCount: tabs.length,
      tabs: tabs.map((t, ti) => ({
        tabId:
          browser === "safari"
            ? makeSafariTabId(nativeWinId, ti + 1)
            : makeChromiumTabId(browser, 9900 + wi * 100 + ti),
        index: ti,
        url: sanitize(t.url) ?? "",
        title: sanitize(t.title) ?? "",
        active: ti === 0,
        pinned: false,
        audible: false,
        discarded: false,
        muted: false,
        frozen: false,
      })),
    };
  });
}

export function fakeAdapterEnabled(): boolean {
  return process.env.BROWSER_TAB_FAKE_ADAPTER === "1";
}

export function makeFakeAdapter(spec: AdapterSpec): BrowserAdapter {
  const state = (): BrowserState => ({
    browser: spec.browser,
    bundleId: FAKE_BUNDLES[spec.browser],
    pid: 4242,
    running: true,
    extensionConnected: false,
    dataSource: "applescript",
    tabGroups: [],
    windows: buildWindows(
      spec.browser,
      spec.browser === "safari" ? SAFARI_WINDOWS : CHROMIUM_WINDOWS,
    ),
  });

  const okResult = (command: string, extra: Partial<CommandResult> = {}): CommandResult => ({
    ok: true,
    command,
    browser: spec.browser,
    ...extra,
  });

  return {
    spec,
    probe: async () => ({ running: true, pid: 4242 }),
    readState: async () => state(),
    focusTab: async (tabId) => okResult("focus_tab", { tabId }),
    closeTab: async (tabId) => okResult("close_tab", { tabId }),
    openTab: async (input: OpenTabInput) =>
      okResult("open_tab", {
        tabId: makeChromiumTabId(spec.browser, 9999),
        ...(input.windowId ? { windowId: input.windowId } : {}),
        index: 3,
      }),
    moveTab: async (input: MoveTabInput) =>
      okResult("move_tab", {
        tabId: input.tabId,
        ...(input.targetWindowId ? { windowId: input.targetWindowId } : {}),
        index: input.targetIndex ?? 0,
      }),
  };
}
