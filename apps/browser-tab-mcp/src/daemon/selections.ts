/**
 * Materialized selections — DSL Phase 2 PR-B
 * (docs/agent-handoff/plans/2026-09-02-dsl-phase-2-browser-binding.md).
 *
 * A materialized selection is an immutable, short-lived record of ONE
 * resolution: the ordered stable keys plus the snapshotToken they were
 * resolved against (spec §26.3). It is snapshot-bound by construction —
 * NEVER durable identity (spec §23.1 gap 2): a record read back under a
 * different token is handed over marked `stale`, and Phase 3's planner
 * refuses to act on a stale one rather than re-resolving silently.
 *
 * In-daemon memory only. A daemon restart drops the store AND changes the
 * snapshotToken's bootId, so an id surviving in a caller's hand cannot be
 * confused with a live one — `get` simply misses.
 */

import { randomBytes } from "node:crypto";

export interface MaterializedSelection {
  selectionId: string;
  /** Result kind every member shares ("tab" | "window" | "group" | "browser"). */
  kind: string;
  /** Ordered stable keys (opaque handles) at resolution time. */
  keys: string[];
  /** The snapshotToken the resolution ran against. */
  snapshotToken: string;
  /** Resolution warnings, carried so later readers see what the caller saw. */
  warnings: string[];
  createdAt: number;
}

export interface SelectionStoreOptions {
  /** Max records held; oldest evicted first. Default 64. */
  capacity?: number;
  /** Per-record lifetime in ms. Default 5 minutes. */
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class SelectionStore {
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  /** Insertion-ordered (Map preserves it) — eviction pops the oldest key. */
  private readonly records = new Map<string, MaterializedSelection>();

  constructor(opts: SelectionStoreOptions = {}) {
    this.capacity = opts.capacity ?? 64;
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  materialize(
    input: Omit<MaterializedSelection, "selectionId" | "createdAt">,
  ): MaterializedSelection {
    const rec: MaterializedSelection = {
      ...input,
      selectionId: randomBytes(4).toString("hex"),
      createdAt: this.now(),
    };
    this.records.set(rec.selectionId, rec);
    while (this.records.size > this.capacity) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
    return rec;
  }

  /**
   * Look up a materialized selection. `stale` compares the record's token
   * against the CURRENT one — equality only, per the token contract. An
   * expired or unknown id returns undefined (indistinguishable on purpose:
   * both mean "re-select", and a distinct answer would invite callers to
   * treat expiry as recoverable).
   */
  get(
    selectionId: string,
    currentSnapshotToken: string | undefined,
  ): (MaterializedSelection & { stale: boolean }) | undefined {
    const rec = this.records.get(selectionId);
    if (rec === undefined) return undefined;
    if (this.now() - rec.createdAt > this.ttlMs) {
      this.records.delete(selectionId);
      return undefined;
    }
    return { ...rec, stale: rec.snapshotToken !== currentSnapshotToken };
  }

  /** Number of live (unexpired) records — test/diagnostic surface. */
  size(): number {
    const now = this.now();
    let n = 0;
    for (const rec of this.records.values()) {
      if (now - rec.createdAt <= this.ttlMs) n += 1;
    }
    return n;
  }
}
