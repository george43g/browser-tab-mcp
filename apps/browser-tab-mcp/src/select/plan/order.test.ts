/**
 * relocationsFor — correctness AND minimality, each against an independent
 * reference: correctness by simulating the after-chain onto the current
 * strip, minimality against an O(n²) reference LIS. The randomized block
 * uses a seeded PRNG (no flake, reproducible) over permutations up to 12
 * tabs plus incoming members.
 */

import { describe, expect, it } from "vitest";
import type { RelocateEffect } from "./effects.js";
import { relocationsFor } from "./order.js";

/** Apply an after-chained relocation sequence to a strip — the executor's
 *  semantics in miniature. Incoming tabs are inserted, residents moved. */
function simulate(current: readonly string[], effects: readonly RelocateEffect[]): string[] {
  const strip = [...current];
  for (const e of effects) {
    const from = strip.indexOf(e.tabId);
    if (from >= 0) strip.splice(from, 1);
    if (e.after === null) {
      strip.unshift(e.tabId);
    } else {
      const at = strip.indexOf(e.after);
      if (at < 0) throw new Error(`chain broken: after=${e.after} not present`);
      strip.splice(at + 1, 0, e.tabId);
    }
  }
  return strip;
}

/** O(n²) reference LIS length. */
function refLisLen(pos: readonly number[]): number {
  const dp = pos.map(() => 1);
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < i; j++) {
      if ((pos[j] as number) < (pos[i] as number)) {
        dp[i] = Math.max(dp[i] as number, (dp[j] as number) + 1);
      }
    }
  }
  return dp.length === 0 ? 0 : Math.max(...dp);
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = "w:chrome:x1";

describe("relocationsFor", () => {
  it("identity order produces zero effects", () => {
    expect(relocationsFor(["a", "b", "c"], ["a", "b", "c"], W)).toEqual([]);
  });

  it("one displaced tab produces exactly one effect", () => {
    const fx = relocationsFor(["a", "b", "c", "d"], ["b", "c", "d", "a"], W);
    expect(fx).toHaveLength(1);
    expect(fx[0]).toEqual({ kind: "relocate", tabId: "a", targetWindowId: W, after: "d" });
    expect(simulate(["a", "b", "c", "d"], fx)).toEqual(["b", "c", "d", "a"]);
  });

  it("front landing uses after: null", () => {
    const fx = relocationsFor(["a", "b", "c"], ["c", "a", "b"], W);
    expect(fx).toEqual([{ kind: "relocate", tabId: "c", targetWindowId: W, after: null }]);
  });

  it("incoming tabs always relocate even when already 'in order'", () => {
    const fx = relocationsFor(["a", "b"], ["a", "x", "b"], W);
    expect(fx).toEqual([{ kind: "relocate", tabId: "x", targetWindowId: W, after: "a" }]);
    expect(simulate(["a", "b"], fx)).toEqual(["a", "x", "b"]);
  });

  it("rejects a desired order that drops a resident tab", () => {
    expect(() => relocationsFor(["a", "b", "c"], ["a", "b"], W)).toThrow(/every current tab/);
  });

  it("rejects duplicates on either side", () => {
    expect(() => relocationsFor(["a", "a"], ["a", "a"], W)).toThrow(/exactly once/);
    expect(() => relocationsFor(["a", "b"], ["a", "b", "b"], W)).toThrow(/exactly once/);
  });

  it("randomized: simulation matches desired and effect count is LIS-minimal", () => {
    const rand = rng(0xb70b5);
    for (let iter = 0; iter < 60; iter++) {
      const n = 1 + Math.floor(rand() * 12);
      const incoming = Math.floor(rand() * 3);
      const current = Array.from({ length: n }, (_, i) => `t${i}`);
      const pool = [...current, ...Array.from({ length: incoming }, (_, i) => `in${i}`)];
      // Fisher–Yates on the pool = desired arrangement.
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const tmp = pool[i] as string;
        pool[i] = pool[j] as string;
        pool[j] = tmp;
      }
      const fx = relocationsFor(current, pool, W);
      expect(simulate(current, fx), `iter ${iter}`).toEqual(pool);
      // Minimality: residents kept = reference LIS of their desired positions.
      const curIdx = new Map(current.map((id, i) => [id, i]));
      const residentPos = pool.filter((id) => curIdx.has(id)).map((id) => curIdx.get(id) as number);
      const expected = pool.length - refLisLen(residentPos);
      expect(fx.length, `iter ${iter} minimality`).toBe(expected);
    }
  });
});
