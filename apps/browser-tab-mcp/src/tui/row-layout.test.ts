/**
 * Property guard for `layoutRowText`: whatever the row kind, whatever the
 * title/url content, the composed string is EXACTLY `cols` cells —
 * `visualWidth(layoutRowText(row, opts)) === cols`, not `<=`.
 *
 * This is the postcondition `fitToWidth` documents (truncate-then-pad, exact
 * not `<=`) and this module's whole job is to compose text and hand the
 * FINAL result through one `fitToWidth(..., cols)` call so that postcondition
 * survives composition — see row-layout.ts for why the internal title/url
 * budget math doesn't need to be exact for this to hold.
 */

import {
  makeBrowserState,
  makeContractTab,
  makeContractWindow,
  makeTabGroup,
} from "@george43g/test-kit";
import { visualWidth } from "@george43g/tui-kit";
import { describe, expect, it } from "vitest";
import { layoutRowText } from "./row-layout.js";
import type { Row } from "./rows.js";

const ASCII_300 = "x".repeat(300);
const CJK_TITLE = "日本語のタイトルが長い場合";
const EMOJI_TITLE = "👨‍👩‍👧‍👦 family 🇦🇺 flags";
const LONE_SURROGATE = "\ud83d";

const browser = makeBrowserState({ browser: "chrome", extensionConnected: true });
const browserWithError = makeBrowserState({
  browser: "safari",
  extensionConnected: false,
  error: "Automation permission denied",
});
const window_ = makeContractWindow({ windowId: "w:chrome:100", title: "Inbox", cgWindowId: 42 });
const windowNoJoin = makeContractWindow({
  windowId: "w:chrome:200",
  title: "os-fork control plane",
  cgWindowId: null,
});

const groupBlue = makeTabGroup({ groupId: "g:chrome:x77", title: "Work", color: "blue" });

function tabRowWith(
  tab: ReturnType<typeof makeContractTab>,
  over: Partial<Row & { kind: "tab" }> = {},
): Row {
  return {
    kind: "tab",
    key: tab.tabId,
    browser: makeBrowserState({ tabGroups: [groupBlue] }),
    window: window_,
    tab,
    ...over,
  } as Row;
}

const browserRow: Row = { kind: "browser", key: "b:chrome", browser };
const browserRowError: Row = { kind: "browser", key: "b:safari", browser: browserWithError };

const windowRow: Row = { kind: "window", key: window_.windowId, browser, window: window_ };
const windowRowUntitled: Row = {
  kind: "window",
  key: window_.windowId,
  browser,
  window: makeContractWindow({ windowId: "w:chrome:101", title: "" }),
};
const windowRowHugeTitle: Row = {
  kind: "window",
  key: "w:huge",
  browser,
  window: makeContractWindow({ windowId: "w:huge", title: ASCII_300 }),
};
const windowRowLoneSurrogate: Row = {
  kind: "window",
  key: "w:lone",
  browser,
  window: makeContractWindow({ windowId: "w:lone", title: LONE_SURROGATE }),
};
const windowRowNoJoin: Row = {
  kind: "window",
  key: windowNoJoin.windowId,
  browser,
  window: windowNoJoin,
};

const tabRow: Row = tabRowWith(makeContractTab({ title: "Example", url: "https://example.test/" }));
const tabRowEmoji: Row = tabRowWith(
  makeContractTab({ title: EMOJI_TITLE, url: "https://example.test/emoji" }),
);
const tabRowCjk: Row = tabRowWith(
  makeContractTab({ title: CJK_TITLE, url: "https://example.test/cjk" }),
);
const tabRowEmptyTitle: Row = tabRowWith(makeContractTab({ title: "", url: "" }));
const tabRowHugeTitle: Row = tabRowWith(
  makeContractTab({ title: ASCII_300, url: `https://example.test/${ASCII_300}` }),
);
const tabRowLoneSurrogate: Row = tabRowWith(
  makeContractTab({ title: LONE_SURROGATE, url: "https://example.test/x" }),
);
const tabRowBadges: Row = tabRowWith(
  makeContractTab({
    title: "Busy tab",
    url: "https://example.test/busy",
    pinned: true,
    status: "loading",
    muted: true,
    frozen: true,
    discarded: true,
    groupId: "g:chrome:x77",
  }),
);

const CASES: Row[] = [
  browserRow,
  browserRowError,
  windowRow,
  windowRowUntitled,
  windowRowHugeTitle,
  windowRowLoneSurrogate,
  windowRowNoJoin,
  tabRow,
  tabRowEmoji,
  tabRowCjk,
  tabRowEmptyTitle,
  tabRowHugeTitle,
  tabRowLoneSurrogate,
  tabRowBadges,
];

