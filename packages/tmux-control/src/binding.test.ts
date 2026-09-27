import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keysOf, resolveSelector, type Selector } from "@george43g/control-language";
import { type ResolutionCase, runDomainConformance } from "@george43g/control-language/conformance";
import { describe, expect, it } from "vitest";
import { parseTmuxRow, parseTmuxSnapshot, type TmuxRawSnapshot } from "./adapter/read.js";
import { makeTmuxDomain } from "./binding.js";
import type { TmuxSnapshot } from "./model.js";

// Captured from tmux 3.7b on a private -L server: two sessions, one linked
// window, two panes in that window, one control client. Pane cwd was /; the
// client TTY suffix was normalized to the portable /dev/tty fixture value.
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/linked-2026-09-27.json", import.meta.url)),
    "utf8",
  ),
) as TmuxRawSnapshot;
const snapshot = parseTmuxSnapshot(fixture);
const domain = makeTmuxDomain(snapshot);
const ids = (...values: string[]): Selector => ({ kind: "ids", ids: values });
const panes: Selector = { kind: "scope", scope: "panes" };
const windows: Selector = { kind: "scope", scope: "windows" };
const slots: Selector = { kind: "scope", scope: "slots" };

// A session group links every window. The two sessions retain independent
// slot positions and active flags while sharing the same window objects.
const groupSnapshot: TmuxSnapshot = {
  ...snapshot,
  sessions: [
    ...snapshot.sessions,
    { kind: "session", key: "$2", id: "$2", name: "linked-agent", windowCount: 2, attached: false },
  ],
  slots: [
    ...snapshot.slots,
    { kind: "slot", key: "$2:@1", sessionId: "$2", windowId: "@1", index: 0, active: false },
    { kind: "slot", key: "$2:@0", sessionId: "$2", windowId: "@0", index: 1, active: true },
  ],
};

const cases: ResolutionCase[] = [
  { name: "ids", selector: ids("%1", "%0", "%1"), expect: { keys: ["%1", "%0"] } },
  { name: "scope", selector: panes, expect: { keys: ["%0", "%1", "%2"] } },
  {
    name: "members",
    selector: { kind: "members", nodes: { kind: "scope", scope: "sessions" }, relation: "slots" },
    expect: { keys: ["$1:@1", "$1:@0", "$0:@0"] },
  },
  {
    name: "positions",
    selector: { kind: "positions", scope: panes, positions: [1, -1] },
    expect: { keys: ["%0", "%2"] },
  },
  {
    name: "where command",
    selector: {
      kind: "where",
      scope: panes,
      predicate: { kind: "cmp", field: "command", op: "eq", value: "sleep" },
    },
    expect: { keys: ["%0", "%1", "%2"] },
  },
  {
    name: "union",
    selector: { kind: "union", selectors: [ids("%1"), ids("%0", "%1")] },
    expect: { keys: ["%1", "%0"] },
  },
  {
    name: "intersect",
    selector: { kind: "intersect", selectors: [panes, ids("%1", "%2")] },
    expect: { keys: ["%1", "%2"] },
  },
  {
    name: "subtract",
    selector: { kind: "subtract", from: panes, remove: ids("%0") },
    expect: { keys: ["%1", "%2"] },
  },
  {
    name: "complement",
    selector: { kind: "complement", within: panes, selector: ids("%0") },
    expect: { keys: ["%1", "%2"] },
  },
  {
    name: "sort",
    selector: { kind: "sort", selector: panes, by: [{ field: "index", direction: "desc" }] },
    expect: { keys: ["%1", "%0", "%2"] },
  },
  {
    name: "slice",
    selector: { kind: "slice", selector: panes, range: { from: -2, to: -1 } },
    expect: { keys: ["%1", "%2"] },
  },
  {
    name: "withinEach",
    selector: {
      kind: "withinEach",
      branches: windows,
      relation: "panes",
      select: { kind: "positions", positions: [-1] },
    },
    expect: { keys: ["%1", "%2"] },
  },
  {
    name: "flatten",
    selector: { kind: "flatten", selector: { kind: "members", nodes: windows, relation: "panes" } },
    expect: { keys: ["%0", "%1", "%2"] },
  },
  {
    name: "offset in linked session",
    selector: { kind: "offset", anchor: ids("$1:@0"), offsets: { from: -1, to: 0 } },
    expect: { keys: ["$1:@1", "$1:@0"] },
  },
  {
    name: "expand linked slots",
    selector: { kind: "expand", selector: ids("$1:@0", "$0:@0"), offsets: { from: -1, to: 0 } },
    expect: { keys: ["$1:@1", "$1:@0", "$0:@0"] },
  },
  {
    name: "between one session",
    selector: { kind: "between", anchors: [ids("$1:@1"), ids("$1:@0")] },
    expect: { keys: ["$1:@1", "$1:@0"] },
  },
  {
    name: "siblings in linked session",
    selector: { kind: "siblings", selector: ids("$1:@0") },
    expect: { keys: ["$1:@1", "$1:@0"] },
  },
];

