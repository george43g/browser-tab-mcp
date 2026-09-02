/**
 * Browser binding unit tests — DSL Phase 2 PR-A.
 *
 * Two contracts pinned beyond ordinary behavior:
 *
 * 1. BRANCH ORDER (adaptation record §7, last row): scope enumeration follows
 *    snapshot tree order — browsers in snapshot order, windows in browser
 *    order, tabs in visual order. This test is what turns our documented
 *    order into a fact rather than an assumption about API array order.
 * 2. FIELD-CATALOG COVERAGE (the B21 selector-not-result rule): every field
 *    the catalog declares must resolve to a DEFINED value on at least one
 *    fully-populated fixture ref — a typo'd catalog entry must fail here,
 *    not silently read as always-undefined (which the unknown policy would
 *    then quietly exclude forever).
 */

import { resolveSelector } from "@george43g/control-language";
import {
  makeBrowserState,
  makeContractTab,
  makeContractWindow,
  makeSnapshot,
  makeTabGroup,
} from "@george43g/test-kit";
import { describe, expect, it } from "vitest";
import { makeBrowserDomain } from "./browser-domain.js";
import { mapTemporalProvider } from "./temporal.js";

function fixtureSnapshot() {
  return makeSnapshot({
    focusedBrowser: "chrome",
    browsers: [
      makeBrowserState({
        browser: "chrome",
        extensionConnected: true,
        dataSource: "extension",
        tabGroups: [
          makeTabGroup({
            groupId: "g:chrome:x7",
            windowId: "w:chrome:x1",
            title: "Research",
            color: "red",
          }),
          // A group whose window the snapshot does not contain.
          makeTabGroup({ groupId: "g:chrome:x9", windowId: "w:chrome:x404", color: "blue" }),
        ],
        windows: [
          makeContractWindow({
            windowId: "w:chrome:x1",
            focused: true,
            state: "normal",
            tabs: [
              makeContractTab({
                tabId: "t:chrome:x10",
                index: 0,
                url: "https://github.com/george43g/browser-tab-mcp/pulls",
                title: "PRs",
                active: true,
                pinned: true,
                audible: true,
                muted: true,
                groupId: "g:chrome:x7",
                lastAccessed: 1_756_000_000_000,
              }),
              makeContractTab({
                tabId: "t:chrome:x11",
                index: 1,
                url: "https://docs.github.com/rest",
                title: "Docs",
                groupId: "g:chrome:x7",
              }),
              makeContractTab({
                tabId: "t:chrome:x12",
                index: 2,
                url: "https://example.org/a",
                title: "Example",
                discarded: true,
              }),
            ],
          }),
          makeContractWindow({
            windowId: "w:chrome:x2",
            incognito: true,
            // The factory defaults every window to focused:true; a browser has
            // at most one focused window, so the fixture says so explicitly.
            focused: false,
            tabs: [
              makeContractTab({
                tabId: "t:chrome:x20",
                index: 0,
                url: "https://mail.google.com/",
                title: "Mail",
              }),
            ],
          }),
        ],
      }),
      makeBrowserState({
        browser: "safari",
        extensionConnected: false,
        dataSource: "applescript",
        windows: [
          makeContractWindow({
            windowId: "w:safari:1",
            focused: false,
            tabs: [
              makeContractTab({
                tabId: "t:safari:w1:i1",
                index: 0,
                url: "https://developer.apple.com/",
                title: "ADC",
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

describe("makeBrowserDomain — enumeration and identity", () => {
  const domain = makeBrowserDomain(fixtureSnapshot());

  it("allTabs follows snapshot tree order: browser → window → visual tab order", () => {
    expect(domain.scopeMembers("allTabs").map((r) => domain.stableKey(r))).toEqual([
      "t:chrome:x10",
      "t:chrome:x11",
      "t:chrome:x12",
      "t:chrome:x20",
      "t:safari:w1:i1",
    ]);
  });

  it("stable keys are the existing opaque handles, and byKey inverts them", () => {
    for (const scope of ["allBrowsers", "allWindows", "allGroups", "allTabs"]) {
      const members = domain.scopeMembers(scope);
      expect(members.length, `${scope} enumerates non-empty`).toBeGreaterThan(0);
      for (const r of members) {
        expect(domain.byKey(domain.stableKey(r))).toBe(r);
      }
    }
  });

  it("members relation filters the group's window tabs by groupId", () => {
    const group = domain.byKey("g:chrome:x7");
    expect(group).toBeDefined();
    const members = domain.orderedMembers(group as never, "members");
    expect(members?.map((r) => domain.stableKey(r))).toEqual(["t:chrome:x10", "t:chrome:x11"]);
  });

  it("a group whose window is missing has zero members, not an error", () => {
    const orphan = domain.byKey("g:chrome:x9");
    expect(domain.orderedMembers(orphan as never, "members")).toEqual([]);
  });

  it("an inapplicable relation answers undefined (resolver turns it into an error)", () => {
    const tab = domain.byKey("t:chrome:x10");
    expect(domain.orderedMembers(tab as never, "tabs")).toBeUndefined();
    expect(domain.orderedMembers(tab as never, "nonsense")).toBeUndefined();
  });

  it("parentOf and siblingsOf walk the tree", () => {
    const tab = domain.byKey("t:chrome:x11");
    const win = domain.parentOf(tab as never);
    expect(domain.stableKey(win as never)).toBe("w:chrome:x1");
    expect(domain.siblingsOf(tab as never).map((r) => domain.stableKey(r))).toEqual([
      "t:chrome:x10",
      "t:chrome:x11",
      "t:chrome:x12",
    ]);
    expect(domain.stableKey(domain.parentOf(win as never) as never)).toBe("chrome");
  });
});

describe("makeBrowserDomain — focused window", () => {
  it("uses focusedBrowser's focused window when the snapshot names one", () => {
    const domain = makeBrowserDomain(fixtureSnapshot());
    expect(domain.scopeMembers("focusedWindow").map((r) => domain.stableKey(r))).toEqual([
      "w:chrome:x1",
    ]);
    expect(domain.scopeMembers("tabsInFocusedWindow").map((r) => domain.stableKey(r))).toEqual([
      "t:chrome:x10",
      "t:chrome:x11",
      "t:chrome:x12",
    ]);
  });

  it("falls back to the single focused window when focusedBrowser is absent", () => {
    const snap = fixtureSnapshot();
    snap.focusedBrowser = undefined;
    const domain = makeBrowserDomain(snap);
    expect(domain.scopeMembers("focusedWindow").map((r) => domain.stableKey(r))).toEqual([
      "w:chrome:x1",
    ]);
  });

  it("is EMPTY when several browsers each claim a focused window and no tiebreak exists", () => {
    const snap = fixtureSnapshot();
    snap.focusedBrowser = undefined;
    const safari = snap.browsers[1];
    if (safari?.windows[0]) safari.windows[0].focused = true;
    const domain = makeBrowserDomain(snap);
    // Ambiguity must read as unknown (empty), never as a silent pick — the
    // §7 emptySelection policy handles what happens next per operation.
    expect(domain.scopeMembers("focusedWindow")).toEqual([]);
  });
});

describe("makeBrowserDomain — B24 focusedWindow vacancy fallback", () => {
  it("uses the hint when focusedBrowser is named but NO window is focused (the terminal case)", () => {
    const snap = fixtureSnapshot();
    for (const b of snap.browsers) for (const w of b.windows) w.focused = false;
    let fired = 0;
    const domain = makeBrowserDomain(snap, {
      focusedWindowHint: "w:chrome:x2",
      onFocusFallback: () => {
        fired += 1;
      },
    });
    expect(domain.scopeMembers("focusedWindow").map((r) => domain.stableKey(r))).toEqual([
      "w:chrome:x2",
    ]);
    expect(fired).toBe(1);
  });

  it("never settles a CONTEST: multiple focused windows stay empty despite a hint", () => {
    const snap = fixtureSnapshot();
    snap.focusedBrowser = undefined;
    const safari = snap.browsers[1];
    if (safari?.windows[0]) safari.windows[0].focused = true; // chrome w1 also focused
    let fired = 0;
    const domain = makeBrowserDomain(snap, {
      focusedWindowHint: "w:chrome:x2",
      onFocusFallback: () => {
        fired += 1;
      },
    });
    expect(domain.scopeMembers("focusedWindow")).toEqual([]);
    expect(fired).toBe(0);
  });

  it("a hint naming a vanished window leaves the scope empty, callback unfired", () => {
    const snap = fixtureSnapshot();
    for (const b of snap.browsers) for (const w of b.windows) w.focused = false;
    let fired = 0;
    const domain = makeBrowserDomain(snap, {
      focusedWindowHint: "w:chrome:x404",
      onFocusFallback: () => {
        fired += 1;
      },
    });
    expect(domain.scopeMembers("focusedWindow")).toEqual([]);
    expect(fired).toBe(0);
  });
});

describe("makeBrowserDomain — field catalog coverage (selector, not result)", () => {
  const domain = makeBrowserDomain(fixtureSnapshot(), {
    temporal: mapTemporalProvider(
      new Map([["t:chrome:x10", 1_756_000_100_000]]),
      new Map([["t:chrome:x10", 1_756_000_200_000]]),
    ),
  });

  it("every declared field resolves DEFINED on at least one fully-populated ref", () => {
    const fields = [...domain.fields().keys()];
    expect(fields.length).toBeGreaterThanOrEqual(20);
    const probes = [
      domain.byKey("t:chrome:x10"),
      domain.byKey("w:chrome:x1"),
      domain.byKey("g:chrome:x7"),
      domain.byKey("chrome"),
    ];
    for (const field of fields) {
      const covered = probes.some(
        (r) => r !== undefined && domain.readField(r, field) !== undefined,
      );
      expect(covered, `catalog field "${field}" never resolves on the full fixture`).toBe(true);
    }
  });

  it("derived URL fields decompose the redacted snapshot url", () => {
    const tab = domain.byKey("t:chrome:x10") as never;
    expect(domain.readField(tab, "scheme")).toBe("https");
    expect(domain.readField(tab, "host")).toBe("github.com");
    expect(domain.readField(tab, "domain")).toBe("github.com");
    expect(domain.readField(tab, "path")).toBe("/george43g/browser-tab-mcp/pulls");
  });

  it("incognito is window-inherited on tabs; grouped derives from groupId", () => {
    const normal = domain.byKey("t:chrome:x10") as never;
    const incog = domain.byKey("t:chrome:x20") as never;
    expect(domain.readField(normal, "incognito")).toBe(false);
    expect(domain.readField(incog, "incognito")).toBe(true);
    expect(domain.readField(normal, "grouped")).toBe(true);
    expect(domain.readField(incog, "grouped")).toBe(false);
  });

  it("temporal fields come from the provider and are undefined without one", () => {
    const tab = domain.byKey("t:chrome:x10") as never;
    expect(domain.readField(tab, "lastFocusedAt")).toBe(1_756_000_100_000);
    expect(domain.readField(tab, "lastNavigatedAt")).toBe(1_756_000_200_000);
    const bare = makeBrowserDomain(fixtureSnapshot());
    expect(bare.readField(bare.byKey("t:chrome:x10") as never, "lastFocusedAt")).toBeUndefined();
  });
});

describe("end-to-end through resolveSelector", () => {
  const domain = makeBrowserDomain(fixtureSnapshot());

  it("predicate over host selects across browsers, tree order preserved", () => {
    const sel = resolveSelector(
      {
        kind: "where",
        scope: { kind: "scope", scope: "allTabs" },
        predicate: { kind: "cmp", field: "host", op: "suffix", value: "github.com" },
      },
      domain,
    );
    expect(sel.occurrences.map((o) => o.key)).toEqual(["t:chrome:x10", "t:chrome:x11"]);
  });

  it("signed positions: -1 is the last tab of the focused window", () => {
    const sel = resolveSelector(
      {
        kind: "positions",
        scope: { kind: "scope", scope: "tabsInFocusedWindow" },
        positions: [-1],
      },
      domain,
    );
    expect(sel.occurrences.map((o) => o.key)).toEqual(["t:chrome:x12"]);
  });

  it("withinEach last-tab-per-window differs from flatten's single last tab", () => {
    const perBranch = resolveSelector(
      {
        kind: "withinEach",
        branches: { kind: "scope", scope: "allWindows" },
        relation: "tabs",
        select: { kind: "positions", positions: [-1] },
      },
      domain,
    );
    expect(perBranch.occurrences.map((o) => o.key)).toEqual([
      "t:chrome:x12",
      "t:chrome:x20",
      "t:safari:w1:i1",
    ]);
    const flat = resolveSelector(
      {
        kind: "positions",
        scope: {
          kind: "members",
          nodes: { kind: "scope", scope: "allWindows" },
          relation: "tabs",
        },
        positions: [-1],
      },
      domain,
    );
    expect(flat.occurrences.map((o) => o.key)).toEqual(["t:safari:w1:i1"]);
  });

  it("group member projection is explicit — the group node itself is not tabs", () => {
    const members = resolveSelector(
      {
        kind: "members",
        nodes: { kind: "ids", ids: ["g:chrome:x7"] },
        relation: "members",
      },
      domain,
    );
    expect(members.kind).toBe("tab");
    expect(members.occurrences.map((o) => o.key)).toEqual(["t:chrome:x10", "t:chrome:x11"]);
  });

  it("union of a projection and a predicate stays left-biased and deduplicated", () => {
    const sel = resolveSelector(
      {
        kind: "union",
        selectors: [
          {
            kind: "members",
            nodes: { kind: "ids", ids: ["g:chrome:x7"] },
            relation: "members",
          },
          {
            kind: "where",
            scope: { kind: "scope", scope: "allTabs" },
            predicate: { kind: "cmp", field: "audible", op: "eq", value: true },
          },
        ],
      },
      domain,
    );
    // t:chrome:x10 is both a group member and audible — appears once, in the
    // left operand's position.
    expect(sel.occurrences.map((o) => o.key)).toEqual(["t:chrome:x10", "t:chrome:x11"]);
  });
});
