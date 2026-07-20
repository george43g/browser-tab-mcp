/**
 * SourceMerger liveness tests — an extension feed must stay authoritative
 * while its socket is alive, even with no tab activity. The extension only
 * pushes on events, so the WS server calls touch() on every pong; these
 * tests pin that touch() keeps an idle feed fresh and that a feed with no
 * liveness ages out of the window back to AppleScript data.
 */

import type { BrowserState, Snapshot } from "@george43g/shared-types";
import { describe, expect, it } from "vitest";
import { SourceMerger } from "../src/daemon/merge.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function appleChrome(): BrowserState {
  return {
    browser: "chrome",
    bundleId: "com.google.Chrome",
    pid: 4242,
    running: true,
    extensionConnected: false,
    dataSource: "applescript",
    windows: [
      {
        windowId: "w:chrome:100",
        cgWindowId: null,
        title: "poll",
        bounds: { x: 0, y: 25, w: 1440, h: 875 },
        focused: true,
        incognito: false,
        activeTabIndex: 0,
        tabCount: 1,
        tabs: [
          {
            tabId: "t:chrome:101",
            index: 0,
            url: "https://poll.example/",
            title: "poll",
            active: true,
            pinned: false,
            audible: false,
            discarded: false,
          },
        ],
      },
    ],
  };
}

function extChrome(): BrowserState {
  return {
    browser: "chrome",
    bundleId: "com.google.Chrome",
    pid: null,
    running: true,
    extensionConnected: true,
    dataSource: "extension",
    windows: [
      {
        windowId: "w:chrome:x800",
        cgWindowId: null,
        title: "ext",
        bounds: { x: 0, y: 25, w: 1440, h: 875 },
        focused: true,
        incognito: false,
        activeTabIndex: 0,
        tabCount: 1,
        tabs: [
          {
            tabId: "t:chrome:x900",
            index: 0,
            url: "https://ext.example/",
            title: "ext",
            active: true,
            pinned: false,
            audible: false,
            discarded: false,
          },
        ],
      },
    ],
  };
}

function polled(): Snapshot {
  return {
    version: 1,
    generatedAt: Date.now(),
    source: "osascript-direct",
    browsers: [appleChrome()],
  };
}

const chromeOf = (s: Snapshot) => s.browsers.find((b) => b.browser === "chrome");

describe("SourceMerger liveness", () => {
  it("extension feed wins while fresh", async () => {
    const merger = new SourceMerger();
    merger.setExtensionState("chrome", extChrome());
    const merged = await merger.merge(polled(), 1_000);
    const chrome = chromeOf(merged);
    expect(chrome?.dataSource).toBe("extension");
    expect(chrome?.extensionConnected).toBe(true);
    expect(chrome?.windows[0]?.tabs[0]?.tabId).toBe("t:chrome:x900");
  });

  it("a feed with no liveness ages out back to AppleScript", async () => {
    const merger = new SourceMerger();
    merger.setExtensionState("chrome", extChrome());
    await sleep(30);
    const merged = await merger.merge(polled(), 10); // 30ms old, 10ms window
    const chrome = chromeOf(merged);
    expect(chrome?.dataSource).toBe("applescript");
    // Feed is still registered (socket alive), just not fresh enough to win.
    expect(chrome?.extensionConnected).toBe(true);
    expect(chrome?.windows[0]?.tabs[0]?.tabId).toBe("t:chrome:101");
  });

  it("touch() refreshes liveness so an idle-but-connected feed keeps winning", async () => {
    const merger = new SourceMerger();
    merger.setExtensionState("chrome", extChrome());
    await sleep(30);
    merger.touch("chrome"); // e.g. a pong arrived — no new snapshot, just liveness
    const merged = await merger.merge(polled(), 20); // set 30ms ago, touched ~0ms ago
    expect(chromeOf(merged)?.dataSource).toBe("extension");
  });

  it("clearExtension drops the feed entirely", async () => {
    const merger = new SourceMerger();
    merger.setExtensionState("chrome", extChrome());
    merger.clearExtension("chrome");
    const merged = await merger.merge(polled(), 1_000);
    const chrome = chromeOf(merged);
    expect(chrome?.dataSource).toBe("applescript");
    expect(chrome?.extensionConnected).toBe(false);
  });
});
