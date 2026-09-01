/**
 * Structural validation, actionable-error mapping (spec §22.3), complexity
 * limits (§22.1), and semantic validation against the fixture domain.
 */

import { describe, expect, it } from "vitest";
import { ControlLanguageError } from "./errors.js";
import { makeSyntheticDomain } from "./fixture.js";
import { SELECTOR_SCHEMA_VERSION, type Selector, SelectorEnvelopeSchema } from "./schema.js";
import { analyzeComplexity, parseSelector, validateSelector } from "./validate.js";

const d = makeSyntheticDomain();

describe("parseSelector (structural)", () => {
  it("accepts a valid document and fills defaults", () => {
    const s = parseSelector({ kind: "ids", ids: ["t1"] });
    expect(s).toMatchObject({ kind: "ids", ids: ["t1"], missing: "error" });
  });

  it("rejects an unknown kind with a discriminator hint", () => {
    try {
      parseSelector({ kind: "grab", ids: ["t1"] });
      expect.unreachable();
    } catch (e) {
      const err = e as ControlLanguageError;
      expect(err.code).toBe("E_SCHEMA");
      expect(err.issues[0]?.hint).toMatch(/kind/);
    }
  });

  it("objects are closed: an undeclared property is rejected (spec §22.1)", () => {
    expect(() => parseSelector({ kind: "ids", ids: ["t1"], extra: true })).toThrow(
      ControlLanguageError,
    );
  });

  it("position 0 is rejected at the schema with a JSON path", () => {
    try {
      parseSelector({
        kind: "positions",
        scope: { kind: "scope", scope: "allTracks" },
        positions: [0],
      });
      expect.unreachable();
    } catch (e) {
      const err = e as ControlLanguageError;
      expect(err.code).toBe("E_SCHEMA");
      expect(err.issues.some((i) => i.path.includes("positions[0]"))).toBe(true);
    }
  });

  it("the envelope pins the schema version", () => {
    expect(
      SelectorEnvelopeSchema.safeParse({
        v: SELECTOR_SCHEMA_VERSION,
        selector: { kind: "ids", ids: ["t1"] },
      }).success,
    ).toBe(true);
    expect(
      SelectorEnvelopeSchema.safeParse({ v: 99, selector: { kind: "ids", ids: ["t1"] } }).success,
    ).toBe(false);
  });
});

describe("analyzeComplexity (documented limits)", () => {
  it("rejects nesting beyond maxDepth", () => {
    let s: Selector = { kind: "ids", ids: ["t1"] };
    for (let i = 0; i < 20; i += 1) s = { kind: "flatten", selector: s };
    try {
      analyzeComplexity(s);
      expect.unreachable();
    } catch (e) {
      expect((e as ControlLanguageError).code).toBe("E_COMPLEXITY");
    }
  });

  it("rejects node counts beyond maxNodes and lists beyond maxListLength", () => {
    const wide: Selector = {
      kind: "union",
      selectors: Array.from({ length: 10 }, (): Selector => ({ kind: "ids", ids: ["t1"] })),
    };
    expect(() =>
      analyzeComplexity(wide, { maxDepth: 16, maxNodes: 5, maxListLength: 1024 }),
    ).toThrow(/maxNodes/);
    expect(() =>
      analyzeComplexity(
        { kind: "ids", ids: Array.from({ length: 6 }, (_, i) => `k${i}`) },
        { maxDepth: 16, maxNodes: 256, maxListLength: 5 },
      ),
    ).toThrow(/maxListLength/);
  });

  it("passes a reasonable selector and reports its node count", () => {
    expect(
      analyzeComplexity({
        kind: "union",
        selectors: [
          { kind: "ids", ids: ["t1"] },
          { kind: "scope", scope: "allTracks" },
        ],
      }),
    ).toEqual({
      nodes: 3,
    });
  });
});

describe("validateSelector (semantic, against a domain)", () => {
  it("flags unknown scope / relation / field with hints listing the valid names", () => {
    const issues = validateSelector(
      {
        kind: "union",
        selectors: [
          { kind: "scope", scope: "nope" },
          {
            kind: "members",
            nodes: { kind: "scope", scope: "allPlaylists" },
            relation: "chapters",
          },
          {
            kind: "where",
            scope: { kind: "scope", scope: "allTracks" },
            predicate: { kind: "cmp", field: "bpm", op: "gt", value: 100 },
          },
        ],
      },
      d,
    );
    const codes = issues.map((i) => i.code).sort();
    expect(codes).toEqual(["E_UNKNOWN_FIELD", "E_UNKNOWN_RELATION", "E_UNKNOWN_SCOPE"]);
    expect(issues.every((i) => (i.hint ?? "").length > 0)).toBe(true);
    expect(issues[0]?.path).toContain("selectors[0]");
  });

  it("flags operator/type mismatches before resolution", () => {
    const issues = validateSelector(
      {
        kind: "where",
        scope: { kind: "scope", scope: "allTracks" },
        predicate: { kind: "cmp", field: "durationSec", op: "prefix", value: "1" },
      },
      d,
    );
    expect(issues[0]?.code).toBe("E_OP_TYPE_MISMATCH");
    expect(issues[0]?.hint).toContain("eq");
  });

  it("flags a scope-less leaf outside withinEach, and accepts it inside", () => {
    expect(validateSelector({ kind: "positions", positions: [1] }, d)[0]?.code).toBe(
      "E_SCOPE_REQUIRED",
    );
    expect(
      validateSelector(
        {
          kind: "withinEach",
          branches: { kind: "scope", scope: "allPlaylists" },
          relation: "tracks",
          select: { kind: "positions", positions: [1] },
        },
        d,
      ),
    ).toEqual([]);
  });
});
