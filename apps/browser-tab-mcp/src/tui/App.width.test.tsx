/**
 * TUI width guards — the corruption class `App.test.tsx` could not catch.
 *
 * That file varies HEIGHT only, and its fixture titles ("Tab 0",
 * "https://example.com/0") are too short to wrap at ink-testing-library's
 * default 100 columns. So the real failure shipped: rows were composed from
 * fixed `String.slice` budgets totalling ~122 columns before badges, never
 * clamped to the terminal, and never marked `wrap`. Ink then WORD-WRAPS an
 * over-long row onto 2+ lines — `overflow="hidden"` does not clip vertically —
 * so N rows became N+k printed lines, the frame scrolled, and the chrome was
 * overprinted. Measured live at 100x30: 66 lines emitted into a 40-row screen.
 *
 * The casualty is the status bar, which is where `close "…"? press y to
 * confirm` renders — so a user could sit in confirm-close mode with no visible
 * prompt, one keystroke from closing a real tab. Hence a guard, not a polish.
 *
 * Fixture content is deliberately REALISTIC: real tab titles and URLs on this
 * machine run 60-90 columns, and tab-group titles contain emoji.
 */

import type { Snapshot } from "@george43g/shared-types";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

const TAB_COUNT = 25;

/** Strip SGR/ANSI so width maths measures glyphs, not escape bytes. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI ESC is the point
const ANSI = /\[[0-9;]*m/g;
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
        tabGroups: [
          {
            groupId: "g:chrome:x77",
            windowId: "w:chrome:x1",
            title: "✅Claude",
            color: "blue",
            collapsed: false,
          },
        ],
        windows: [
          {
            windowId: "w:chrome:x1",
            cgWindowId: 111,
            title: "Generate Music for Any Video with AI, Instant Video to Music Matching",
            bounds: { x: 0, y: 0, w: 100, h: 100 },
            focused: true,
            incognito: false,
            activeTabIndex: 0,
            state: "normal",
            tabCount: TAB_COUNT,
            tabs: Array.from({ length: TAB_COUNT }, (_, i) => ({
              tabId: `t:chrome:x${i}`,
              index: i,
              url: `https://www.google.com/search?q=240w+usb+c+power+adapter&oq=thunderbolt+${i}`,
              title:
                i % 3 === 0
                  ? `KFD 240W USB-C GaN Adapter 48V 5A NVIDIA DGX Spark — row ${i} 🎵`
                  : `fastify/fastify: Fast and low overhead web framework, for Node.js — ${i}`,
              active: i === 0,
              pinned: i === 1,
              audible: i === 2,
              muted: i === 2,
              discarded: i % 4 === 0,
              frozen: false,
              ...(i % 5 === 0 ? { groupId: "g:chrome:x77" } : {}),
            })),
          },
          // A second window with a FAILED cgWindowId join — the wm-stack failure
          // mode, which must render as `cg:none` rather than as nothing.
          {
            windowId: "w:chrome:x2",
            cgWindowId: null,
            title: "os-fork control plane",
            bounds: null,
            focused: false,
            incognito: false,
            activeTabIndex: 0,
            state: "normal",
            tabCount: 1,
            tabs: [
              {
                tabId: "t:chrome:x900",
                index: 0,
                url: "http://127.0.0.1:7777/",
                title: "os-fork control plane",
                active: true,
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

const { App } = await import("./App.js");
const { ThemeProvider } = await import("@george43g/tui-kit");

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Render at an exact terminal geometry and return the settled frame's lines. */
async function renderAt(
  columns: number,
  rows: number,
): Promise<{ lines: string[]; unmount: () => void }> {
  const inst = render(
    <ThemeProvider preset="safe" accent="#1982FC">
      <App />
    </ThemeProvider>,
  );
  // The fake stdout declares `columns` as a getter and has no `rows`; both are
  // configurable, and it's an EventEmitter, so redefining + emitting "resize"
  // drives useTerminalSize exactly as a real SIGWINCH would.
  Object.defineProperty(inst.stdout, "columns", { value: columns, configurable: true });
  Object.defineProperty(inst.stdout, "rows", { value: rows, configurable: true });
  inst.stdout.emit("resize");
  await tick();
  return { lines: (inst.lastFrame() ?? "").split("\n"), unmount: inst.unmount };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("App width safety", () => {
  // 132 and above were already clean; everything below corrupted.
  const GEOMETRIES: [number, number][] = [
    [250, 50],
    [200, 50],
    [132, 40],
    [100, 30],
    [80, 24],
    [60, 20],
    [40, 12],
  ];

  it("never emits a line wider than the terminal", async () => {
    for (const [cols, rows] of GEOMETRIES) {
      const { lines, unmount } = await renderAt(cols, rows);
      const widest = Math.max(...lines.map((l) => strip(l).length));
      expect(widest, `geometry ${cols}x${rows}`).toBeLessThanOrEqual(cols);
      unmount();
    }
  });

  it("never emits more lines than the terminal has — the wrap-corruption guard", async () => {
    // This is the assertion that fails at 66-into-40 without the fix. Wrapping
    // inflates the LINE count, so a width bug presents as a height overflow.
    for (const [cols, rows] of GEOMETRIES) {
      const { lines, unmount } = await renderAt(cols, rows);
      expect(lines.length, `geometry ${cols}x${rows}`).toBeLessThanOrEqual(rows);
      unmount();
    }
  });

  it("keeps both chrome bars intact at a narrow width", async () => {
    const { lines, unmount } = await renderAt(100, 30);
    cleanup = unmount;
    const text = lines.map(strip).join("\n");
    // The help bar is the last casualty of an overflow; if it survives whole,
    // nothing overprinted it.
    expect(text).toContain("q quit");
    expect(text).toContain("j/k move");
  });

  it("marks a failed cgWindowId join as cg:none rather than rendering nothing", async () => {
    const { lines, unmount } = await renderAt(250, 50);
    cleanup = unmount;
    expect(lines.map(strip).join("\n")).toContain("cg:none");
  });

  it("does not split a surrogate pair when truncating an emoji title", async () => {
    // `String.slice` counts UTF-16 units, so a cut mid-emoji leaves a lone high
    // surrogate and paints a broken glyph. Every title here ends with 🎵 on the
    // rows that carry it, at a width that forces truncation.
    const { lines, unmount } = await renderAt(60, 20);
    cleanup = unmount;
    for (const line of lines) {
      for (const ch of strip(line)) {
        const code = ch.codePointAt(0) ?? 0;
        // A lone surrogate survives iteration only if it was never paired.
        expect(code >= 0xd800 && code <= 0xdfff, `lone surrogate in: ${JSON.stringify(line)}`).toBe(
          false,
        );
      }
    }
  });
});
