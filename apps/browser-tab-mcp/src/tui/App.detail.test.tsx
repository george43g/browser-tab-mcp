/**
 * Sticky detail pane (Task 9) — `allocateWidths` negotiation between the
 * list and a detail column that shows the CURSOR row's full information.
 *
 * The design (tui-kit's width-alloc.d.ts, quoted in App.tsx): the detail
 * pane is ELABORATION, so it DROPS below its width floor rather than
 * squeezing — the list is "min" (never disappears, it IS the thing being
 * browsed) and the pane is "drop" (every field it shows already has a
 * truncated cousin in the list row).
 *
 * Real allocateWidths sheds purely on the two columns' `min` floors
 * (44 + 28 = 72), so the pane is present exactly when `usableCols` (==
 * `termColumns - 2`, the row container's own paddingX={1} budget) is >= 72
 * — i.e. terminal columns >= 74. 160 sits comfortably above that line; 70
 * (usableCols 68) sits comfortably below it, so neither geometry is a
 * boundary case that could flip on an off-by-one in the allocator.
 */

// The cursor row's highlight AND the pane separator's dim color are both
// ANSI-only signals (`backgroundColor`/`dimColor` via ink/chalk).
// ink-testing-library's fake stdout isn't a TTY, so chalk's default
// singleton resolves color level 0 and strips all color — set BEFORE
// ink/chalk are ever imported, same reasoning as every sibling in this
// directory (see App.halfpage.test.tsx's note). `render`/`App`/`ThemeProvider`
// are therefore dynamic imports below, not static ones.
process.env.FORCE_COLOR = "3";

import type { Snapshot } from "@george43g/shared-types";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Strip REAL SGR/ANSI escapes so width/content checks measure printed cells. */
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string) => s.replace(ANSI, "");

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
            tabCount: 2,
            tabs: [
              {
                tabId: "t:chrome:x0",
                index: 0,
                url: "https://example.com/detail-check",
                title: "Detail Check Tab",
                active: true,
                pinned: true,
              },
              {
                tabId: "t:chrome:x1",
                index: 1,
                url: "https://example.com/other",
                title: "Other Tab",
                active: false,
              },
            ],
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

/** Render at an exact terminal geometry, land the cursor on the first tab row
 * (rows: browser(0) → window(1) → tab0(2)), and return the settled frame. */
async function renderAt(columns: number, rows: number) {
  const inst = render(
    <ThemeProvider preset="safe" accent="#1982FC">
      <App />
    </ThemeProvider>,
  );
  // ink-testing-library's fake stdout has a getter-only `columns` (always
  // 100) and no `rows` at all; both are configurable, and it's an
  // EventEmitter, so redefining them and emitting "resize" drives
  // useTerminalSize exactly as a real SIGWINCH would.
  Object.defineProperty(inst.stdout, "columns", { value: columns, configurable: true });
  Object.defineProperty(inst.stdout, "rows", { value: rows, configurable: true });
  inst.stdout.emit("resize");
  await tick();
  inst.stdin.write("j");
  await tick();
  inst.stdin.write("j");
  await tick();
  const lines = (inst.lastFrame() ?? "").split("\n");
  return { lines, unmount: inst.unmount };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

// Geometry renders — a full Ink mount + resize + two keypresses + unmount per
// call. Comfortably fast on a warm laptop but over vitest's 5s default on a
// cold, shared Windows runner (see App.width.test.tsx's identical note).
const SLOW_RENDER_MS = 30_000;

describe("sticky detail pane", () => {
  it(
    "present when wide (with the current tab's url), dropped when narrow (list takes the freed width)",
    async () => {
      const wide = await renderAt(160, 30);
      cleanup = wide.unmount;
      const wideText = wide.lines.map(strip).join("\n");
      expect(wideText).toContain("┃"); // pane separator glyph
      expect(wide.lines.every((l) => visualWidth(strip(l)) <= 160)).toBe(true);
      // The cursor is on the first tab (pinned) — its full url, which the
      // list row itself would truncate, must appear verbatim in the pane.
      expect(wideText).toContain("https://example.com/detail-check");
      // Never taller than the terminal — a pane must never add lines.
      expect(wide.lines.length).toBeLessThanOrEqual(30);
      wide.unmount();

      const narrow = await renderAt(70, 30);
      cleanup = narrow.unmount;
      const narrowText = narrow.lines.map(strip).join("\n");
      expect(narrowText).not.toContain("┃"); // dropped entirely, no breadcrumb
      expect(narrow.lines.length).toBeLessThanOrEqual(30);
      // The list absorbs the freed width: usableCols = max(20, 70-2) = 68,
      // and the row container's own paddingX={1} puts one blank column
      // ahead of every row's content — so a full-width row's stripped line
      // is 69 cells (measured; see the allocateWidths growth-cap note in
      // App.tsx for why the list gets ALL of it, not just its floor of 44).
      const usableCols = Math.max(20, 70 - 2);
      const rowLine = narrow.lines.map(strip).find((l) => l.includes("Detail Check Tab"));
      expect(rowLine, "expected the cursor's tab row in the narrow frame").toBeDefined();
      expect(visualWidth(rowLine ?? "")).toBe(usableCols + 1);
    },
    SLOW_RENDER_MS,
  );
});
