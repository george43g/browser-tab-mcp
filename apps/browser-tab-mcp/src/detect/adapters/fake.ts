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
  CloseWindowInput,
  CommandResult,
  MoveTabInput,
  OpenTabInput,
  OpenWindowInput,
  SetWindowInput,
  TabActionInput,
} from "@george43g/shared-types";
import { makeChromiumTabId, makeSafariTabId, makeWindowId } from "../ids.js";
import type { AdapterSpec, BrowserAdapter } from "./types.js";

const FAKE_BUNDLES: Record<BrowserId, string> = {
  chrome: "com.google.Chrome",
  brave: "com.brave.Browser",
  chromium: "org.chromium.Chromium",
  edge: "com.microsoft.edgemac",
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

/**
 * Titles long enough to reach a width budget, because the short ones above
 * cannot.
 *
 * The TUI overflow bug (#45) survived a green suite precisely because every
 * fixture title fit: rows were composed from ~122 columns of fixed slice
 * budgets, but no fixture ever produced a row that long, so nothing wrapped
 * and nothing failed. A stress harness that renders "Inbox (3) - Gmail" is
 * measuring the fixture, not the layout. These are real titles and URLs from
 * this machine; emoji are included because they are where display width and
 * `.length` disagree.
 */
const LONG_TITLES = [
  "KFD 240W USB-C GaN Adapter 48V 5A NVIDIA DGX Spark \u{1F3B5}",
  "fastify/fastify: Fast and low overhead web framework, for Node.js",
  "Generate Music for Any Video with AI, Instant Video to Music Matching",
  "\u{2705}Claude \u2014 browser-tab-mcp \u2014 stress",
  "Posts matching '' - Stack Overflow",
];

/**
 * Opt-in scaling for the stress harness: `BROWSER_TAB_FAKE_SCALE` windows per
 * browser, `BROWSER_TAB_FAKE_TABS` tabs each, with realistic titles.
 *
 * Off by default (scale 0), and when off the seeds above are returned
 * byte-identical — every existing fixture assertion is untouched. This exists
 * so the TUI harness can render at a scale and content length that can
 * actually break, without a real browser.
 */
function scaledSeeds(browser: BrowserId, base: FakeTabSeed[][]): FakeTabSeed[][] {
  const windows = Number(process.env.BROWSER_TAB_FAKE_SCALE ?? 0);
  if (!Number.isFinite(windows) || windows <= 0) return base;
  const tabs = Math.max(1, Number(process.env.BROWSER_TAB_FAKE_TABS ?? 40));
  return Array.from({ length: Math.floor(windows) }, (_, w) =>
    Array.from({ length: tabs }, (_, t) => ({
      url: `https://www.google.com/search?q=240w+usb+c+power+adapter&oq=thunderbolt+${browser}+${w}+${t}`,
      title: `${LONG_TITLES[(w + t) % LONG_TITLES.length]} \u2014 ${t}`,
    })),
  );
}

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
      scaledSeeds(spec.browser, spec.browser === "safari" ? SAFARI_WINDOWS : CHROMIUM_WINDOWS),
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
    // Models the AppleScript pathway's post-state: the fixture windows are
    // never minimized, so raising is what changes `windowFocused`.
    focusTab: async (tabId, opts) =>
      okResult("focus_tab", {
        tabId,
        wasMinimized: false,
        windowState: "normal",
        windowFocused: opts?.raiseWindow !== false,
      }),
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
    // Model the AppleScript action boundary so degradation stays testable:
    // navigate/reload everywhere, back/forward on Chromium only.
    tabAction: async (input: TabActionInput) => {
      const applescriptable =
        input.action === "navigate" ||
        input.action === "reload" ||
        ((input.action === "back" || input.action === "forward") && spec.browser !== "safari");
      if (!applescriptable) {
        throw new Error(
          `Action "${input.action}" isn't available for ${spec.browser} via AppleScript — needs the extension.`,
        );
      }
      return okResult("tab_action", { tabId: input.tabId, payload: { action: input.action } });
    },
    openWindow: async (input: OpenWindowInput) => {
      if (input.state === "maximized" || input.state === "fullscreen") {
        throw new Error(`Window state "${input.state}" isn't settable via AppleScript.`);
      }
      if (input.incognito && spec.browser === "safari") {
        throw new Error("Safari private windows can't be created via AppleScript.");
      }
      return okResult("open_window", {
        windowId: makeWindowId(spec.browser, 500),
        payload: { tabCount: input.urls.length },
      });
    },
    setWindow: async (input: SetWindowInput) => {
      if (input.state === "maximized" || input.state === "fullscreen") {
        throw new Error(`Window state "${input.state}" isn't settable via AppleScript.`);
      }
      return okResult("set_window", { windowId: input.windowId });
    },
    closeWindow: async (input: CloseWindowInput) =>
      okResult("close_window", { windowId: input.windowId }),
  };
}
