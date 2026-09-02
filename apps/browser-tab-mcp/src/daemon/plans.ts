/**
 * Materialized plans — DSL Phase 3 PR-C. Same lifecycle contract as
 * SelectionStore (selections.ts): snapshot-bound via token inequality,
 * short-lived, expiry and unknown deliberately indistinguishable. A stale
 * plan REFUSES apply (PR-E) rather than re-planning silently — spec §14.1's
 * conflict:"error" default.
 */

import { randomBytes } from "node:crypto";
import type { Effect, RiskClass } from "../select/plan/effects.js";

export interface MaterializedPlan {
  planId: string;
  riskClass: RiskClass;
  effects: Effect[];
  warnings: string[];
  /** Ordered stable keys of the selection the plan was computed from. */
  selectionKeys: string[];
  snapshotToken: string;
  createdAt: number;
  /**
   * The validated transform (+ pinPolicy) the plan compiled, kept so
   * conflict:"replan" (PR-I) can re-plan the SAME intent over the stored
   * selectionKeys. Additive; absent on records from older callers.
   */
  transform?: unknown;
  pinPolicy?: "skip" | undefined;
}

export interface PlanStoreOptions {
  capacity?: number;
  ttlMs?: number;
  now?: () => number;
}

export class PlanStore {
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly records = new Map<string, MaterializedPlan>();

  constructor(opts: PlanStoreOptions = {}) {
    this.capacity = opts.capacity ?? 32;
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  materialize(input: Omit<MaterializedPlan, "planId" | "createdAt">): MaterializedPlan {
    const rec: MaterializedPlan = {
      ...input,
      planId: randomBytes(4).toString("hex"),
      createdAt: this.now(),
    };
    this.records.set(rec.planId, rec);
    while (this.records.size > this.capacity) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
    return rec;
  }

  get(
    planId: string,
    currentSnapshotToken: string | undefined,
  ): (MaterializedPlan & { stale: boolean }) | undefined {
    const rec = this.records.get(planId);
    if (rec === undefined) return undefined;
    if (this.now() - rec.createdAt > this.ttlMs) {
      this.records.delete(planId);
      return undefined;
    }
    return { ...rec, stale: rec.snapshotToken !== currentSnapshotToken };
  }
}
