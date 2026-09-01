/**
 * SelectionStore — materialized selections are snapshot-bound and short-lived.
 * The load-bearing assertions: staleness is TOKEN inequality (never id reuse
 * across boots — the token's bootId covers that), expiry and unknown are
 * indistinguishable on purpose, and eviction is oldest-first.
 */

import { describe, expect, it } from "vitest";
import { SelectionStore } from "./selections.js";

const rec = (keys: string[], token: string) => ({
  kind: "tab",
  keys,
  snapshotToken: token,
  warnings: [],
});

describe("SelectionStore", () => {
  it("materializes with a fresh id and reads back non-stale under the same token", () => {
    const store = new SelectionStore();
    const m = store.materialize(rec(["t:chrome:x1"], "aa11:5"));
    expect(m.selectionId).toMatch(/^[0-9a-f]{8}$/);
    const got = store.get(m.selectionId, "aa11:5");
    expect(got?.keys).toEqual(["t:chrome:x1"]);
    expect(got?.stale).toBe(false);
  });

  it("marks stale when the current token moved — equality only, no ordering", () => {
    const store = new SelectionStore();
    const m = store.materialize(rec(["t:chrome:x1"], "aa11:5"));
    expect(store.get(m.selectionId, "aa11:6")?.stale).toBe(true);
    expect(store.get(m.selectionId, undefined)?.stale).toBe(true);
  });

  it("expiry and unknown-id read identically (both mean re-select)", () => {
    let t = 0;
    const store = new SelectionStore({ ttlMs: 1_000, now: () => t });
    const m = store.materialize(rec(["t:chrome:x1"], "aa11:5"));
    t = 1_001;
    expect(store.get(m.selectionId, "aa11:5")).toBeUndefined();
    expect(store.get("ffffffff", "aa11:5")).toBeUndefined();
  });

  it("evicts oldest-first at capacity", () => {
    const store = new SelectionStore({ capacity: 2 });
    const a = store.materialize(rec(["a"], "t:1"));
    const b = store.materialize(rec(["b"], "t:1"));
    const c = store.materialize(rec(["c"], "t:1"));
    expect(store.get(a.selectionId, "t:1")).toBeUndefined();
    expect(store.get(b.selectionId, "t:1")?.keys).toEqual(["b"]);
    expect(store.get(c.selectionId, "t:1")?.keys).toEqual(["c"]);
  });
});
