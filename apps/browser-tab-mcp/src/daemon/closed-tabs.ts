/**
 * Closed-tab memory — Phase 5 PR-O.
 *
 * George, 2026-09-04: *"the mcp should store a history of closed tabs and
 * their state (each closed tabs own history etc.. should also stay in memory
 * for a while)"*. This is the substrate; `reopen` (PR-P) is its consumer, and
 * `close` over a selection cannot land until this exists — closing without a
 * record is the one destructive act with no way back at all.
 *
 * WHY A SNAPSHOT DIFF RATHER THAN AN EVENT. `chrome.tabs.onRemoved` hands you
 * an id and nothing else: by the time it fires the url and title are already
 * gone, so an event-based recorder would have to look them up in the previous
 * snapshot anyway. Diffing here gets that for free AND covers the AppleScript
 * browsers, which have no event source at all — one mechanism, both authority
 * modes, no wire change.
 *
 * THREE WAYS A DIFF LIES ABOUT A CLOSURE, all of which this guards:
 *
 *  1. **A cross-window move looks like a close.** The existing `tab-removed`
 *     DaemonEvent is per-window, so a tab dragged from window A to B emits
 *     removed-in-A. Absence is therefore tested against the WHOLE next
 *     snapshot, never against its old window.
 *  2. **An authority switch reissues every handle.** When a browser flips
 *     between extension and AppleScript sourcing, `t:chrome:x123` becomes
 *     `t:chrome:123` — every tab appears to close and a new set appears. A
 *     browser whose `dataSource` changed is skipped entirely; there is no
 *     information there, only handle churn.
 *  3. **A browser quitting is not 200 closures.** If a browser leaves the
 *     snapshot, stops running, or reports an error, its tabs are skipped —
 *     the state is unknown, and flooding the store with a session's worth of
 *     records would bury the handful of closures a person actually wants back.
 *     (This is also the shape of BACKLOG B23, where a browser vanishing
 *     wholesale goes unnoticed by the diff.)
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envNum } from "@george43g/robustness";
import type { BrowserId, Snapshot } from "@george43g/shared-types";
import { journalDir } from "./paths.js";

export interface ClosedTabRecord {
  closedTabId: string;
  /** The handle the tab HAD. Stale by definition — recorded for correlation. */
  tabId: string;
  browser: BrowserId;
  url: string;
  title: string;
  favicon?: string;
  /** Position in its window at the moment it vanished. */
  index: number;
  windowId: string;
  /** True when the window itself went with it — restore needs a new window. */
  windowGone: boolean;
  pinned: boolean;
  muted: boolean;
  groupId?: string;
  /** Group title/colour die with the last member, so they are copied here. */
  groupTitle?: string;
  groupColor?: string;
  closedAt: number;
}

const FILE = "closed-tabs.ndjson";

/** Every tab handle currently in the snapshot, regardless of window. */
function allTabIds(snap: Snapshot): Set<string> {
  const ids = new Set<string>();
  for (const b of snap.browsers)
    for (const w of b.windows) for (const t of w.tabs) ids.add(t.tabId);
  return ids;
}

/**
 * Closures implied by prev → next. Pure: the caller owns persistence, so this
 * is testable without a filesystem and reusable by a future event source.
 */
