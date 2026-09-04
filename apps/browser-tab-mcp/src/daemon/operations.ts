/**
 * Operation journal — DSL staged-tail PR-I. The durable memory of every
 * EXECUTED mutation (apply/copy/cut): §26.3's `operationId` semantics —
 * "attempted execution, per-effect outcomes, cancellation point, final
 * observation, and residual plan" — with the §15 undo record attached.
 *
 * Undo is RECORDS ONLY in this cycle (recorded staging, plan PR-I): enough
 * pre-state to reverse a live-layout apply, the created ids to reverse a
 * copy, and an explicit `liveStateUnrecoverable` marker for cut — §15's rule
 * that the schema must distinguish true restoration from reconstructive
 * compensation, encoded before any executor exists to blur it.
 *
 * Persistence mirrors the focus/nav journal: rotated ndjson under
 * `journalDir()` (same `BROWSER_TAB_JOURNAL_MAX_BYTES` knob — operations are
 * orders of magnitude rarer than focus events, so they share the budget
 * rather than growing a new one), plus an in-memory ring
 * (`BROWSER_TAB_OPERATIONS_RING`, default 500) that `list`/`get` serve from.
 * The file is the archive; the ring is the query surface — a record older
 * than the ring is on disk but not addressable via IPC, and that is
 * deliberate scope (resources over the archive are PR-L's evidence-gated
 * question).
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { envNum } from "@george43g/robustness";
import { journalDir } from "./paths.js";

export type OperationUndo =
  | {
      kind: "pre-state";
      moves: Array<{ tabId: string; fromWindowId: string; fromIndex: number }>;
    }
  | {
      /**
       * Phase 5: the BEFORE value of every attribute an `act` plan changed.
       * A later snapshot cannot recover it — by the time anything reads back,
       * the tab is already muted/pinned/grouped. Same reason `pre-state` exists
       * for positions, and `wasMinimized` for focus.
       */
      kind: "pre-attributes";
      attributes: Array<{
        tabId: string;
        pinned?: boolean;
        muted?: boolean;
        /** null = the tab was in NO group (distinct from "not recorded"). */
        groupId?: string | null;
      }>;
    }
  | { kind: "created"; tabIds: string[] }
  | { kind: "unrecoverable"; liveStateUnrecoverable: true; closedSourceUrls: string[] };

export interface OperationRecord {
  operationId: string;
  at: number;
  tool: "apply_tab_layout" | "copy_tabs" | "cut_tabs";
  status: string;
  planId?: string | undefined;
  selectionId?: string | undefined;
  /** The validated input as executed (post-schema, pre-execution). */
  request: unknown;
  /** Per-effect (apply) or per-item (copy/cut) outcomes, verbatim. */
  outcomes: unknown;
  residual?: unknown;
  snapshotTokenBefore?: string | undefined;
  snapshotTokenAfter?: string | undefined;
  conflictMode?: string | undefined;
  replanned?: boolean | undefined;
  undo: OperationUndo;
}

const FILE = "operations.ndjson";

export class OperationStore {
  private readonly ring: OperationRecord[] = [];
  private readonly ringSize: number;
  private readonly dir: string;

  constructor(opts: { dir?: string; ringSize?: number } = {}) {
    this.dir = opts.dir ?? journalDir();
    this.ringSize = opts.ringSize ?? envNum("BROWSER_TAB_OPERATIONS_RING", 500);
  }

  /** Load the tail of the durable log into the ring (daemon start). */
  warmFromDisk(): void {
    const path = join(this.dir, FILE);
    if (!existsSync(path)) return;
    try {
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      for (const line of lines.slice(-this.ringSize)) {
        try {
          this.ring.push(JSON.parse(line) as OperationRecord);
        } catch {
          // A torn tail line (crash mid-append) is expected once; skip it.
        }
      }
    } catch {
      // Unreadable archive degrades to an empty ring, never a dead daemon.
    }
  }

  record(input: Omit<OperationRecord, "operationId" | "at">): OperationRecord {
    const rec: OperationRecord = {
      ...input,
      operationId: randomBytes(4).toString("hex"),
      at: Date.now(),
    };
    this.ring.push(rec);
    while (this.ring.length > this.ringSize) this.ring.shift();
    this.append(rec);
    return rec;
  }

  list(limit = 20): OperationRecord[] {
    return this.ring.slice(-Math.max(1, limit)).reverse();
  }

  get(operationId: string): OperationRecord | undefined {
    return this.ring.find((r) => r.operationId === operationId);
  }

  private append(rec: OperationRecord): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const path = join(this.dir, FILE);
      const maxBytes = envNum("BROWSER_TAB_JOURNAL_MAX_BYTES", 5 * 1024 * 1024);
      if (existsSync(path) && statSync(path).size > maxBytes) {
        renameSync(path, `${path}.1`);
      }
      appendFileSync(path, `${JSON.stringify(rec)}\n`);
    } catch {
      // Persistence is best-effort; the in-memory record and the tool result
      // both already carry the outcome.
    }
  }
}