describe("layoutRowText", () => {
  it("every row is exactly cols cells at every width 20..200", () => {
    for (let cols = 20; cols <= 200; cols++) {
      for (const row of CASES) {
        const text = layoutRowText(row, { cols, moveTarget: false });
        expect(visualWidth(text), `kind=${row.kind} cols=${cols}`).toBe(cols);
      }
    }
  });

  it("the move-target marker never breaks the width contract", () => {
    for (const cols of [20, 40, 80, 156, 200]) {
      expect(visualWidth(layoutRowText(windowRow, { cols, moveTarget: true }))).toBe(cols);
      expect(visualWidth(layoutRowText(windowRowNoJoin, { cols, moveTarget: true }))).toBe(cols);
    }
  });

  // R-T2: the marker is CONTEXT (a modal affordance — losing it recreates
  // this file's documented incident shape: acting on a window that was
  // never shown as the target), so it must survive at any width where the
  // row renders at all — unlike cg/tab-count/badges, which are allowed to
  // degrade or drop. cg=42 alone is 6 cells and the marker 12, so a plain
  // end-truncation (the pre-fix behavior) silently ate the marker well
  // before 40 columns; this pins that it no longer does.
  it("the move-target marker survives narrow widths, never silently truncated", () => {
    for (const cols of [20, 24, 30, 40]) {
      const text = layoutRowText(windowRow, { cols, moveTarget: true });
      expect(text, `cols=${cols}`).toContain("◀ move here");
      expect(visualWidth(text), `cols=${cols}`).toBe(cols);
    }
  });

  // R-T2 degradation order: cg is dropped BEFORE the tab count when both
  // don't fit — at cols=24 the full suffix (" — 1 tabs cg=42") doesn't fit
  // alongside an 8-cell title floor, but " — 1 tabs" alone does.
  it("drops cg before the tab count when the suffix must degrade", () => {
    const text = layoutRowText(windowRow, { cols: 24, moveTarget: false });
    expect(text).not.toContain("cg=42");
    expect(text).toContain("tabs");
    expect(visualWidth(text)).toBe(24);
  });

  // R-T2: badge/URL loss on tab rows at narrow widths is accepted —
  // ELABORATION, not context — and explicitly deferred to the detail-pane
  // task. This pins only the width invariant at a width narrow enough that
  // the badges in `tabRowBadges` (📌 ⏳ 🔇 🧊 💤 🔵Work) do NOT all survive;
  // whether/which badges drop is not this task's concern.
  it("keeps the width invariant for a badge-heavy tab row at a narrow width (badge loss accepted, deferred)", () => {
    const text = layoutRowText(tabRowBadges, { cols: 30, moveTarget: false });
    expect(visualWidth(text)).toBe(30);
  });

  it("the folded marker (▸ vs ▾) never breaks the width contract", () => {
    for (const cols of [20, 40, 80, 156, 200]) {
      expect(visualWidth(layoutRowText(windowRow, { cols, moveTarget: false, folded: true }))).toBe(
        cols,
      );
      expect(
        visualWidth(layoutRowText(windowRow, { cols, moveTarget: false, folded: false })),
      ).toBe(cols);
    }
  });

  it("renders a null cgWindowId as cg:none, not as nothing", () => {
    const text = layoutRowText(windowRowNoJoin, { cols: 120, moveTarget: false });
    expect(text).toContain("cg:none");
  });

  it("marks a browser-level error with the ⚠ glyph", () => {
    const text = layoutRowText(browserRowError, { cols: 120, moveTarget: false });
    expect(text).toContain("⚠");
  });

  it("carries tab badges (pin/loading/mute/freeze/sleep/group) into the row", () => {
    const text = layoutRowText(tabRowBadges, { cols: 120, moveTarget: false });
    expect(text).toContain("📌");
    expect(text).toContain("🔵Work");
  });

  it("does not throw and stays at exactly cols for a lone surrogate title", () => {
    for (const cols of [20, 21, 22, 30, 80]) {
      expect(() =>
        layoutRowText(windowRowLoneSurrogate, { cols, moveTarget: false }),
      ).not.toThrow();
      expect(() => layoutRowText(tabRowLoneSurrogate, { cols, moveTarget: false })).not.toThrow();
      expect(visualWidth(layoutRowText(windowRowLoneSurrogate, { cols, moveTarget: false }))).toBe(
        cols,
      );
      expect(visualWidth(layoutRowText(tabRowLoneSurrogate, { cols, moveTarget: false }))).toBe(
        cols,
      );
    }
  });
});
