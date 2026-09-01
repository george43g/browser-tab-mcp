/**
 * Property-based laws for the ordered-set algebra (spec §7.7), checked with
 * fast-check against independent reference implementations over plain key
 * arrays. Selections are modelled as `ids` selectors drawn from the fixture's
 * track pool, so every law runs through the REAL resolver.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { keysOf } from "./domain.js";
import { makeSyntheticDomain } from "./fixture.js";
import { normalizeSelector } from "./normalize.js";
import { resolveSelector } from "./resolve.js";
import type { Selector } from "./schema.js";

const d = makeSyntheticDomain();
const POOL = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"] as const;

const arbKeys = fc.array(fc.constantFrom(...POOL), { minLength: 1, maxLength: 12 });
const ids = (list: readonly string[]): Selector => ({ kind: "ids", ids: [...list] });
const keys = (s: Selector) => keysOf(resolveSelector(s, d));

/** Reference: order-preserving dedupe. */
const uniq = (xs: readonly string[]) => [...new Set(xs)];

describe("ordered-set algebra laws", () => {
  it("resolution dedupes by stable identity, first occurrence wins", () => {
    fc.assert(
      fc.property(arbKeys, (a) => {
        expect(keys(ids(a))).toEqual(uniq(a));
      }),
    );
  });

  it("union is left-biased: A ++ (B \\ A), pairwise", () => {
    fc.assert(
      fc.property(arbKeys, arbKeys, (a, b) => {
        const ua = uniq(a);
        const expected = [...ua, ...uniq(b).filter((k) => !ua.includes(k))];
        expect(keys({ kind: "union", selectors: [ids(a), ids(b)] })).toEqual(expected);
      }),
    );
  });

  it("union order is associative: union(union(A,B),C) === union(A,B,C) === union(A,union(B,C))", () => {
    fc.assert(
      fc.property(arbKeys, arbKeys, arbKeys, (a, b, c) => {
        const nested1 = keys({
          kind: "union",
          selectors: [{ kind: "union", selectors: [ids(a), ids(b)] }, ids(c)],
        });
        const nested2 = keys({
          kind: "union",
          selectors: [ids(a), { kind: "union", selectors: [ids(b), ids(c)] }],
        });
        const flat = keys({ kind: "union", selectors: [ids(a), ids(b), ids(c)] });
        expect(nested1).toEqual(flat);
        expect(nested2).toEqual(flat);
      }),
    );
  });

  it("intersection keeps A's ordering and only common members", () => {
    fc.assert(
      fc.property(arbKeys, arbKeys, (a, b) => {
        const setB = new Set(b);
        expect(keys({ kind: "intersect", selectors: [ids(a), ids(b)] })).toEqual(
          uniq(a).filter((k) => setB.has(k)),
        );
      }),
    );
  });

  it("subtraction keeps `from` ordering minus `remove` members", () => {
    fc.assert(
      fc.property(arbKeys, arbKeys, (a, b) => {
        const setB = new Set(b);
        expect(keys({ kind: "subtract", from: ids(a), remove: ids(b) })).toEqual(
          uniq(a).filter((k) => !setB.has(k)),
        );
      }),
    );
  });

  it("complement uses the scope's order: complement(S, within) === within \\ S", () => {
    fc.assert(
      fc.property(arbKeys, (a) => {
        const setA = new Set(a);
        expect(
          keys({
            kind: "complement",
            selector: ids(a),
            within: { kind: "scope", scope: "allTracks" },
          }),
        ).toEqual(POOL.filter((k) => !setA.has(k)));
      }),
    );
  });

  it("subtract(union(A,B), B) contains exactly A's members not in B, in A-then-B order", () => {
    fc.assert(
      fc.property(arbKeys, arbKeys, (a, b) => {
        const got = keys({
          kind: "subtract",
          from: { kind: "union", selectors: [ids(a), ids(b)] },
          remove: ids(b),
        });
        const setB = new Set(b);
        expect(got).toEqual(uniq(a).filter((k) => !setB.has(k)));
      }),
    );
  });
});

/** Small recursive selector generator for the normalization law. */
const arbSelector: fc.Arbitrary<Selector> = fc.letrec<{ sel: Selector }>((tie) => ({
  sel: fc.oneof(
    { maxDepth: 4, withCrossShrink: true },
    arbKeys.map(ids),
    fc.constant<Selector>({ kind: "scope", scope: "allTracks" }),
    fc
      .tuple(tie("sel"), tie("sel"))
      .map(([a, b]): Selector => ({ kind: "union", selectors: [a, b] })),
    fc
      .tuple(tie("sel"), tie("sel"))
      .map(([a, b]): Selector => ({ kind: "intersect", selectors: [a, b] })),
    fc
      .tuple(tie("sel"), tie("sel"))
      .map(([a, b]): Selector => ({ kind: "subtract", from: a, remove: b })),
    fc
      .tuple(
        tie("sel"),
        fc.integer({ min: -9, max: 9 }).filter((n) => n !== 0),
        fc.integer({ min: -9, max: 9 }).filter((n) => n !== 0),
      )
      .map(([s, from, to]): Selector => ({ kind: "slice", selector: s, range: { from, to } })),
    tie("sel").map(
      (s): Selector => ({ kind: "sort", selector: s, by: [{ field: "durationSec" }] }),
    ),
  ),
})).sel;

describe("normalization preserves semantics", () => {
  it("resolve(normalize(s)) ≡ resolve(s)", () => {
    fc.assert(
      fc.property(arbSelector, (s) => {
        expect(keys(normalizeSelector(s))).toEqual(keys(s));
      }),
      { numRuns: 200 },
    );
  });

  it("normalization is idempotent", () => {
    fc.assert(
      fc.property(arbSelector, (s) => {
        const once = normalizeSelector(s);
        expect(normalizeSelector(once)).toEqual(once);
      }),
      { numRuns: 200 },
    );
  });
});
