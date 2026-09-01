import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ControlLanguageError } from "./errors.js";
import { resolveAbsolute, resolveOffsets, resolveRange } from "./positions.js";

describe("resolveAbsolute (spec §5.1)", () => {
  it("is one-based: 1 = first, -1 = last", () => {
    expect(resolveAbsolute(1, 5, "error", "$")).toBe(0);
    expect(resolveAbsolute(5, 5, "error", "$")).toBe(4);
    expect(resolveAbsolute(-1, 5, "error", "$")).toBe(4);
    expect(resolveAbsolute(-5, 5, "error", "$")).toBe(0);
  });

  it("rejects 0 even under clamp", () => {
    expect(() => resolveAbsolute(0, 5, "clamp", "$")).toThrow(ControlLanguageError);
  });

  it("clamps to the nearest boundary by default (spec: 100 → 5, -100 → 1)", () => {
    expect(resolveAbsolute(100, 5, "clamp", "$")).toBe(4);
    expect(resolveAbsolute(-100, 5, "clamp", "$")).toBe(0);
  });

  it('bounds:"error" rejects out-of-range with E_OUT_OF_RANGE', () => {
    try {
      resolveAbsolute(6, 5, "error", "$");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ControlLanguageError);
      expect((e as ControlLanguageError).code).toBe("E_OUT_OF_RANGE");
    }
  });

  it("empty sequence: clamp → undefined, error → throws", () => {
    expect(resolveAbsolute(1, 0, "clamp", "$")).toBeUndefined();
    expect(() => resolveAbsolute(1, 0, "error", "$")).toThrow(ControlLanguageError);
  });

  it("property: negative positions mirror positives — -k ≡ len-k+1", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60 }), fc.integer({ min: 1, max: 60 }), (len, k) => {
        fc.pre(k <= len);
        expect(resolveAbsolute(-k, len, "error", "$")).toBe(
          resolveAbsolute(len - k + 1, len, "error", "$"),
        );
      }),
    );
  });

  it("property: clamp always lands inside the sequence and never wraps", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: 1, max: 40 }),
        (pos, len) => {
          fc.pre(pos !== 0);
          const idx = resolveAbsolute(pos, len, "clamp", "$") as number;
          expect(idx).toBeGreaterThanOrEqual(0);
          expect(idx).toBeLessThan(len);
          // no wrapping: a big positive stays at the END boundary, big negative at the START
          if (pos > len) expect(idx).toBe(len - 1);
          if (pos < -len) expect(idx).toBe(0);
        },
      ),
    );
  });
});

describe("resolveRange (spec §5.3)", () => {
  it("is inclusive and preserves direction", () => {
    expect(resolveRange(1, 3, 5, "error", "$")).toEqual([0, 1, 2]);
    expect(resolveRange(3, -1, 5, "error", "$")).toEqual([2, 3, 4]);
    expect(resolveRange(1, -2, 5, "error", "$")).toEqual([0, 1, 2, 3]);
    expect(resolveRange(-5, -1, 5, "error", "$")).toEqual([0, 1, 2, 3, 4]);
  });

  it("a descending range keeps its reverse order — not normalized", () => {
    expect(resolveRange(-1, 1, 5, "error", "$")).toEqual([4, 3, 2, 1, 0]);
    expect(resolveRange(4, 2, 5, "error", "$")).toEqual([3, 2, 1]);
  });

  it("property: reversing endpoints reverses the walk", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: -30, max: 30 }),
        fc.integer({ min: -30, max: 30 }),
        (len, a, b) => {
          fc.pre(a !== 0 && b !== 0);
          const fwd = resolveRange(a, b, len, "clamp", "$");
          const rev = resolveRange(b, a, len, "clamp", "$");
          expect(rev).toEqual([...fwd].reverse());
        },
      ),
    );
  });
});

describe("resolveOffsets (spec §5.2)", () => {
  it("is zero-based: 0 = anchor; clips, never wraps", () => {
    expect(resolveOffsets(2, -1, 1, 5)).toEqual([1, 2, 3]);
    expect(resolveOffsets(0, -2, 1, 5)).toEqual([0, 1]);
    expect(resolveOffsets(4, 0, 3, 5)).toEqual([4]);
  });

  it("preserves a descending offset walk", () => {
    expect(resolveOffsets(2, 1, -1, 5)).toEqual([3, 2, 1]);
  });

  it("property: results always stay inside the sequence (clip, no wrap)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: -25, max: 25 }),
        fc.integer({ min: -25, max: 25 }),
        fc.integer({ min: 1, max: 21 }),
        (anchor, from, to, len) => {
          fc.pre(anchor < len);
          for (const i of resolveOffsets(anchor, from, to, len)) {
            expect(i).toBeGreaterThanOrEqual(0);
            expect(i).toBeLessThan(len);
          }
        },
      ),
    );
  });
});
