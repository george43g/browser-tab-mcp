/**
 * PlanStore — same lifecycle contract as SelectionStore, plus the risk class
 * riding the record (apply gates on it in PR-E).
 */

import { describe, expect, it } from "vitest";
import { PlanStore } from "./plans.js";

const plan = (token: string) => ({
  riskClass: "live-layout" as const,
  effects: [],
  warnings: [],
  selectionKeys: ["t:chrome:x1"],
  snapshotToken: token,
});

describe("PlanStore", () => {
  it("materializes and reads back non-stale under the same token", () => {
    const store = new PlanStore();
    const p = store.materialize(plan("aa11:5"));
    expect(p.planId).toMatch(/^[0-9a-f]{8}$/);
    const got = store.get(p.planId, "aa11:5");
    expect(got?.riskClass).toBe("live-layout");
    expect(got?.stale).toBe(false);
  });

  it("marks stale on token movement", () => {
    const store = new PlanStore();
    const p = store.materialize(plan("aa11:5"));
    expect(store.get(p.planId, "aa11:6")?.stale).toBe(true);
  });

  it("expiry and unknown read identically", () => {
    let t = 0;
    const store = new PlanStore({ ttlMs: 1_000, now: () => t });
    const p = store.materialize(plan("aa11:5"));
    t = 1_001;
    expect(store.get(p.planId, "aa11:5")).toBeUndefined();
    expect(store.get("ffffffff", "aa11:5")).toBeUndefined();
  });

  it("evicts oldest-first at capacity", () => {
    const store = new PlanStore({ capacity: 1 });
    const a = store.materialize(plan("t:1"));
    const b = store.materialize(plan("t:1"));
    expect(store.get(a.planId, "t:1")).toBeUndefined();
    expect(store.get(b.planId, "t:1")).toBeDefined();
  });
});