export function detectClosures(
  prev: Snapshot,
  next: Snapshot,
  now = Date.now(),
): ClosedTabRecord[] {
  const survivors = allTabIds(next);
  const out: ClosedTabRecord[] = [];
  for (const prevB of prev.browsers) {
    const nextB = next.browsers.find((b) => b.browser === prevB.browser);
    // Guard 3: the browser is gone, stopped, or erroring — unknown, not closed.
    if (nextB === undefined || nextB.running === false || nextB.error !== undefined) continue;
    // Guard 2: handles were reissued; every "closure" here is an artefact.
    if (nextB.dataSource !== prevB.dataSource) continue;
    const liveWindows = new Set(nextB.windows.map((w) => w.windowId));
    for (const w of prevB.windows) {
      for (const t of w.tabs) {
        // Guard 1: absence from the WHOLE snapshot, not from its old window.
        if (survivors.has(t.tabId)) continue;
        const group = t.groupId ? prevB.tabGroups?.find((g) => g.groupId === t.groupId) : undefined;
        out.push({
          closedTabId: randomBytes(4).toString("hex"),
          tabId: t.tabId,
          browser: prevB.browser,
          url: t.url,
          title: t.title,
          ...(t.favicon !== undefined ? { favicon: t.favicon } : {}),
          index: t.index,
          windowId: w.windowId,
          windowGone: !liveWindows.has(w.windowId),
          pinned: t.pinned === true,
          muted: t.muted === true,
          ...(t.groupId !== undefined ? { groupId: t.groupId } : {}),
          ...(group?.title ? { groupTitle: group.title } : {}),
          ...(group?.color ? { groupColor: group.color } : {}),
          closedAt: now,
        });
      }
    }
  }
  return out;
}

export class ClosedTabStore {
  private ring: ClosedTabRecord[] = [];
  private readonly ringSize: number;
  private readonly ttlMs: number;
  private readonly dir: string;
  private readonly now: () => number;

  constructor(opts: { dir?: string; ringSize?: number; ttlMs?: number; now?: () => number } = {}) {
    this.dir = opts.dir ?? journalDir();
    this.ringSize = opts.ringSize ?? envNum("BROWSER_TAB_CLOSED_TAB_RING", 200);
    // "for a while" is a policy, not a constant (George's own words). 6h is
    // long enough to cover a working day's regret and short enough that the
    // list stays readable.
    this.ttlMs = opts.ttlMs ?? envNum("BROWSER_TAB_CLOSED_TAB_TTL_MS", 6 * 60 * 60 * 1000);
    this.now = opts.now ?? Date.now;
  }

  /** Load the tail of the durable log into the ring (daemon start). */
  warmFromDisk(): void {
    const path = join(this.dir, FILE);
    if (!existsSync(path)) return;
    try {
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      for (const line of lines.slice(-this.ringSize)) {
        try {
          this.ring.push(JSON.parse(line) as ClosedTabRecord);
        } catch {
          // A torn tail line (crash mid-append) is expected once; skip it.
        }
      }
      this.prune();
    } catch {
      // Unreadable archive degrades to an empty ring, never a dead daemon.
    }
  }

  record(records: readonly ClosedTabRecord[]): void {
    for (const rec of records) {
      this.ring.push(rec);
      this.append(rec);
    }
    this.prune();
  }

  /** Newest first. Optionally narrowed to one browser. */
  list(limit = 20, browser?: BrowserId): ClosedTabRecord[] {
    this.prune();
    const rows = browser ? this.ring.filter((r) => r.browser === browser) : this.ring;
    return rows.slice(-Math.max(1, limit)).reverse();
  }

  get(closedTabId: string): ClosedTabRecord | undefined {
    this.prune();
    return this.ring.find((r) => r.closedTabId === closedTabId);
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    this.ring = this.ring.filter((r) => r.closedAt >= cutoff);
    while (this.ring.length > this.ringSize) this.ring.shift();
  }

  private append(rec: ClosedTabRecord): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const path = join(this.dir, FILE);
      const maxBytes = envNum("BROWSER_TAB_JOURNAL_MAX_BYTES", 5 * 1024 * 1024);
      if (existsSync(path) && statSync(path).size > maxBytes) {
        renameSync(path, `${path}.1`);
      }
      writeFileSync(path, `${JSON.stringify(rec)}\n`, { flag: "a" });
    } catch {
      // The ring is the live surface; a full or read-only disk must not take
      // the daemon down over a record nobody has asked for yet.
    }
  }
}
