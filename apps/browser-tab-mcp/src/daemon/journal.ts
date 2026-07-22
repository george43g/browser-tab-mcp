/**
 * Focus / navigation journals — the daemon's event-sourced memory of where
 * the user has been (which window/tab was focused, in what order; each tab's
 * navigation chain).
 *
 * Design:
 *  - In-memory rings (BROWSER_TAB_JOURNAL_RING, default 2000) are the read
 *    path; NDJSON files under journalDir() are the durable tail, appended in
 *    ≤1 write/s batches (SnapshotWriter pattern) and rotated at
 *    BROWSER_TAB_JOURNAL_MAX_BYTES (keep one prior generation).
 *  - Records denormalize url/title so history survives handle churn.
 *  - `navEpoch` per tab-handle lives here (bumped on committed navigation);
 *    it's the cache-busting key content/screenshot caches will use.
 *  - Double-count prevention is the caller's job (ingest EITHER extension
 *    frames OR poll-derived events per browser, switched by merge authority);
 *    a 2s (kind, windowId, tabId) dedupe-vs-head covers the switchover.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { envNum, warn } from "@george43g/robustness";
import type {
  BrowserId,
  FocusRecord,
  JournalInput,
  JournalOutput,
  NavRecord,
  PageState,
} from "@george43g/shared-types";
import { JournalInputSchema } from "@george43g/shared-types";
import { journalDir } from "./paths.js";

const DEFAULT_RING = 2000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const FLUSH_DEBOUNCE_MS = 1_000;
const DEDUPE_WINDOW_MS = 2_000;

function ringSize(): number {
  return envNum("BROWSER_TAB_JOURNAL_RING", DEFAULT_RING);
}
function maxBytes(): number {
  return envNum("BROWSER_TAB_JOURNAL_MAX_BYTES", DEFAULT_MAX_BYTES);
}

export interface JournalStoreOptions {
  dir?: string;
  ring?: number;
}

export class JournalStore {
  private focusLog: FocusRecord[] = [];
  private navLog: NavRecord[] = [];
  private epochs = new Map<string, { epoch: number; url: string }>();
  private seeded = new Set<BrowserId>();
  private pendingFocus: FocusRecord[] = [];
  private pendingNav: NavRecord[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly dir: string;
  private readonly ring: number;

  constructor(opts: JournalStoreOptions = {}) {
    this.dir = opts.dir ?? journalDir();
    this.ring = opts.ring ?? ringSize();
  }

  // ── ingest ──────────────────────────────────────────────────────────

  appendFocus(rec: FocusRecord): void {
    if (this.isDuplicateFocus(rec)) return;
    this.focusLog.push(rec);
    if (this.focusLog.length > this.ring) this.focusLog.shift();
    this.pendingFocus.push(rec);
    this.scheduleFlush();
  }

  appendNav(rec: NavRecord): void {
    this.navLog.push(rec);
    if (this.navLog.length > this.ring) this.navLog.shift();
    this.pendingNav.push(rec);
    this.scheduleFlush();
  }

  /** True when the IMMEDIATELY preceding record is an identical focus
   *  (kind/window/tab) within 2s — kills the double delivery when a browser
   *  flips extension↔AppleScript. Only the head is checked, so a genuine
   *  re-focus (w1→w2→w1) is preserved: its previous record is w2, not w1. */
  private isDuplicateFocus(rec: FocusRecord): boolean {
    const prev = this.focusLog[this.focusLog.length - 1];
    if (!prev) return false;
    return (
      rec.ts - prev.ts <= DEDUPE_WINDOW_MS &&
      prev.kind === rec.kind &&
      prev.windowId === rec.windowId &&
      prev.tabId === rec.tabId
    );
  }

  /** Backfill blur-capture state onto a tab's most recent focus record —
   *  "left this tab mid-edit". In-memory only (session-scoped, like navEpoch);
   *  returns whether a matching record was found. */
  backfillCapture(browser: BrowserId, tabId: string, state: PageState): boolean {
    for (let i = this.focusLog.length - 1; i >= 0; i--) {
      const rec = this.focusLog[i];
      if (rec && rec.kind === "tab-focus" && rec.browser === browser && rec.tabId === tabId) {
        rec.capture = state;
        return true;
      }
    }
    return false;
  }

  // ── navEpoch ────────────────────────────────────────────────────────

  /** Bump the tab's navigation epoch when its URL changed; return the epoch. */
  bumpNavEpoch(tabHandle: string, url: string): number {
    const prev = this.epochs.get(tabHandle);
    if (prev && prev.url === url) return prev.epoch;
    const epoch = (prev?.epoch ?? 0) + 1;
    this.epochs.set(tabHandle, { epoch, url });
    return epoch;
  }

  navEpoch(tabHandle: string): number {
    return this.epochs.get(tabHandle)?.epoch ?? 0;
  }

  // ── MRU seed (once per extension session, from lastAccessed) ─────────

  isSeeded(browser: BrowserId): boolean {
    return this.seeded.has(browser);
  }

  seedTabMru(browser: BrowserId, records: FocusRecord[]): void {
    if (this.seeded.has(browser)) return;
    this.seeded.add(browser);
    if (records.length === 0) return;
    this.focusLog.push(...records);
    // Keep chronological so MRU queries (newest-first scan) stay correct.
    this.focusLog.sort((a, b) => a.ts - b.ts);
    if (this.focusLog.length > this.ring) this.focusLog = this.focusLog.slice(-this.ring);
    this.pendingFocus.push(...records);
    this.scheduleFlush();
  }

  clearSeed(browser: BrowserId): void {
    this.seeded.delete(browser);
  }

  // ── queries ─────────────────────────────────────────────────────────

  windowMru(limit: number, browser?: BrowserId): FocusRecord[] {
    const seen = new Set<string>();
    const out: FocusRecord[] = [];
    for (let i = this.focusLog.length - 1; i >= 0 && out.length < limit; i--) {
      const rec = this.focusLog[i];
      if (!rec) continue;
      if (browser && rec.browser !== browser) continue;
      if (seen.has(rec.windowId)) continue;
      seen.add(rec.windowId);
      out.push(rec);
    }
    return out;
  }

  tabMru(windowId: string, limit: number): FocusRecord[] {
    const seen = new Set<string>();
    const out: FocusRecord[] = [];
    for (let i = this.focusLog.length - 1; i >= 0 && out.length < limit; i--) {
      const rec = this.focusLog[i];
      if (!rec || rec.kind !== "tab-focus" || rec.windowId !== windowId || !rec.tabId) continue;
      if (seen.has(rec.tabId)) continue;
      seen.add(rec.tabId);
      out.push(rec);
    }
    return out;
  }

  journey(tabId: string, limit: number): NavRecord[] {
    const out: NavRecord[] = [];
    for (let i = this.navLog.length - 1; i >= 0 && out.length < limit; i--) {
      const rec = this.navLog[i];
      if (!rec || rec.tabId !== tabId) continue;
      out.push(rec);
    }
    return out;
  }

  recent(limit: number, browser?: BrowserId): FocusRecord[] {
    const out: FocusRecord[] = [];
    for (let i = this.focusLog.length - 1; i >= 0 && out.length < limit; i--) {
      const rec = this.focusLog[i];
      if (!rec) continue;
      if (browser && rec.browser !== browser) continue;
      out.push(rec);
    }
    return out;
  }

  query(params: Record<string, unknown>): JournalOutput {
    const input: JournalInput = JournalInputSchema.parse(params);
    switch (input.view) {
      case "windowMru":
        return { view: input.view, focus: this.windowMru(input.limit, input.browser), nav: [] };
      case "tabMru":
        if (!input.windowId) throw new Error("journal view 'tabMru' requires windowId.");
        return { view: input.view, focus: this.tabMru(input.windowId, input.limit), nav: [] };
      case "journey":
        if (!input.tabId) throw new Error("journal view 'journey' requires tabId.");
        return { view: input.view, focus: [], nav: this.journey(input.tabId, input.limit) };
      default:
        return { view: "recent", focus: this.recent(input.limit, input.browser), nav: [] };
    }
  }

  // ── persistence ─────────────────────────────────────────────────────

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref();
  }

  flush(): void {
    if (this.pendingFocus.length === 0 && this.pendingNav.length === 0) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      if (this.pendingFocus.length > 0) {
        this.appendLines("focus.ndjson", this.pendingFocus);
        this.pendingFocus = [];
      }
      if (this.pendingNav.length > 0) {
        this.appendLines("nav.ndjson", this.pendingNav);
        this.pendingNav = [];
      }
    } catch (err) {
      warn("journal_write_failed", { message: (err as Error).message });
    }
  }

  private appendLines(file: string, records: (FocusRecord | NavRecord)[]): void {
    const path = join(this.dir, file);
    appendFileSync(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
    try {
      if (statSync(path).size > maxBytes()) renameSync(path, `${path}.1`);
    } catch {
      // stat/rename race — best-effort rotation, ignore.
    }
  }

  warmFromDisk(): void {
    this.focusLog = this.readTail("focus.ndjson") as FocusRecord[];
    this.navLog = this.readTail("nav.ndjson") as NavRecord[];
    for (const rec of this.navLog) {
      this.epochs.set(rec.tabId, { epoch: rec.navEpoch, url: rec.url });
    }
  }

  private readTail(file: string): unknown[] {
    const out: unknown[] = [];
    for (const p of [join(this.dir, `${file}.1`), join(this.dir, file)]) {
      if (!existsSync(p)) continue;
      try {
        for (const line of readFileSync(p, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            out.push(JSON.parse(line));
          } catch {
            // skip a corrupt/partial line
          }
        }
      } catch {
        // skip an unreadable file
      }
    }
    return out.slice(-this.ring);
  }

  stop(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }
}
