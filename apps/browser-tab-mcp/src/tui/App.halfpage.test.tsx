/**
 * Half-page motions (`^d`/`^u`) — three defects in one handler pair
 * (App.tsx:125-126, pre-fix): they didn't clear a stale status `message`
 * despite the onMove comment claiming "Any motion retires…"; they lacked
 * the `mode.kind` branch, so `^d`/`^u` moved the hidden browse cursor while
 * the user steered a modal (move/action) list; and `onHalfPageUp` clamped
 * differently from the other three motion handlers (onMove/onTop/onBottom).
 *
 * Both pins here are the regression guard Task 7's `navReduce` port must
 * keep passing.
 */

// The second pin below can only fail for the right reason under real color
// output: the browse-mode cursor and the move-mode target are rendered
// identically in TEXT (both are just a row string) — the only signal that
// distinguishes "cursor is on row N" is an ANSI background-color wrapper
// (`ink`'s `colorize()`, via `chalk`). `ink-testing-library`'s fake stdout
// isn't a TTY, so `chalk`'s default singleton resolves color level 0 and
// silently strips all color — a `lastFrame()` diff would pass whether or
// not the defect were fixed (verified: the un-fixed handler produced a
// byte-identical frame under this test's default settings, a false GREEN).
// FORCE_COLOR must be set BEFORE `ink`/`chalk` are ever imported: chalk's
// level is resolved once at module-evaluation time, and native ESM `import`
// statements are hoisted above any statement in the importing module
// regardless of textual position — so a static `import "ink-testing-library"`
// anywhere in this file would already have chalk cached before this line
// ran (verified empirically). `render` is therefore a dynamic import too,
// alongside `App`/`ThemeProvider` below, so it evaluates after this executes.
process.env.FORCE_COLOR = "3";

import type { Snapshot } from "@george43g/shared-types";
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

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("half-page motions", () => {
  it("^d retires a stale status message like j/k do", async () => {
    state.windowCount = 2;
    const inst = await renderApp();
    cleanup = inst.unmount;
    inst.stdin.write("r");
    await tick(); // sets "refreshed"
    expect(inst.lastFrame()).toContain("refreshed");
    inst.stdin.write("\x04");
    await tick(); // ctrl+d
    expect(inst.lastFrame()).not.toContain("refreshed");
    expect(inst.lastFrame()).toMatch(/\d+ rows ·/); // fell back to the live indicator
  });

  it("^d in move mode does not move the hidden browse cursor", async () => {
    state.windowCount = 2;
    const inst = await renderApp();
    cleanup = inst.unmount;
    // rows: browser(0) → window1(1) → tab(2); land on the first tab, then m.
    inst.stdin.write("j");
    await tick();
    inst.stdin.write("j");
    await tick();
    inst.stdin.write("m");
    await tick(); // enter move mode (fixture: 2 windows)
    const before = inst.lastFrame();
    inst.stdin.write("\x04");
    await tick();
    expect(inst.lastFrame()).toBe(before); // byte-identical frame: nothing moved
  });

  // Same defect class as ^d above, mirrored onto onTop/onBottom: `gg`/`G`
  // steer the hidden browse cursor unless they're guarded behind
  // `mode.kind !== "browse"` too. Copies the ^d-in-move-mode test's shape.
  it("G in move mode does not move the hidden browse cursor", async () => {
    state.windowCount = 2;
    const inst = await renderApp();
    cleanup = inst.unmount;
    // rows: browser(0) → window1(1) → tab(2); land on the first tab, then m.
    inst.stdin.write("j");
    await tick();
    inst.stdin.write("j");
    await tick();
    inst.stdin.write("m");
    await tick(); // enter move mode (fixture: 2 windows)
    const before = inst.lastFrame();
    inst.stdin.write("G");
    await tick();
    expect(inst.lastFrame()).toBe(before); // byte-identical frame: nothing moved
  });
});

describe("message hygiene", () => {
  it("entering confirm-close retires the stale message (no resurface on exit)", async () => {
    state.windowCount = 2;
    const inst = await renderApp();
    cleanup = inst.unmount;
    inst.stdin.write("r");
    await tick(); // sets "refreshed"
    expect(inst.lastFrame()).toContain("refreshed");
    // seekToTabRow: rows: browser(0) → window1(1) → tab(2)
    inst.stdin.write("j");
    await tick();
    inst.stdin.write("j");
    await tick();
    // Re-set message to simulate a stale message that survives navigation
    // (e.g., from an earlier command that completed). The j/k handlers clear
    // messages, but entering confirm-close should ALSO clear it so it doesn't
    // resurface on exit.
    inst.stdin.write("r");
    await tick(); // sets "refreshed" again
    expect(inst.lastFrame()).toContain("refreshed");
    inst.stdin.write("x");
    await tick();
    expect(inst.lastFrame()).toContain("press y to confirm");
    inst.stdin.write("n");
    await tick(); // any non-y exits
    expect(inst.lastFrame()).not.toContain("refreshed");
  });
});
