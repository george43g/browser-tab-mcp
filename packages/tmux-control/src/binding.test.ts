import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keysOf, resolveSelector, type Selector } from "@george43g/control-language";
import { type ResolutionCase, runDomainConformance } from "@george43g/control-language/conformance";
import { describe, expect, it } from "vitest";
import { parseTmuxRow, parseTmuxSnapshot, type TmuxRawSnapshot } from "./adapter/read.js";
import { makeTmuxDomain } from "./binding.js";

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

const cases: ResolutionCase[] = [
  { name: "ids", selector: ids("%1", "%0", "%1"), expect: { keys: ["%1", "%0"] } },
  { name: "scope", selector: panes, expect: { keys: ["%2", "%0", "%1"] } },
  {
    name: "members",
    selector: { kind: "members", nodes: { kind: "scope", scope: "sessions" }, relation: "slots" },
    expect: { keys: ["$1:@1", "$1:@0", "$0:@0"] },
  },
  {
    name: "positions",
    selector: { kind: "positions", scope: panes, positions: [1, -1] },
    expect: { keys: ["%2", "%1"] },
  },
  {
    name: "where command",
    selector: {
      kind: "where",
      scope: panes,
      predicate: { kind: "cmp", field: "command", op: "eq", value: "sleep" },
    },
    expect: { keys: ["%2", "%0", "%1"] },
  },
  {
    name: "union",
    selector: { kind: "union", selectors: [ids("%1"), ids("%0", "%1")] },
    expect: { keys: ["%1", "%0"] },
  },
  {
    name: "intersect",
    selector: { kind: "intersect", selectors: [panes, ids("%1", "%2")] },
    expect: { keys: ["%2", "%1"] },
  },
  {
    name: "subtract",
    selector: { kind: "subtract", from: panes, remove: ids("%0") },
    expect: { keys: ["%2", "%1"] },
  },
  {
    name: "complement",
    selector: { kind: "complement", within: panes, selector: ids("%0") },
    expect: { keys: ["%2", "%1"] },
  },
  {
    name: "sort",
    selector: { kind: "sort", selector: panes, by: [{ field: "index", direction: "desc" }] },
    expect: { keys: ["%1", "%2", "%0"] },
  },
  {
    name: "slice",
    selector: { kind: "slice", selector: panes, range: { from: -2, to: -1 } },
    expect: { keys: ["%0", "%1"] },
  },
  {
    name: "withinEach",
    selector: {
      kind: "withinEach",
      branches: windows,
      relation: "panes",
      select: { kind: "positions", positions: [-1] },
    },
    expect: { keys: ["%2", "%1"] },
  },
  {
    name: "flatten",
    selector: { kind: "flatten", selector: { kind: "members", nodes: windows, relation: "panes" } },
    expect: { keys: ["%2", "%0", "%1"] },
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

  it("refuses sibling-dependent selectors until M3", () => {
    expect(() => domain.siblingsOf(snapshot.windows[0]!)).toThrow(/M3 experiment/);
  });

  it("rejects a mixed snapshot whose session count no longer matches its slots", () => {
    expect(() =>
      parseTmuxSnapshot({ ...fixture, sessions: fixture.sessions.replace("linked|2", "linked|3") }),
    ).toThrow(/changed while reading/);
  });
});
