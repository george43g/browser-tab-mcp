/**
 * Daemon state store — holds the latest merged Snapshot and diffs
 * consecutive snapshots into granular events for subscribers.
 *
 * Event granularity mirrors the WebExtension tabs events so extension-fed
 * (M5) and poll-fed updates surface identically to clients:
 *   tab-created / tab-removed / tab-updated / tab-moved / tab-activated
 *   window-created / window-removed / window-focused
 * plus a full `snapshot` event after every change batch.
 *
 * Safari caveat: synthetic tab ids (window+index) mean a reorder shows up
 * as remove+create pairs. Documented in the contract.
 */

import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { BrowserState, BrowserWindow, Snapshot, Tab } from "@george43g/shared-types";

export interface DaemonEvent {
  event:
    | "tab-created"
    | "tab-removed"
    | "tab-updated"
    | "tab-moved"
    | "tab-activated"
    | "window-created"
    | "window-removed"
    | "window-focused"
    | "snapshot";
  ts: number;
  browser?: string;
  windowId?: string;
  tabId?: string;
  data?: unknown;
}

export class StateStore extends EventEmitter {
  /**
   * Per-daemon-run identity for `snapshotToken`. A revision number alone
   * would silently repeat meaning across restarts (run A's 418 and run B's
   * 418 describe unrelated states); prefixing a per-boot random id makes
   * tokens comparable by EQUALITY ONLY, which is the whole contract.
   */
  private readonly bootId = randomBytes(4).toString("hex");
  /**
   * Monotonic state revision — bumps whenever observable snapshot CONTENT
   * changes. The bump lives HERE, not in SnapshotWriter, because every
   * serving surface (IPC getSnapshot, subscribe frames, the cache file via
   * the `snapshot` event, list_tabs through the daemon client) reads
   * `store.getSnapshot()`; a writer-side stamp would reach only the file.
   *
   * Changed-ness is a normalized CONTENT comparison, not `events.length > 0`:
   * the event diff deliberately ignores enrichment blips (audible/muted/
   * lastAccessed — see state-diff.test.ts) and never notices a browser
   * vanishing wholesale, but a future `expectedSnapshotToken` concurrency
   * check must treat those as state changes. Over-bumping is safe
   * (conservative replan); under-bumping silently validates a stale plan.
   */
  private revision = 0;
  private lastContentKey: string;
  private snapshot: Snapshot;

  constructor() {
    super();
    const initial: Snapshot = {
      version: 2,
      generatedAt: Date.now(),
      source: "daemon",
      browsers: [],
    };
    this.lastContentKey = contentKey(initial);
    this.snapshot = { ...initial, revision: this.revision, snapshotToken: this.token() };
  }

  private token(): string {
    return `${this.bootId}:${this.revision}`;
  }

  getSnapshot(): Snapshot {
    return this.snapshot;
  }

  /** Replace state with a freshly assembled snapshot, emitting diffs. */
  update(next: Snapshot): void {
    const prev = this.snapshot;
    const key = contentKey(next);
    if (key !== this.lastContentKey) {
      this.revision += 1;
      this.lastContentKey = key;
    }
    this.snapshot = {
      ...next,
      source: "daemon",
      revision: this.revision,
      snapshotToken: this.token(),
    };
    const events = diffSnapshots(prev, this.snapshot);
    for (const e of events) {
      this.emit("event", e);
    }
    if (events.length > 0) {
      this.emit("event", {
        event: "snapshot",
        ts: Date.now(),
        data: this.snapshot,
      } satisfies DaemonEvent);
    }
  }

  onEvent(handler: (e: DaemonEvent) => void): () => void {
    this.on("event", handler);
    return () => this.off("event", handler);
  }
}

/**
 * Normalized content identity for revision bumping: the snapshot minus its
 * volatile self-describing fields (`generatedAt` moves every assembly;
 * `revision`/`snapshotToken` are what we are computing). Key order is stable
 * in practice because every snapshot is built by the same mappers; a
 * key-order false positive would only over-bump, which is the safe direction.
 */
function contentKey(s: Snapshot): string {
  const { generatedAt: _g, revision: _r, snapshotToken: _t, ...rest } = s;
  return JSON.stringify(rest);
}

function tabKeyMap(w: BrowserWindow): Map<string, Tab> {
  return new Map(w.tabs.map((t) => [t.tabId, t]));
}

function diffWindows(browser: string, prev: BrowserWindow, next: BrowserWindow): DaemonEvent[] {
  const ts = Date.now();
  const events: DaemonEvent[] = [];
  const prevTabs = tabKeyMap(prev);
  const nextTabs = tabKeyMap(next);

  for (const [tabId, tab] of nextTabs) {
    const old = prevTabs.get(tabId);
    if (!old) {
      events.push({ event: "tab-created", ts, browser, windowId: next.windowId, tabId, data: tab });
      continue;
    }
    if (old.url !== tab.url || old.title !== tab.title) {
      events.push({
        event: "tab-updated",
        ts,
        browser,
        windowId: next.windowId,
        tabId,
        data: { url: tab.url, title: tab.title },
      });
    }
    if (old.index !== tab.index) {
      events.push({
        event: "tab-moved",
        ts,
        browser,
        windowId: next.windowId,
        tabId,
        data: { from: old.index, to: tab.index },
      });
    }
    if (!old.active && tab.active) {
      events.push({ event: "tab-activated", ts, browser, windowId: next.windowId, tabId });
    }
  }
  for (const [tabId] of prevTabs) {
    if (!nextTabs.has(tabId)) {
      events.push({ event: "tab-removed", ts, browser, windowId: next.windowId, tabId });
    }
  }
  if (!prev.focused && next.focused) {
    events.push({ event: "window-focused", ts, browser, windowId: next.windowId });
  }
  return events;
}

export function diffSnapshots(prev: Snapshot, next: Snapshot): DaemonEvent[] {
  const ts = Date.now();
  const events: DaemonEvent[] = [];
  const prevBrowsers = new Map<string, BrowserState>(prev.browsers.map((b) => [b.browser, b]));

  for (const nextB of next.browsers) {
    const prevB = prevBrowsers.get(nextB.browser);
    const prevWindows = new Map<string, BrowserWindow>(
      (prevB?.windows ?? []).map((w) => [w.windowId, w]),
    );
    for (const w of nextB.windows) {
      const old = prevWindows.get(w.windowId);
      if (!old) {
        events.push({
          event: "window-created",
          ts,
          browser: nextB.browser,
          windowId: w.windowId,
          data: { title: w.title, tabCount: w.tabCount },
        });
        continue;
      }
      events.push(...diffWindows(nextB.browser, old, w));
      prevWindows.delete(w.windowId);
    }
    for (const [windowId] of prevWindows) {
      if (nextB.windows.every((w) => w.windowId !== windowId)) {
        events.push({ event: "window-removed", ts, browser: nextB.browser, windowId });
      }
    }
  }
  return events;
}
