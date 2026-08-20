/**
 * Entering move mode with `m` — the interaction no test ever performed.
 *
 * The guard "no other window in this browser to move to" (shipped in #45)
 * consulted `moveTargets` BEFORE calling setMode, but the memo early-returned
 * [] whenever mode wasn't already "move" — so the guard refused
 * unconditionally and move mode was unreachable from the TUI for every
 * multi-window session. Found by a live key-by-key feature drive, not by CI:
 * the existing render tests never pressed a key.
 *
 * Two pins: with a second window, `m` on a tab must ENTER move mode; with a
 * single window, `m` must refuse with the message (the guard's real job).
 */

import type { Snapshot } from "@george43g/shared-types";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ windowCount: 2 }));

function makeWindow(n: number) {
  return {
    windowId: `w:chrome:x${n}`,
    cgWindowId: 100 + n,
    title: `Window ${n}`,
    bounds: { x: 0, y: 0, w: 100, h: 100 },
    focused: n === 1,
    incognito: false,
    activeTabIndex: 0,
    state: "normal",
    tabCount: 2,
    tabs: Array.from({ length: 2 }, (_, i) => ({
      tabId: `t:chrome:x${n}${i}`,
      index: i,
      url: `https://example.com/${n}/${i}`,
      title: `W${n} Tab ${i}`,
      active: i === 0,
    })),
  };
}

function makeSnapshot(): Snapshot {
  return {
    version: 2,
    generatedAt: 1,
    source: "daemon",
    focusedBrowser: "chrome",
    browsers: [
      {
        browser: "chrome",
        bundleId: "com.google.Chrome",
        pid: 1,
        running: true,
        extensionConnected: true,
        dataSource: "extension",
        tabGroups: [],
        windows: Array.from({ length: state.windowCount }, (_, i) => makeWindow(i + 1)),
      },
    ],
  } as unknown as Snapshot;
}

vi.mock("./useSnapshot.js", () => ({
  useSnapshot: () => ({ snapshot: makeSnapshot(), live: true, refresh: () => {} }),
}));

const { App } = await import("./App.js");
const { ThemeProvider } = await import("@george43g/tui-kit");

const tick = () => new Promise((r) => setTimeout(r, 0));

async function renderApp() {
  const inst = render(
    <ThemeProvider preset="safe" accent="#1982FC">
      <App />
    </ThemeProvider>,
  );
  await tick();
  return inst;
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("move mode entry", () => {
  it("m on a tab enters move mode when another window exists", async () => {
    state.windowCount = 2;
    const inst = await renderApp();
    cleanup = inst.unmount;
    // rows: browser(0) → window1(1) → tab(2); land on the first tab, then m.
    inst.stdin.write("j");
    inst.stdin.write("j");
    await tick();
    inst.stdin.write("m");
    await tick();
    const frame = inst.lastFrame() ?? "";
    expect(frame).not.toContain("no other window in this browser to move to");
    expect(frame).toContain("[move]");
    expect(frame).toContain("◀ move here");
  });

  it("m still refuses, with the message, when the tab's window is the only one", async () => {
    state.windowCount = 1;
    const inst = await renderApp();
    cleanup = inst.unmount;
    inst.stdin.write("j");
    inst.stdin.write("j");
    await tick();
    inst.stdin.write("m");
    await tick();
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("no other window in this browser to move to");
    expect(frame).not.toContain("[move]");
  });
});
