/**
 * Fixture-driven semantics for the resolver, against the synthetic music
 * library (see fixture.ts for the shape: p1 t1..t5, p2 t6..t8, p3 empty).
 */

import { describe, expect, it } from "vitest";
import { keysOf } from "./domain.js";
import { ControlLanguageError } from "./errors.js";
import { makeSyntheticDomain } from "./fixture.js";
import { resolveSelector } from "./resolve.js";
import type { Selector } from "./schema.js";

const d = makeSyntheticDomain();
const keys = (s: Selector) => keysOf(resolveSelector(s, d));
const ids = (...list: string[]): Selector => ({ kind: "ids", ids: list });
const allTracks: Selector = { kind: "scope", scope: "allTracks" };
const allPlaylists: Selector = { kind: "scope", scope: "allPlaylists" };

describe("identity and scope selectors", () => {
  it("ids keeps list order and dedupes by stable identity", () => {
    expect(keys(ids("t3", "t1", "t3", "t8"))).toEqual(["t3", "t1", "t8"]);
  });

  it("ids with an unknown key errors with E_UNKNOWN_ID by default", () => {
    try {
      keys(ids("t1", "ghost"));
      expect.unreachable();
    } catch (e) {
      expect((e as ControlLanguageError).code).toBe("E_UNKNOWN_ID");
      expect((e as ControlLanguageError).path).toBe("$.ids[1]");
    }
  });

  it('ids missing:"skip" drops the key and records a warning', () => {
    const r = resolveSelector({ kind: "ids", ids: ["t1", "ghost"], missing: "skip" }, d);
    expect(keysOf(r)).toEqual(["t1"]);
    expect(r.warnings.some((w) => w.includes('"ghost"'))).toBe(true);
  });

  it("ids mixing kinds is rejected — no silent coercion", () => {
    expect(() => keys(ids("p1", "t1"))).toThrow(/mixes kinds/);
  });

  it("named scopes resolve in domain order and carry the declared kind", () => {
    const r = resolveSelector(allTracks, d);
    expect(keysOf(r)).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"]);
    expect(r.kind).toBe("track");
    expect(() => keys({ kind: "scope", scope: "nope" })).toThrow(/not declared/);
  });
});

describe("explicit member projection (spec §24.1)", () => {
  it("members expands structural nodes to ordered members, tagging branch provenance", () => {
    const r = resolveSelector({ kind: "members", nodes: allPlaylists, relation: "tracks" }, d);
    expect(keysOf(r)).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"]);
    expect(r.kind).toBe("track");
    expect(r.occurrences[0]?.branchPath).toEqual(["p1"]);
    expect(r.occurrences[5]?.branchPath).toEqual(["p2"]);
  });

  it("a relation that does not apply to the selected kind is E_RELATION_INAPPLICABLE", () => {
    try {
      keys({ kind: "members", nodes: allTracks, relation: "tracks" });
      expect.unreachable();
    } catch (e) {
      expect((e as ControlLanguageError).code).toBe("E_RELATION_INAPPLICABLE");
    }
  });

  it("algebra over mixed kinds is E_KIND_MISMATCH — projection is never inferred", () => {
    try {
      keys({ kind: "union", selectors: [allPlaylists, allTracks] });
      expect.unreachable();
    } catch (e) {
      expect((e as ControlLanguageError).code).toBe("E_KIND_MISMATCH");
    }
  });
});

describe("positions (spec §5)", () => {
  const p1Tracks: Selector = { kind: "members", nodes: ids("p1"), relation: "tracks" };

  it("signed one-based positions with mixed discrete list", () => {
    expect(
      keys({ kind: "positions", scope: p1Tracks, positions: [1, -1, { from: 2, to: 3 }] }),
    ).toEqual(["t1", "t5", "t2", "t3"]);
  });

  it("descending range preserves reverse order", () => {
    expect(keys({ kind: "positions", scope: p1Tracks, positions: [{ from: -1, to: 1 }] })).toEqual([
      "t5",
      "t4",
      "t3",
      "t2",
      "t1",
    ]);
  });

  it("clamp is the default and records a warning; error rejects", () => {
    const r = resolveSelector({ kind: "positions", scope: p1Tracks, positions: [100] }, d);
    expect(keysOf(r)).toEqual(["t5"]);
    expect(r.warnings.some((w) => w.includes("clamped"))).toBe(true);
    expect(() =>
      keys({ kind: "positions", scope: p1Tracks, positions: [100], bounds: "error" }),
    ).toThrow(/out of range/);
  });

  it("a scope-less positions node outside withinEach is E_SCOPE_REQUIRED", () => {
    try {
      keys({ kind: "positions", positions: [1] });
      expect.unreachable();
    } catch (e) {
      expect((e as ControlLanguageError).code).toBe("E_SCOPE_REQUIRED");
    }
  });
});

