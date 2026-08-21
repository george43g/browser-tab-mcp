/**
 * Cursor state ported onto tui-kit's `navReduce` (Task 7).
 *
 * Two behavior-delta pins, both intended by the port:
 *
 *  - cursor↔action agreement: the row Enter acts on must be the row the
 *    highlight showed. No prior test asserted this — the blast radius of
 *    getting the port wrong is acting on a DIFFERENT row than the one
 *    highlighted on screen (e.g. `x`/Enter on the wrong tab).
 *  - cursor-follows-row: when the snapshot's shape changes (a window opens
 *    ABOVE the cursor), the highlight must stay on the same TAB, not on
 *    whatever row now happens to sit at the old numeric index.
 */

// The cursor row is distinguished from every other row ONLY by an ANSI
// background-color escape (`backgroundColor={theme.palette.accent}`, via
// ink/chalk). ink-testing-library's fake stdout isn't a TTY, so chalk's
// default singleton resolves color level 0 and strips all color — a
// `highlightedRow` lookup would find nothing whether or not the port is
// correct. FORCE_COLOR must be set BEFORE ink/chalk are ever imported: their
// level is resolved once at module-evaluation time, and native ESM `import`
// statements are hoisted above any statement in the importing module
// regardless of textual position — so a static `import "ink-testing-library"`
// anywhere in this file would already have chalk cached before this line
// ran (verified empirically in App.halfpage.test.tsx). `render` is therefore
// a dynamic import too, alongside `App`/`ThemeProvider` below.
process.env.FORCE_COLOR = "3";

import type { CommandResult, Snapshot } from "@george43g/shared-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as tabsService from "../client/tabs-service.js";

const state = vi.hoisted(() => ({ extraWindow: false }));

function makeMainWindow() {
  return {
    windowId: "w:chrome:x1",
    cgWindowId: 111,
    title: "Main Window",
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
        url: "https://example.com/0",
        title: "Tab 0",
        active: true,
      },
      {
        tabId: "t:chrome:x1",
        index: 1,
        url: "https://example.com/1",
        title: "target-tab",
        active: false,
      },
    ],
  };
}

function makeExtraWindow() {
  return {
    windowId: "w:chrome:x2",
    cgWindowId: 222,
    title: "Extra Window",
    bounds: { x: 0, y: 0, w: 100, h: 100 },
    focused: false,
    incognito: false,
    activeTabIndex: 0,
    state: "normal",
    tabCount: 1,
    tabs: [
      {
        tabId: "t:chrome:x9",
        index: 0,
        url: "https://example.com/9",
        title: "Extra Tab",
        active: true,
      },
    ],
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
        // The extra window is inserted FIRST — "a window opens ABOVE the
        // cursor" — so target-tab's numeric row index shifts down when it
        // flips on, while its `key` (tabId) stays the same.
        windows: state.extraWindow ? [makeExtraWindow(), makeMainWindow()] : [makeMainWindow()],
      },
    ],
  } as unknown as Snapshot;
}

vi.mock("./useSnapshot.js", () => ({
  useSnapshot: () => ({ snapshot: makeSnapshot(), live: true, refresh: () => {} }),
}));

const { render } = await import("ink-testing-library");
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

// The cursor row is painted with an ANSI background-color escape
// (`backgroundColor={theme.palette.accent}`); no other row in browse mode
// carries one. FORCE_COLOR must be set before ink/chalk are ever imported —
// see App.halfpage.test.tsx's note — hence the dynamic imports above.
const ANSI = /\x1b\[[0-9;]*m/g;
const BG_ANSI = /\x1b\[48;/;

/** The single row currently painted with the cursor's background highlight. */
function highlightedRow(inst: { lastFrame: () => string | undefined }): string {
  const frame = inst.lastFrame() ?? "";
  const line = frame.split("\n").find((l) => BG_ANSI.test(l)) ?? "";
  return line.replace(ANSI, "");
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.restoreAllMocks();
  state.extraWindow = false;
});

describe("cursor ↔ action agreement", () => {
  it("Enter acts on the row the highlight shows", async () => {
    state.extraWindow = false;
    const focusSpy = vi.spyOn(tabsService, "focusTab").mockImplementation(
      async (input): Promise<CommandResult> => ({
        ok: true,
        command: "focus_tab",
        browser: "chrome",
        tabId: input.tabId,
      }),
    );
    const inst = await renderApp();
    cleanup = inst.unmount;
    // rows: browser(0) → window(1) → tab0(2) → tab1(3); land on tab0 (row 2).
    inst.stdin.write("j");
    await tick();
    inst.stdin.write("j");
    await tick();
    expect(highlightedRow(inst)).toContain("Tab 0");
    inst.stdin.write("\r");
    await tick();
    expect(focusSpy).toHaveBeenCalledTimes(1);
    // The tab the ACTION landed on must be the tab the HIGHLIGHT showed.
    expect(focusSpy.mock.calls[0]?.[0]?.tabId).toBe("t:chrome:x0");
  });
});

describe("cursor follows its row across a snapshot shape change", () => {
  it("stays on the same tab when a window opens ABOVE the cursor", async () => {
    state.extraWindow = false;
    const inst = await renderApp();
    cleanup = inst.unmount;
    // rows: browser(0) → window(1) → tab0(2) → target-tab(3); seek to it.
    inst.stdin.write("j");
    await tick();
    inst.stdin.write("j");
    await tick();
    inst.stdin.write("j");
    await tick();
    expect(highlightedRow(inst)).toContain("target-tab");

    // A window opens ABOVE the cursor: target-tab's numeric row index moves
    // from 3 to 5, but its key (tabId) is unchanged. "r" is the cheapest way
    // to force App to re-render off the now-updated fixture (its handler
    // calls setMessage, which is a real state change) — the mocked
    // useSnapshot() has no push mechanism of its own.
    state.extraWindow = true;
    inst.stdin.write("r");
    await tick();

    expect(highlightedRow(inst)).toContain("target-tab");
  });
});
