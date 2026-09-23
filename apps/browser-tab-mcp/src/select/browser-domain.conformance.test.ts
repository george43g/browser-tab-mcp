/**
 * The browser binding through control-language's binding conformance suite
 * (tmux-control plan §4 M1). This is the CONTROL for the tmux experiment: the
 * binding passes unchanged, so a later tmux failure is about tmux, not about
 * the suite.
 *
 * The snapshot is the same shape browser-domain.test.ts uses — two browsers,
 * an incognito window, a tab group, and a group whose window the snapshot
 * does not contain — so every relation, every scope and the parentless-group
 * edge are reachable.
 */

import { type ResolutionCase, runDomainConformance } from "@george43g/control-language/conformance";
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

const X1 = "w:chrome:x1";
const X2 = "w:chrome:x2";
const S1 = "w:safari:1";
const G7 = "g:chrome:x7";
const T10 = "t:chrome:x10";
const T11 = "t:chrome:x11";
const T12 = "t:chrome:x12";
const T20 = "t:chrome:x20";
const TS = "t:safari:w1:i1";

const ids = (...list: string[]) => ({ kind: "ids" as const, ids: list });
const scope = (name: string) => ({ kind: "scope" as const, scope: name });
const focusedTabs = scope("tabsInFocusedWindow");
const grouped = {
  kind: "where" as const,
  scope: scope("allTabs"),
  predicate: { kind: "cmp" as const, field: "grouped", op: "eq" as const, value: true },
};
const firstOfEachWindow = {
  kind: "withinEach" as const,
  branches: scope("allWindows"),
  relation: "tabs",
  select: { kind: "positions" as const, positions: [1] },
};

const CASES: ResolutionCase[] = [
  // ---- sibling-free --------------------------------------------------------
  { name: "ids", selector: ids(T12, T10), expect: { keys: [T12, T10], kind: "tab" } },
  { name: "ids unknown handle", selector: ids("t:chrome:x999"), expect: { error: "E_UNKNOWN_ID" } },
  { name: "ids window + tab", selector: ids(X1, T10), expect: { error: "E_KIND_MISMATCH" } },
  { name: "scope allTabs", selector: scope("allTabs"), expect: { keys: [T10, T11, T12, T20, TS] } },
  { name: "scope focusedWindow", selector: scope("focusedWindow"), expect: { keys: [X1] } },
  {
    name: "members windows → tabs",
    selector: { kind: "members", nodes: scope("allWindows"), relation: "tabs" },
    expect: { keys: [T10, T11, T12, T20, TS], branchPaths: [[X1], [X1], [X1], [X2], [S1]] },
  },
  {
    name: "members groups → tabs (the orphan group contributes none)",
    selector: { kind: "members", nodes: scope("allGroups"), relation: "members" },
    expect: { keys: [T10, T11], branchPaths: [[G7], [G7]] },
  },
  {
    name: "members inapplicable",
    selector: { kind: "members", nodes: scope("allTabs"), relation: "windows" },
    expect: { error: "E_RELATION_INAPPLICABLE" },
  },
  {
    name: "positions last of focused window",
    selector: { kind: "positions", scope: focusedTabs, positions: [-1] },
    expect: { keys: [T12] },
  },
  {
    name: "where domain (registrable, so docs.github.com matches)",
    selector: {
      kind: "where",
      scope: scope("allTabs"),
      predicate: { kind: "cmp", field: "domain", op: "eq", value: "github.com" },
    },
    expect: { keys: [T10, T11] },
  },
  {
    name: "union left-biased",
    selector: { kind: "union", selectors: [ids(T20), focusedTabs] },
    expect: { keys: [T20, T10, T11, T12] },
  },
  {
    name: "intersect keeps left order",
    selector: { kind: "intersect", selectors: [scope("allTabs"), ids(T12, T10)] },
    expect: { keys: [T10, T12] },
  },
  {
    name: "subtract grouped",
    selector: { kind: "subtract", from: focusedTabs, remove: grouped },
    expect: { keys: [T12] },
  },
  {
    name: "complement of the focused window",
    selector: { kind: "complement", within: scope("allTabs"), selector: focusedTabs },
    expect: { keys: [T20, TS] },
  },
  {
    name: "sort by title",
    selector: { kind: "sort", selector: scope("allTabs"), by: [{ field: "title" }] },
    expect: { keys: [TS, T11, T12, T20, T10] },
  },
  {
    name: "slice",
    selector: { kind: "slice", selector: scope("allTabs"), range: { from: 2, to: 3 } },
    expect: { keys: [T11, T12] },
  },
  {
    name: "withinEach first tab of each window",
    selector: firstOfEachWindow,
    expect: { keys: [T10, T20, TS], branchPaths: [[X1], [X2], [S1]] },
  },
  {
    name: "flatten",
    selector: { kind: "flatten", selector: firstOfEachWindow },
    expect: { keys: [T10, T20, TS], branchPaths: [[], [], []] },
  },
  // ---- sibling-dependent ---------------------------------------------------
  {
    name: "offset around a tab",
    selector: { kind: "offset", anchor: ids(T11), offsets: { from: -1, to: 1 } },
    expect: { keys: [T10, T11, T12] },
  },
  {
    name: "expand clips at the window edge",
    selector: { kind: "expand", selector: ids(T20), offsets: { from: 0, to: 1 } },
    expect: { keys: [T20] },
  },
  {
    name: "between, reversed",
    selector: { kind: "between", anchors: [ids(T12), ids(T10)] },
    expect: { keys: [T12, T11, T10] },
  },
  {
    name: "between across windows",
    selector: { kind: "between", anchors: [ids(T10), ids(T20)] },
    expect: { error: "E_NO_COMMON_PARENT" },
  },
  {
    name: "siblings of a window are its browser's windows",
    selector: { kind: "siblings", selector: ids(X2) },
    expect: { keys: [X1, X2] },
  },
  {
    name: "siblings of the orphan group",
    selector: { kind: "siblings", selector: ids("g:chrome:x9") },
    expect: { keys: ["g:chrome:x9"] },
  },
];

describe("browser binding — control-language conformance", () => {
  const domain = makeBrowserDomain(fixtureSnapshot(), {
    temporal: mapTemporalProvider(
      new Map([[T10, 1_756_000_100_000]]),
      new Map([[T10, 1_756_000_200_000]]),
    ),
  });

  it("passes every binding invariant and every case, both node-kind groups", () => {
    const report = runDomainConformance(domain, { cases: CASES });
    expect(report.failures).toEqual([]);
    // 2 browsers + 3 windows + 2 groups + 5 tabs.
    expect(report.entities).toHaveLength(12);
    expect(report.cases.siblingDependent).toHaveLength(6);
  });

  it("passes the sibling-free group alone, as M2's tmux binding will first have to", () => {
    const report = runDomainConformance(domain, { groups: ["siblingFree"], cases: CASES });
    expect(report.failures).toEqual([]);
    expect(report.cases.siblingFree).toHaveLength(CASES.length - 6);
  });
});