describe("relative selectors", () => {
  it("offset selects a neighbourhood in sibling order; anchor at 0", () => {
    expect(keys({ kind: "offset", anchor: ids("t3"), offsets: { from: -1, to: 1 } })).toEqual([
      "t2",
      "t3",
      "t4",
    ]);
  });

  it("offset requires a singular anchor", () => {
    try {
      keys({ kind: "offset", anchor: ids("t1", "t2"), offsets: { from: 0, to: 0 } });
      expect.unreachable();
    } catch (e) {
      expect((e as ControlLanguageError).code).toBe("E_ANCHOR_NOT_SINGULAR");
    }
  });

  it("offset clipping at a boundary records a warning", () => {
    const r = resolveSelector(
      { kind: "offset", anchor: ids("t1"), offsets: { from: -2, to: 0 } },
      d,
    );
    expect(keysOf(r)).toEqual(["t1"]);
    expect(r.warnings.some((w) => w.includes("clipped"))).toBe(true);
  });

  it("expand includes each member's neighbourhood, deduplicated first-seen", () => {
    expect(
      keys({ kind: "expand", selector: ids("t1", "t5"), offsets: { from: 0, to: 1 } }),
    ).toEqual(["t1", "t2", "t5"]);
    expect(
      keys({ kind: "expand", selector: ids("t2", "t3"), offsets: { from: -1, to: 1 } }),
    ).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("between selects the anchor-bounded run, preserving anchor direction", () => {
    expect(keys({ kind: "between", anchors: [ids("t2"), ids("t4")] })).toEqual(["t2", "t3", "t4"]);
    expect(keys({ kind: "between", anchors: [ids("t4"), ids("t2")] })).toEqual(["t4", "t3", "t2"]);
    expect(keys({ kind: "between", anchors: [ids("t2"), ids("t4")], inclusive: false })).toEqual([
      "t3",
    ]);
  });

  it("between across parents fails — never silently flattens (spec §7.4)", () => {
    try {
      keys({ kind: "between", anchors: [ids("t2"), ids("t7")] });
      expect.unreachable();
    } catch (e) {
      expect((e as ControlLanguageError).code).toBe("E_NO_COMMON_PARENT");
    }
  });

  it("siblings returns each member's full ordered sibling run", () => {
    expect(keys({ kind: "siblings", selector: ids("t7") })).toEqual(["t6", "t7", "t8"]);
  });
});

describe("predicates (spec §7.5 / §24.6)", () => {
  it("filters preserve scope order", () => {
    expect(
      keys({
        kind: "where",
        scope: allTracks,
        predicate: { kind: "cmp", field: "liked", op: "eq", value: true },
      }),
    ).toEqual(["t1", "t3", "t5", "t7"]);
  });

  it('unknown field values are EXCLUDED by default — "not visited within 3d" must not include unknowns', () => {
    // t7/t8 have no rating: excluded from BOTH the predicate and its negation.
    expect(
      keys({
        kind: "where",
        scope: allTracks,
        predicate: { kind: "cmp", field: "rating", op: "gt", value: 3 },
      }),
    ).toEqual(["t1", "t3", "t5", "t6"]);
    expect(
      keys({
        kind: "where",
        scope: allTracks,
        predicate: { kind: "not", predicate: { kind: "cmp", field: "rating", op: "gt", value: 3 } },
      }),
    ).toEqual(["t2", "t4"]);
  });

  it('unknown:"error" rejects instead', () => {
    try {
      keys({
        kind: "where",
        scope: allTracks,
        predicate: { kind: "cmp", field: "rating", op: "gt", value: 3 },
        unknown: "error",
      });
      expect.unreachable();
    } catch (e) {
      expect((e as ControlLanguageError).code).toBe("E_UNKNOWN_FIELD_VALUE");
    }
  });

  it("glob and regex operate on string fields; exists tests availability", () => {
    expect(
      keys({
        kind: "where",
        scope: allTracks,
        predicate: { kind: "cmp", field: "title", op: "glob", value: "Alpha*" },
      }),
    ).toEqual(["t1", "t5"]);
    expect(
      keys({
        kind: "where",
        scope: allTracks,
        predicate: { kind: "cmp", field: "title", op: "regex", value: "^(Sprint|Lift)$" },
      }),
    ).toEqual(["t6", "t7"]);
    expect(
      keys({
        kind: "where",
        scope: allTracks,
        predicate: { kind: "not", predicate: { kind: "exists", field: "rating" } },
      }),
    ).toEqual(["t7", "t8"]);
  });

  it("an invalid regex is E_INVALID_REGEX", () => {
    try {
      keys({
        kind: "where",
        scope: allTracks,
        predicate: { kind: "cmp", field: "title", op: "regex", value: "(" },
      });
      expect.unreachable();
    } catch (e) {
      expect((e as ControlLanguageError).code).toBe("E_INVALID_REGEX");
    }
  });
});

describe("sort and slice", () => {
  it("sort is stable and undefined values sort last in either direction", () => {
    expect(
      keys({ kind: "sort", selector: allTracks, by: [{ field: "rating", direction: "desc" }] }),
    ).toEqual([
      "t1", // 5
      "t5", // 5 (stable after t1)
      "t3", // 4
      "t6", // 4 (stable after t3)
      "t2", // 3
      "t4", // 2
      "t7", // undefined, last, stable
      "t8",
    ]);
    expect(keys({ kind: "sort", selector: allTracks, by: [{ field: "rating" }] })).toEqual([
      "t4",
      "t2",
      "t3",
      "t6",
      "t1",
      "t5",
      "t7",
      "t8",
    ]);
  });

  it("slice applies signed inclusive ranges over the resolved order", () => {
    expect(keys({ kind: "slice", selector: allTracks, range: { from: 2, to: -2 } })).toEqual([
      "t2",
      "t3",
      "t4",
      "t5",
      "t6",
      "t7",
    ]);
    expect(keys({ kind: "slice", selector: allTracks, range: { from: -1, to: -3 } })).toEqual([
      "t8",
      "t7",
      "t6",
    ]);
  });
});

describe("set algebra determinism (spec §7.7)", () => {
  it("union is left-biased: A then unseen members of B", () => {
    expect(keys({ kind: "union", selectors: [ids("t3", "t1"), ids("t1", "t2")] })).toEqual([
      "t3",
      "t1",
      "t2",
    ]);
  });

  it("intersection retains the first operand's ordering", () => {
    expect(keys({ kind: "intersect", selectors: [ids("t5", "t1", "t3"), allTracks] })).toEqual([
      "t5",
      "t1",
      "t3",
    ]);
  });

  it("subtraction retains `from` ordering; roles are explicit", () => {
    expect(
      keys({
        kind: "subtract",
        from: allTracks,
        remove: {
          kind: "where",
          scope: allTracks,
          predicate: { kind: "cmp", field: "liked", op: "eq", value: true },
        },
      }),
    ).toEqual(["t2", "t4", "t6", "t8"]);
  });

  it("complement uses the declared finite scope's order", () => {
    expect(
      keys({
        kind: "complement",
        selector: {
          kind: "where",
          scope: allTracks,
          predicate: { kind: "cmp", field: "liked", op: "eq", value: true },
        },
        within: allTracks,
      }),
    ).toEqual(["t2", "t4", "t6", "t8"]);
  });
});

describe("withinEach vs flatten (spec §24.2 — observably different)", () => {
  it("withinEach evaluates per branch: the LAST TRACK OF EACH playlist", () => {
    const r = resolveSelector(
      {
        kind: "withinEach",
        branches: allPlaylists,
        relation: "tracks",
        select: { kind: "positions", positions: [-1] },
      },
      d,
    );
    expect(keysOf(r)).toEqual(["t5", "t8"]); // p3 is empty and contributes nothing
    expect(r.occurrences.map((o) => o.branchPath)).toEqual([["p1"], ["p2"]]);
  });

  it("the flattened combined sequence gives ONE last track", () => {
    expect(
      keys({
        kind: "positions",
        scope: {
          kind: "flatten",
          selector: { kind: "members", nodes: allPlaylists, relation: "tracks" },
        },
        positions: [-1],
      }),
    ).toEqual(["t8"]);
  });

  it("scope-less where inside withinEach binds to the branch members", () => {
    expect(
      keys({
        kind: "withinEach",
        branches: allPlaylists,
        relation: "tracks",
        select: {
          kind: "where",
          predicate: { kind: "cmp", field: "liked", op: "eq", value: true },
        },
      }),
    ).toEqual(["t1", "t3", "t5", "t7"]);
  });

  it("flatten erases provenance without changing order", () => {
    const base: Selector = { kind: "members", nodes: allPlaylists, relation: "tracks" };
    const flat = resolveSelector({ kind: "flatten", selector: base }, d);
    expect(keysOf(flat)).toEqual(keys(base));
    expect(flat.occurrences.every((o) => o.branchPath.length === 0)).toBe(true);
  });
});
