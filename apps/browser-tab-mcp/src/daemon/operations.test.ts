/**
 * OperationStore — ring semantics, durable ndjson round-trip, rotation, and
 * the §15 undo-record shapes staying distinguishable (restoration vs
 * reconstructive compensation is a SCHEMA property, so it is pinned here).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OperationStore } from "./operations.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bt-ops-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

import type { OperationRecord } from "./operations.js";

const applyRecord = (): Omit<OperationRecord, "operationId" | "at"> => ({
  tool: "apply_tab_layout",
  status: "success",
  planId: "p1",
  request: { planId: "p1" },
  outcomes: [],
  undo: {
    kind: "pre-state",
    moves: [{ tabId: "t:chrome:x1", fromWindowId: "w1", fromIndex: 2 }],
  },
});

describe("OperationStore", () => {
  it("mints ids, lists newest-first, gets by id", () => {
    const store = new OperationStore({ dir, ringSize: 10 });
    const a = store.record(applyRecord());
    const b = store.record({
      tool: "cut_tabs",
      status: "partial",
      request: {},
      outcomes: [],
      undo: {
        kind: "unrecoverable",
        liveStateUnrecoverable: true,
        closedSourceUrls: ["https://x/"],
      },
    });
    expect(a.operationId).toMatch(/^[0-9a-f]{8}$/);
    expect(store.list().map((r) => r.operationId)).toEqual([b.operationId, a.operationId]);
    expect(store.get(a.operationId)?.undo.kind).toBe("pre-state");
    expect(store.get("ffffffff")).toBeUndefined();
    // §15: cut's undo says explicitly that live state cannot come back.
    const cut = store.get(b.operationId);
    expect(cut?.undo).toMatchObject({ kind: "unrecoverable", liveStateUnrecoverable: true });
  });

  it("persists to operations.ndjson and warms a fresh store from the tail", () => {
    const store = new OperationStore({ dir, ringSize: 10 });
    const a = store.record(applyRecord());
    expect(existsSync(join(dir, "operations.ndjson"))).toBe(true);

    const rewarmed = new OperationStore({ dir, ringSize: 10 });
    rewarmed.warmFromDisk();
    expect(rewarmed.get(a.operationId)?.planId).toBe("p1");
  });

  it("bounds the ring and survives a torn tail line", () => {
    const store = new OperationStore({ dir, ringSize: 2 });
    const a = store.record(applyRecord());
    const b = store.record(applyRecord());
    const c = store.record(applyRecord());
    expect(store.get(a.operationId)).toBeUndefined();
    expect(store.list(10).map((r) => r.operationId)).toEqual([c.operationId, b.operationId]);

    // A crash mid-append leaves a torn last line; warming must skip it.
    writeFileSync(join(dir, "operations.ndjson"), `${JSON.stringify(b)}\n{"torn`, { flag: "a" });
    const rewarmed = new OperationStore({ dir, ringSize: 10 });
    rewarmed.warmFromDisk();
    expect(rewarmed.list(10).length).toBeGreaterThan(0);
  });

  it("rotates the file past the size cap, keeping one prior generation", () => {
    const store = new OperationStore({ dir, ringSize: 5 });
    process.env.BROWSER_TAB_JOURNAL_MAX_BYTES = "200";
    try {
      store.record(applyRecord());
      store.record(applyRecord());
      store.record(applyRecord());
      expect(existsSync(join(dir, "operations.ndjson.1"))).toBe(true);
      expect(statSync(join(dir, "operations.ndjson")).size).toBeLessThan(400);
    } finally {
      delete process.env.BROWSER_TAB_JOURNAL_MAX_BYTES;
    }
  });
});
