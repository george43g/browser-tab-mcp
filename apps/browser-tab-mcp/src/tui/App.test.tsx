/**
 * TUI render guards — the layer that had ZERO render coverage, which is
 * exactly why a hardcoded `VIEWPORT = 24` shipped.
 *
 * These assert against the real rendered frame at several terminal heights.
 * The two failures they pin were both measured live in a tmux pane:
 *   - 50 rows rendered 24 and left 22 blank;
 *   - 20 rows overflowed, overprinting rows and destroying the status bar.
 *
 * `useSnapshot` is mocked so the tree never touches a socket — this is a
 * layout test, and the feed has its own coverage.
 */

import type { Snapshot } from "@george43g/shared-types";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

const TAB_COUNT = 30;

/** One browser, one window, TAB_COUNT tabs → 2 + TAB_COUNT rows. */
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
        windows: [
          {
            windowId: "w:chrome:x1",
            cgWindowId: 111,
            title: "Window One",
            bounds: { x: 0, y: 0, w: 100, h: 100 },
            focused: true,
            incognito: false,
            activeTabIndex: 0,
            state: "normal",
            tabCount: TAB_COUNT,
            tabs: Array.from({ length: TAB_COUNT }, (_, i) => ({
              tabId: `t:chrome:x${i}`,
              index: i,
              url: `https://example.com/${i}`,
              title: `Tab ${i}`,
              active: i === 0,
            })),
          },
        ],
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

/** Render at a given terminal height and return the settled frame's lines. */
async function renderAt(rows: number): Promise<{ lines: string[]; unmount: () => void }> {
  const inst = render(
    <ThemeProvider preset="safe" accent="#1982FC">
      <App />
    </ThemeProvider>,
  );
  // ink-testing-library's fake stdout has a getter-only `columns` and no `rows`
  // at all; it is an EventEmitter, so defining `rows` and emitting `resize`
  // drives useTerminalSize exactly as a real SIGWINCH would. The re-render is
  // async, so settle before reading the frame.
  Object.defineProperty(inst.stdout, "rows", { value: rows, configurable: true });
  inst.stdout.emit("resize");
  await tick();
  const frame = inst.lastFrame() ?? "";
  return { lines: frame.split("\n"), unmount: inst.unmount };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("App viewport", () => {
  it("never renders more lines than the terminal has", async () => {
    for (const rows of [50, 24, 20, 12]) {
      const { lines, unmount } = await renderAt(rows);
      expect(lines.length, `terminal height ${rows}`).toBeLessThanOrEqual(rows);
      unmount();
    }
  });

  it("fills a tall terminal rather than stopping at 24", async () => {
    const { lines, unmount } = await renderAt(50);
    cleanup = unmount;
    const tabLines = lines.filter((l) => /Tab \d+/.test(l));
    // 30 tabs + 2 header rows all fit in 46 usable rows, so every tab shows.
    // The old hardcoded 24 could only ever show 22 of them.
    expect(tabLines.length).toBe(TAB_COUNT);
  });

  it("still renders both chrome bars on a SHORT terminal", async () => {
    // NOTE: this is a smoke check, not the corruption guard. The live failure
    // (rows overprinting each other, the status bar bleeding into the help bar)
    // is a TERMINAL artifact of writing more lines than the screen has, and
    // ink-testing-library captures a frame string, so it cannot reproduce it —
    // verified by sabotage: this test passes even with the viewport and the
    // overflow clip both reverted. The actual guard is
    // "never renders more lines than the terminal has" above, which catches the
    // root cause (asking for more lines than exist) and does fail under sabotage.
    const { lines, unmount } = await renderAt(20);
    cleanup = unmount;
    const frame = lines.join("\n");
    expect(frame, "status bar mode indicator missing").toContain("[browse]");
    expect(frame, "help bar missing").toContain("quit");
    // Chrome must occupy its own lines, not share one with a tab row.
    const statusLine = lines.find((l) => l.includes("[browse]")) ?? "";
    expect(statusLine, "status bar overprinted by a tab row").not.toMatch(/Tab \d+/);
    const helpLine = lines.find((l) => l.includes("quit")) ?? "";
    expect(helpLine, "help bar overprinted").not.toMatch(/https:\/\//);
  });

  it("shows fewer rows on a short terminal than a tall one", async () => {
    const short = await renderAt(20);
    const shortCount = short.lines.filter((l) => /Tab \d+/.test(l)).length;
    short.unmount();
    const tall = await renderAt(50);
    const tallCount = tall.lines.filter((l) => /Tab \d+/.test(l)).length;
    tall.unmount();
    expect(shortCount).toBeLessThan(tallCount);
    expect(shortCount).toBeGreaterThan(0);
  });
});
