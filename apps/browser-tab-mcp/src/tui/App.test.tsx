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

// The scrollbar thumb/track are distinguished from the row's own text ONLY by
// an ANSI color wrapper (thumb accent vs track dim, composed as a SIBLING
// `<Text>` outside the row's own color wrapper — see App.tsx). Under color
// level 0 (`ink-testing-library`'s fake stdout default, an untouched
// non-TTY), chalk strips all color, so the glyph still prints but with no
// escape bytes around it — a strip() regex could be flat wrong and every
// assertion below would still pass, for the wrong reason. FORCE_COLOR must be
// set BEFORE ink/chalk are ever imported: chalk's level is resolved once at
// module-evaluation time, and native ESM `import` statements are hoisted
// above any statement in the importing module regardless of textual
// position — so a static `import "ink-testing-library"` anywhere in this
// file would already have chalk cached before this line ran (verified
// empirically in App.halfpage.test.tsx). `render` is therefore a dynamic
// import too, alongside `App`/`ThemeProvider` below.
process.env.FORCE_COLOR = "3";

import type { Snapshot } from "@george43g/shared-types";
import { afterEach, describe, expect, it, vi } from "vitest";

const TAB_COUNT = 30;

/**
 * Strip REAL SGR/ANSI escapes — `\x1b[` + digits/semicolons + `m` — so
 * glyph/width checks measure the printed cell, not escape bytes. The ESC
 * byte (`\x1b`) is part of the sequence; a regex missing it (`/\[[0-9;]*m/`)
 * only matches a literal `[...m` substring that never occurs in real ANSI
 * output, so it is a no-op strip — harmless under color level 0 (nothing to
 * strip either way) but silently wrong the moment real color is on.
 */
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string) => s.replace(ANSI, "");

// Mutable so a single test can flip the tab count between an overflowing and
// a fitting fixture without a second render module — see the scrollbar test
// below, which needs both within one `it`.
const state = vi.hoisted(() => ({ tabsPerWindow: 30 }));

/** One browser, one window, `state.tabsPerWindow` tabs → 2 + tabsPerWindow rows. */
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
            tabCount: state.tabsPerWindow,
            tabs: Array.from({ length: state.tabsPerWindow }, (_, i) => ({
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

const { render } = await import("ink-testing-library");
const { App } = await import("./App.js");
const { ThemeProvider, visualWidth } = await import("@george43g/tui-kit");

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Render at a given terminal geometry and return the settled frame's lines. */
async function renderAt(
  columns: number,
  rows: number,
): Promise<{ lines: string[]; unmount: () => void }> {
  const inst = render(
    <ThemeProvider preset="safe" accent="#1982FC">
      <App />
    </ThemeProvider>,
  );
  // ink-testing-library's fake stdout has getter-only `columns` and no `rows`
  // at all; both are configurable, and it's an EventEmitter, so redefining
  // them and emitting "resize" drives useTerminalSize exactly as a real
  // SIGWINCH would. The re-render is async, so settle before reading the
  // frame.
  Object.defineProperty(inst.stdout, "columns", { value: columns, configurable: true });
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
  state.tabsPerWindow = TAB_COUNT;
});

describe("App viewport", () => {
  it("never renders more lines than the terminal has", async () => {
    for (const rows of [50, 24, 20, 12]) {
      const { lines, unmount } = await renderAt(100, rows);
      expect(lines.length, `terminal height ${rows}`).toBeLessThanOrEqual(rows);
      unmount();
    }
  });

  it("fills a tall terminal rather than stopping at 24", async () => {
    const { lines, unmount } = await renderAt(100, 50);
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
    const { lines, unmount } = await renderAt(100, 20);
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
    const short = await renderAt(100, 20);
    const shortCount = short.lines.filter((l) => /Tab \d+/.test(l)).length;
    short.unmount();
    const tall = await renderAt(100, 50);
    const tallCount = tall.lines.filter((l) => /Tab \d+/.test(l)).length;
    tall.unmount();
    expect(shortCount).toBeLessThan(tallCount);
    expect(shortCount).toBeGreaterThan(0);
  });
});

describe("scrollbar", () => {
  it("shows a scrollbar thumb when rows exceed the viewport, none when they fit", async () => {
    state.tabsPerWindow = 40; // overflow the 24-row terminal (viewport 20 < 42 rows)
    const overflow = await renderAt(100, 24);
    overflow.unmount();
    expect(overflow.lines.some((l) => strip(l).endsWith("█"))).toBe(true);

    state.tabsPerWindow = 2; // fits (viewport 20 >= 4 rows)
    const fit = await renderAt(100, 24);
    fit.unmount();
    expect(fit.lines.some((l) => strip(l).includes("█"))).toBe(false);
  });

  it("keeps every printed line at exactly the terminal width when the bar is showing", async () => {
    state.tabsPerWindow = 40;
    const { lines, unmount } = await renderAt(100, 24);
    cleanup = unmount;
    for (const line of lines) {
      expect(visualWidth(strip(line)), JSON.stringify(line)).toBeLessThanOrEqual(100);
    }
  });
});

describe("dev stats panel", () => {
  it("joins the width negotiation instead of squeezing to zero — d at 200x30", async () => {
    // Before this fix the stats Box had no width reservation of its own
    // (default flexShrink, no explicit width) and shared the SAME
    // negotiation as list/detail without ever entering it — it just lost
    // every squeeze to their fixed widths and collapsed toward zero, at
    // which point its own text wrapped across as many rows as it had
    // characters, ballooning this row's height and pushing the status/help
    // bars off-screen. `renderAt` doesn't expose `stdin`, so this test
    // drives the render directly rather than through that helper.
    const inst = render(
      <ThemeProvider preset="safe" accent="#1982FC">
        <App />
      </ThemeProvider>,
    );
    cleanup = inst.unmount;
    Object.defineProperty(inst.stdout, "columns", { value: 200, configurable: true });
    Object.defineProperty(inst.stdout, "rows", { value: 30, configurable: true });
    inst.stdout.emit("resize");
    await tick();
    inst.stdin.write("d");
    await tick();
    const frame = inst.lastFrame() ?? "";
    const lines = frame.split("\n");

    // (a) stats content is actually present — "dev stats"/"pid"/"rss" are
    // stable labels straight from tui-kit's DevStatsPanel (see its source
    // under node_modules), not fixture- or theme-dependent values.
    expect(frame, "dev stats panel missing").toContain("dev stats");
    expect(frame, "pid line missing").toMatch(/pid \d+/);
    expect(frame, "rss line missing").toContain("rss");

    // (b) the frame still fits the terminal — the help bar must not be
    // displaced.
    expect(lines.length, "frame rows").toBeLessThanOrEqual(30);
    expect(frame, "help bar missing (displaced?)").toContain("quit");

    // (c) no printed line exceeds the terminal width.
    for (const line of lines) {
      expect(visualWidth(strip(line)), JSON.stringify(line)).toBeLessThanOrEqual(200);
    }
  });
});
