/**
 * The conformance suite run against the synthetic fixture (the control), and
 * against deliberately broken copies of it (the inversion) — a green run only
 * means something if the same suite goes red on a binding that is wrong.
 */

import { describe, expect, it } from "vitest";
import {
  type ConformanceReport,
  groupOf,
  INVARIANTS,
  type ResolutionCase,
  runDomainConformance,
  SIBLING_DEPENDENT_KINDS,
  SIBLING_FREE_KINDS,
} from "./conformance.js";
import type { SelectionDomain } from "./domain.js";
import { type FixtureEntity, makeSyntheticDomain } from "./fixture.js";
import type { Selector } from "./schema.js";

const ids = (...list: string[]): Selector => ({ kind: "ids", ids: list });
const allTracks: Selector = { kind: "scope", scope: "allTracks" };
const allPlaylists: Selector = { kind: "scope", scope: "allPlaylists" };
const liked: Selector = {
  kind: "where",
  scope: allTracks,
  predicate: { kind: "cmp", field: "liked", op: "eq", value: true },
};
const lastOfEach: Selector = {
  kind: "withinEach",
  branches: allPlaylists,
  relation: "tracks",
  select: { kind: "positions", positions: [-1] },
};

/** One or more cases per node kind, against the default fixture (p1 t1..t5, p2 t6..t8, p3 empty). */
const CASES: ResolutionCase[] = [
  // ---- sibling-free --------------------------------------------------------
  {
    name: "ids keeps order, dedupes",
    selector: ids("t3", "t1", "t3", "t8"),
    expect: { keys: ["t3", "t1", "t8"], kind: "track" },
  },
  { name: "ids unknown key", selector: ids("t1", "ghost"), expect: { error: "E_UNKNOWN_ID" } },
  { name: "ids mixing kinds", selector: ids("p1", "t1"), expect: { error: "E_KIND_MISMATCH" } },
  {
    name: "scope in domain order",
    selector: allTracks,
    expect: { keys: ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"], kind: "track" },
  },
  {
    name: "scope undeclared",
    selector: { kind: "scope", scope: "nope" },
    expect: { error: "E_UNKNOWN_SCOPE" },
  },
  {
    name: "members with provenance",
    selector: { kind: "members", nodes: allPlaylists, relation: "tracks" },
    expect: {
      keys: ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"],
      branchPaths: [["p1"], ["p1"], ["p1"], ["p1"], ["p1"], ["p2"], ["p2"], ["p2"]],
    },
  },
  {
    name: "members inapplicable",
    selector: { kind: "members", nodes: allTracks, relation: "tracks" },
    expect: { error: "E_RELATION_INAPPLICABLE" },
  },
  {
    name: "positions first and last",
    selector: { kind: "positions", scope: allTracks, positions: [1, -1] },
    expect: { keys: ["t1", "t8"] },
  },
  {
    name: "positions clamp warns",
    selector: { kind: "positions", scope: allTracks, positions: [99] },
    expect: { keys: ["t8"], warnings: 1 },
  },
  { name: "where liked", selector: liked, expect: { keys: ["t1", "t3", "t5", "t7"] } },
  {
    name: "union is left-biased",
    selector: { kind: "union", selectors: [ids("t2"), ids("t1", "t2")] },
    expect: { keys: ["t2", "t1"] },
  },
  {
    name: "union of kinds",
    selector: { kind: "union", selectors: [allPlaylists, allTracks] },
    expect: { error: "E_KIND_MISMATCH" },
  },
  {
    name: "intersect keeps left order",
    selector: { kind: "intersect", selectors: [allTracks, ids("t5", "t1")] },
    expect: { keys: ["t1", "t5"] },
  },
  {
    name: "subtract",
    selector: {
      kind: "subtract",
      from: allTracks,
      remove: ids("t1", "t2", "t3", "t4", "t5", "t6"),
    },
    expect: { keys: ["t7", "t8"] },
  },
  {
    name: "complement within scope order",
    selector: { kind: "complement", within: allTracks, selector: liked },
    expect: { keys: ["t2", "t4", "t6", "t8"] },
  },
  {
    name: "sort desc, undefined last, stable",
    selector: { kind: "sort", selector: allTracks, by: [{ field: "rating", direction: "desc" }] },
    expect: { keys: ["t1", "t5", "t3", "t6", "t2", "t4", "t7", "t8"] },
  },
  {
    name: "slice last two",
    selector: { kind: "slice", selector: allTracks, range: { from: -2, to: -1 } },
    expect: { keys: ["t7", "t8"] },
  },
  {
    name: "withinEach last of each branch",
    selector: lastOfEach,
    expect: { keys: ["t5", "t8"], branchPaths: [["p1"], ["p2"]] },
  },
  {
    name: "flatten erases provenance, keeps order",
    selector: { kind: "flatten", selector: lastOfEach },
    expect: { keys: ["t5", "t8"], branchPaths: [[], []] },
  },
  // ---- sibling-dependent ---------------------------------------------------
  {
    name: "offset neighbourhood",
    selector: { kind: "offset", anchor: ids("t3"), offsets: { from: -1, to: 1 } },
    expect: { keys: ["t2", "t3", "t4"] },
  },
  {
    name: "offset clipped at boundary",
    selector: { kind: "offset", anchor: ids("t1"), offsets: { from: -2, to: 0 } },
    expect: { keys: ["t1"], warnings: 1 },
  },
  {
    name: "offset non-singular anchor",
    selector: { kind: "offset", anchor: ids("t1", "t2"), offsets: { from: 0, to: 0 } },
    expect: { error: "E_ANCHOR_NOT_SINGULAR" },
  },
  {
    name: "expand dedupes first-seen",
    selector: { kind: "expand", selector: ids("t1", "t5"), offsets: { from: 0, to: 1 } },
    expect: { keys: ["t1", "t2", "t5"] },
  },
  {
    name: "between keeps anchor direction",
    selector: { kind: "between", anchors: [ids("t4"), ids("t2")] },
    expect: { keys: ["t4", "t3", "t2"] },
  },
  {
    name: "between across parents",
    selector: { kind: "between", anchors: [ids("t2"), ids("t7")] },
    expect: { error: "E_NO_COMMON_PARENT" },
  },
  {
    name: "siblings of a member",
    selector: { kind: "siblings", selector: ids("t7") },
    expect: { keys: ["t6", "t7", "t8"] },
  },
  {
    name: "withinEach over an offset is sibling-dependent",
    selector: {
      kind: "withinEach",
      branches: allPlaylists,
      relation: "tracks",
      select: { kind: "offset", anchor: ids("t2"), offsets: { from: 0, to: 1 } },
    },
    expect: { keys: ["t2", "t3"] },
  },
];

const checks = (r: ConformanceReport<unknown>): string[] => [
  ...new Set(r.failures.map((f) => f.check)),
];

/** A copy of the fixture with some methods replaced. */
function broken(
  patch: (d: SelectionDomain<FixtureEntity>) => Partial<SelectionDomain<FixtureEntity>>,
): SelectionDomain<FixtureEntity> {
  const d = makeSyntheticDomain();
  return { ...d, ...patch(d) };
}

describe("node-kind groups", () => {
  it("partition the 17 node kinds 13 + 4, as the plan measured", () => {
    expect(SIBLING_FREE_KINDS).toHaveLength(13);
    expect(SIBLING_DEPENDENT_KINDS).toHaveLength(4);
    expect(new Set<string>([...SIBLING_FREE_KINDS, ...SIBLING_DEPENDENT_KINDS]).size).toBe(17);
  });

  it("files a case by every kind in its tree, not just the root", () => {
    const nested = CASES.find((c) => c.name.startsWith("withinEach over an offset"));
    expect(nested && groupOf(nested.selector)).toBe("siblingDependent");
    expect(groupOf(lastOfEach)).toBe("siblingFree");
  });
});

describe("synthetic fixture — the control", () => {
  it("passes every invariant and every case in both groups", () => {
    const report = runDomainConformance(makeSyntheticDomain(), { cases: CASES });
    expect(report.failures).toEqual([]);
    expect(report.invariants).toEqual(Object.keys(INVARIANTS));
    expect(report.entities).toHaveLength(12); // L + 3 playlists + 8 tracks
    expect(report.cases.siblingFree.length + report.cases.siblingDependent.length).toBe(
      CASES.length,
    );
  });

  it("the 13 sibling-free kinds never touch the sibling view", () => {
    // What M2 relies on: a binding whose sibling view is not settled yet can
    // still prove the 13. Here that view throws, and the run stays green.
    const noSiblings = broken(() => ({
      parentOf: () => {
        throw new Error("parentOf called");
      },
      siblingsOf: () => {
        throw new Error("siblingsOf called");
      },
    }));
    const report = runDomainConformance(noSiblings, { groups: ["siblingFree"], cases: CASES });
    expect(report.failures).toEqual([]);
    expect(report.invariants.every((id) => INVARIANTS[id].view === "core")).toBe(true);
    expect(report.cases.siblingDependent).toEqual([]);
  });
});

describe("inversion — the suite fails a wrong binding", () => {
  it("duplicate stable keys", () => {
    const d = broken((base) => ({
      stableKey: (r) => (r.key === "t2" ? "t1" : base.stableKey(r)),
    }));
    const report = runDomainConformance(d, { cases: CASES });
    expect(report.ok).toBe(false);
    expect(checks(report)).toEqual(expect.arrayContaining(["key-unique", "sequence-unique"]));
  });

  it("a sibling sequence that disagrees with the parent's ordered view", () => {
    // t7 claims p1's tracks as its siblings while its parent is still p2.
    const d = broken((base) => ({
      siblingsOf: (r) =>
        r.key === "t7"
          ? [...base.siblingsOf(base.byKey("t1") as FixtureEntity)]
          : base.siblingsOf(r),
    }));
    const report = runDomainConformance(d, { cases: CASES });
    expect(checks(report)).toEqual(
      expect.arrayContaining([
        "sibling-contains-self",
        "parent-children",
        "sibling-class",
        "parent-determines-siblings",
      ]),
    );
    // The same defect is invisible to a sibling-free run — which is the point
    // of the split, and why M2 must not stop at it.
    expect(runDomainConformance(d, { groups: ["siblingFree"], cases: CASES }).failures).toEqual([]);
  });

  it("a mixed-kind sibling sequence", () => {
    const d = broken((base) => ({
      siblingsOf: (r) =>
        r.kind === "track"
          ? [...base.siblingsOf(r), base.byKey("p3") as FixtureEntity]
          : base.siblingsOf(r),
    }));
    expect(checks(runDomainConformance(d, { cases: CASES }))).toContain("sibling-kind");
  });

  it("a field that lies about its declared type, and a catalog typo", () => {
    const d = broken((base) => ({
      fields: () => new Map([...base.fields(), ["ratng", "number"]]),
      readField: (r, f) => (f === "durationSec" ? String(r.durationSec) : base.readField(r, f)),
    }));
    const report = runDomainConformance(d, { cases: CASES });
    expect(checks(report)).toEqual(expect.arrayContaining(["field-type", "field-coverage"]));
    expect(report.failures.find((f) => f.check === "field-coverage")?.subject).toBe("ratng");
  });

  it("a scope whose members are not the kind it declares", () => {
    const d = broken((base) => ({
      scopeMembers: (n) =>
        n === "focusedPlaylist" ? base.scopeMembers("allTracks") : base.scopeMembers(n),
    }));
    expect(checks(runDomainConformance(d, { cases: CASES }))).toContain("scope-kind");
  });

  it("byKey inventing an entity for an absent key", () => {
    const d = broken((base) => ({ byKey: (k) => base.byKey(k) ?? base.byKey("t1") }));
    const report = runDomainConformance(d, { cases: CASES });
    expect(checks(report)).toEqual(expect.arrayContaining(["key-absent", "resolution"]));
  });

  it("an unstable ordering", () => {
    let flip = false;
    const d = broken((base) => ({
      scopeMembers: (n) => {
        flip = !flip;
        const m = base.scopeMembers(n);
        return flip ? m : [...m].reverse();
      },
    }));
    expect(checks(runDomainConformance(d, { cases: CASES }))).toContain("order-stable");
  });

  it("a missing node kind, and a wrong expectation", () => {
    const report = runDomainConformance(makeSyntheticDomain(), {
      cases: [
        ...CASES.filter((c) => c.selector.kind !== "sort"),
        { name: "wrong", selector: allTracks, expect: { keys: ["t8"] } },
      ],
    });
    expect(report.failures.map((f) => [f.check, f.subject])).toEqual([
      ["resolution", "wrong"],
      ["case-coverage", "siblingFree"],
    ]);
    expect(report.failures[1]?.message).toMatch(/sort$/);
  });
});
