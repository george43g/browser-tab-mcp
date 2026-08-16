/**
 * Renderer unit tests — assertions are about CONTENT, so they run against
 * SGR-stripped output.
 *
 * This file used to say "`color` no-ops off-TTY and vitest has no TTY, so every
 * expectation is plain text". That was ambient luck, not a guarantee: cli-kit's
 * `colorEnabled()` also honours `FORCE_COLOR`, so anyone with that exported
 * (terminal multiplexers and CI wrappers set it routinely) got two red tests on
 * a clean checkout — which is how this was found. Stripping at the boundary
 * makes the suite deterministic *and* exercises the coloured path rather than
 * only the monochrome one.
 *
 * Width assertions must measure GLYPHS, not escape bytes: the renderer budgets
 * on plain text and colours fixed-size pieces afterwards, so a raw `.length`
 * over-counts and reports a false overflow.
 */

import { describe, expect, it } from "vitest";
import * as render from "./render.js";
import { clockOf, hostOf, layoutWidth, shortDuration, truncate } from "./render.js";

const SGR = /\u001b\[[0-9;]*m/g;

/** Strip SGR from a renderer's return value; non-strings (undefined) pass through. */
function plain<T>(value: T): T {
  return typeof value === "string" ? (value.replace(SGR, "") as T) : value;
}

const renderSnapshot = (...args: Parameters<typeof render.renderSnapshot>) =>
  plain(render.renderSnapshot(...args));
const renderJournal = (...args: Parameters<typeof render.renderJournal>) =>
  plain(render.renderJournal(...args));
const renderHistory = (...args: Parameters<typeof render.renderHistory>) =>
  plain(render.renderHistory(...args));
const renderDaemonStatus = (...args: Parameters<typeof render.renderDaemonStatus>) =>
  plain(render.renderDaemonStatus(...args));
const renderForTool = (...args: Parameters<typeof render.renderForTool>) =>
  plain(render.renderForTool(...args));

describe("helpers", () => {
  it("truncate collapses whitespace and marks elision", () => {
    expect(truncate("a  b\n c", 40)).toBe("a b c");
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
    expect(truncate("abc", 3)).toBe("abc");
  });

  it("hostOf falls back to the raw string for non-URLs", () => {
    expect(hostOf("https://example.com/a/b?c=1")).toBe("example.com");
    expect(hostOf("chrome://extensions")).toBe("extensions");
    expect(hostOf("not a url")).toBe("not a url");
  });

  it("clockOf pads and survives a non-finite timestamp", () => {
    expect(clockOf(Date.UTC(2020, 0, 1, 5, 6, 7), new Date(Date.UTC(2020, 0, 1, 5, 6, 7)))).toMatch(
      /^\d{2}:\d{2}:\d{2}$/,
    );
    expect(clockOf(Number.NaN)).toBe("--:--:--");
  });

  it("shortDuration scales by magnitude", () => {
    expect(shortDuration(45)).toBe("45s");
    expect(shortDuration(120)).toBe("2m");
    expect(shortDuration(3700)).toBe("1h1m");
    expect(shortDuration(90_000)).toBe("1d1h");
    expect(shortDuration(Number.NaN)).toBe("?");
  });

  it("layoutWidth clamps junk and extremes", () => {
    expect(layoutWidth(120)).toBe(120);
    expect(layoutWidth(10)).toBe(40);
    expect(layoutWidth(9999)).toBe(200);
    expect(layoutWidth(Number.NaN)).toBe(100);
    expect(layoutWidth(undefined as unknown as number)).toBe(100);
  });
});

const SNAP = {
  focusedBrowser: "chrome",
  browsers: [
    { browser: "brave", running: false, windows: [] },
    {
      browser: "chrome",
      running: true,
      dataSource: "extension",
      windows: [
        {
          windowId: "w:chrome:x1",
          cgWindowId: 71018,
          state: "normal",
          bounds: { x: 0, y: 0, w: 800, h: 600 },
          tabs: [
            { tabId: "t:chrome:x11", title: "First", url: "https://a.example/x", active: true },
            {
              tabId: "t:chrome:x12",
              title: "Second",
              url: "https://b.example/y",
              audible: true,
              pinned: true,
            },
          ],
        },
      ],
    },
  ],
};

describe("renderSnapshot", () => {
  it("renders a browser → window → tab tree with counts and the focus marker", () => {
    const out = renderSnapshot(SNAP);
    expect(out).toContain("chrome");
    expect(out).toContain("extension · 1 window · 2 tabs");
    expect(out).toContain("← focused");
    expect(out).toContain("w:chrome:x1");
    expect(out).toContain("cg:71018");
    expect(out).toContain("800×600");
    // Indentation carries the nesting: window deeper than browser, tab deeper still.
    const lines = out.split("\n");
    const win = lines.find((l) => l.includes("w:chrome:x1")) ?? "";
    const tab = lines.find((l) => l.includes("t:chrome:x11")) ?? "";
    expect(win.match(/^ */)?.[0].length).toBe(2);
    expect(tab.match(/^ */)?.[0].length).toBe(4);
  });

  it("marks the active tab and surfaces state badges", () => {
    const out = renderSnapshot(SNAP);
    const active = out.split("\n").find((l) => l.includes("t:chrome:x11")) ?? "";
    const other = out.split("\n").find((l) => l.includes("t:chrome:x12")) ?? "";
    expect(active).toContain("▸");
    expect(other).not.toContain("▸");
    expect(other).toContain("pinned");
    expect(other).toContain("audible");
  });

  it("says so when a browser is not running, rather than showing an empty tree", () => {
    expect(renderSnapshot(SNAP)).toContain("brave — not running");
  });

  it("flags a missing cgWindowId — that is the wm-stack join key", () => {
    const out = renderSnapshot({
      browsers: [
        {
          browser: "chrome",
          running: true,
          windows: [{ windowId: "w:chrome:x1", cgWindowId: null, tabs: [] }],
        },
      ],
    });
    expect(out).toContain("cg:none");
  });

  it("keeps every line inside the requested width", () => {
    const long = {
      browsers: [
        {
          browser: "chrome",
          running: true,
          windows: [
            {
              windowId: "w:chrome:x1",
              tabs: [{ tabId: "t:chrome:x11", title: "T".repeat(400), url: "https://a.example" }],
            },
          ],
        },
      ],
    };
    for (const line of renderSnapshot(long, 80).split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it("handles an empty snapshot", () => {
    expect(renderSnapshot({ browsers: [] })).toBe("No browsers reported.");
  });
});

describe("renderJournal / renderHistory", () => {
  it("renders journal records with clock, browser and kind", () => {
    const out = renderJournal({
      view: "recent",
      focus: [
        {
          ts: 1_700_000_000_000,
          browser: "chrome",
          kind: "tab-focus",
          title: "T",
          url: "https://e.x/1",
        },
      ],
    });
    expect(out).toContain("recent");
    expect(out).toContain("chrome");
    expect(out).toContain("tab-focus");
    expect(out).toContain("e.x");
  });

  it("says 'no records' instead of rendering an empty table", () => {
    expect(renderJournal({ view: "recent", focus: [] })).toContain("no records");
  });

  it("omits empty sections so the populated one is not buried", () => {
    const out = renderJournal({
      view: "recent",
      focus: [
        { ts: 1_700_000_000_000, browser: "chrome", kind: "tab-focus", url: "https://e.x/1" },
      ],
      nav: [],
    });
    expect(out).toContain("· focus ·");
    expect(out).not.toContain("· nav ·");
  });

  it("renders history rows and marks truncation and repeat visits", () => {
    const out = renderHistory({
      rows: [
        {
          url: "https://e.x/1",
          title: "One",
          visitTime: 1_700_000_000_000,
          visitCount: 3,
          browser: "chrome",
        },
      ],
      truncated: true,
    });
    expect(out).toContain("1 row");
    expect(out).toContain("(truncated)");
    expect(out).toContain("×3");
  });

  it("says 'no rows' for empty history", () => {
    expect(renderHistory({ rows: [] })).toContain("no rows");
  });
});

describe("renderDaemonStatus", () => {
  it("leads with reachability and shows the build stamp", () => {
    const out = renderDaemonStatus({
      reachable: true,
      pid: 42,
      uptimeS: 3700,
      build: "0.0.0+27.abc1234",
      socket: "/tmp/d.sock",
      contractVersion: 2,
      wsPort: 8790,
      pollMs: 5000,
      correlationTier: "native",
      extensionInfo: [{ browser: "chrome", extVersion: "0.2.0+27.abc1234" }],
    });
    expect(out).toContain("● running");
    expect(out).toContain("pid 42");
    expect(out).toContain("1h1m");
    expect(out).toContain("0.0.0+27.abc1234");
    expect(out).toContain("chrome 0.2.0+27.abc1234");
  });

  it("marks a stale extension and an unreachable daemon", () => {
    expect(renderDaemonStatus({ reachable: false })).toContain("not reachable");
    const stale = renderDaemonStatus({
      reachable: true,
      extensionInfo: [{ browser: "safari", extVersion: "0.1.0", stale: true }],
    });
    expect(stale).toContain("STALE");
  });

  it("says none connected rather than printing an empty list", () => {
    expect(renderDaemonStatus({ reachable: true })).toContain("none connected");
  });
});

describe("renderForTool", () => {
  it("dispatches by tool name", () => {
    expect(renderForTool("list_tabs", SNAP)).toContain("w:chrome:x1");
    expect(renderForTool("history", { rows: [] })).toContain("no rows");
  });

  it("returns undefined for a tool with no renderer, so callers fall back to JSON", () => {
    expect(renderForTool("focus_tab", { ok: true })).toBeUndefined();
    expect(renderForTool("list_tabs", null)).toBeUndefined();
    expect(renderForTool("list_tabs", "a string")).toBeUndefined();
  });
});