describe("tmux binding from real -F rows", () => {
  it("parses q-escaped separators without changing names", () => {
    expect(parseTmuxRow("@0|Agent\\|\\ One|80", 3)).toEqual(["@0", "Agent| One", "80"]);
    expect(snapshot.windows.find((window) => window.id === "@0")?.name).toBe("Agent| One");
  });

  it("keeps linked slots distinct and underlying objects singular", () => {
    expect(snapshot.slots.filter((slot) => slot.windowId === "@0")).toHaveLength(2);
    expect(snapshot.windows.filter((window) => window.id === "@0")).toHaveLength(1);
    expect(snapshot.panes.filter((pane) => pane.windowId === "@0")).toHaveLength(2);
    expect(snapshot.clients).toHaveLength(1);
    expect(snapshot.clients[0]).toMatchObject({ key: "client:39231", sessionId: "$0", width: 80 });
    expect(snapshot.clients[0]?.height).toBeUndefined();
    expect(
      keysOf(resolveSelector({ kind: "members", nodes: ids("$1"), relation: "slots" }, domain)),
    ).toEqual(["$1:@1", "$1:@0"]);
  });

  it("passes all 13 sibling-free kinds with control-language unchanged", () => {
    const report = runDomainConformance(domain, {
      groups: ["siblingFree"],
      sparseFields: ["project"],
      cases,
    });
    expect(report.failures).toEqual([]);
  });

  it("passes the complete conformance suite, including all four sibling kinds", () => {
    const report = runDomainConformance(domain, { sparseFields: ["project"], cases });
    expect(report.failures).toEqual([]);
  });

  it("offset uses the linked slot's own session order", () => {
    expect(
      keysOf(
        resolveSelector(
          { kind: "offset", anchor: ids("$1:@0"), offsets: { from: -1, to: 0 } },
          domain,
        ),
      ),
    ).toEqual(["$1:@1", "$1:@0"]);
    expect(
      keysOf(
        resolveSelector(
          { kind: "offset", anchor: ids("$0:@0"), offsets: { from: -1, to: 0 } },
          domain,
        ),
      ),
    ).toEqual(["$0:@0"]);
  });

  it("expand retains both linked slot occurrences", () => {
    expect(
      keysOf(
        resolveSelector(
          { kind: "expand", selector: ids("$1:@0", "$0:@0"), offsets: { from: -1, to: 0 } },
          domain,
        ),
      ),
    ).toEqual(["$1:@1", "$1:@0", "$0:@0"]);
  });

  it("between requires slots in one session", () => {
    expect(
      keysOf(resolveSelector({ kind: "between", anchors: [ids("$1:@1"), ids("$1:@0")] }, domain)),
    ).toEqual(["$1:@1", "$1:@0"]);
    expect(() =>
      resolveSelector({ kind: "between", anchors: [ids("$1:@0"), ids("$0:@0")] }, domain),
    ).toThrow(/E_NO_COMMON_PARENT/);
  });

  it("siblings follows the linked slot's own session", () => {
    expect(keysOf(resolveSelector({ kind: "siblings", selector: ids("$1:@0") }, domain))).toEqual([
      "$1:@1",
      "$1:@0",
    ]);
    expect(keysOf(resolveSelector({ kind: "siblings", selector: ids("$0:@0") }, domain))).toEqual([
      "$0:@0",
    ]);
  });

  it("a session group keeps shared windows in distinct slot runs", () => {
    const grouped = makeTmuxDomain(groupSnapshot);
    expect(keysOf(resolveSelector({ kind: "siblings", selector: ids("$2:@0") }, grouped))).toEqual([
      "$2:@1",
      "$2:@0",
    ]);
    const lastSlotInEach = resolveSelector(
      {
        kind: "withinEach",
        branches: { kind: "scope", scope: "sessions" },
        relation: "slots",
        select: { kind: "positions", positions: [-1] },
      },
      grouped,
    );
    expect(keysOf(lastSlotInEach)).toEqual(["$1:@0", "$0:@0", "$2:@0"]);
    expect(lastSlotInEach.occurrences.map((occurrence) => occurrence.branchPath)).toEqual([
      ["$1"],
      ["$0"],
      ["$2"],
    ]);
    expect(keysOf(resolveSelector(slots, grouped))).toEqual([
      "$1:@1",
      "$1:@0",
      "$0:@0",
      "$2:@1",
      "$2:@0",
    ]);
  });

  it("the global window-object view has its own stable ID order", () => {
    expect(keysOf(resolveSelector(windows, domain))).toEqual(["@0", "@1"]);
    expect(keysOf(resolveSelector({ kind: "siblings", selector: ids("@0") }, domain))).toEqual([
      "@0",
      "@1",
    ]);
  });

  it("rejects a mixed snapshot whose session count no longer matches its slots", () => {
    expect(() =>
      parseTmuxSnapshot({ ...fixture, sessions: fixture.sessions.replace("linked|2", "linked|3") }),
    ).toThrow(/changed while reading/);
  });
});
