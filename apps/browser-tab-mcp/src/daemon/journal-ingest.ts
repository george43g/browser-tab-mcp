/**
 * Journal ingest glue — converts the two event sources into journal records:
 *  - extension `event` frames (native chrome ids → x-handles), and
 *  - poll-derived StateStore diff events (already handle-shaped).
 *
 * The CALLER enforces the one-source-per-browser rule (extension frames when
 * connected, store diffs otherwise); this module is pure conversion.
 */

import type { BrowserId, BrowserState, ExtEvent, FocusRecord } from "@george43g/shared-types";
import { makeExtTabId, makeExtWindowId } from "../detect/ids.js";
import { snapshotUrl } from "../detect/url-hygiene.js";
import type { JournalStore } from "./journal.js";
import type { DaemonEvent, StateStore } from "./state.js";

/** url/title for a tab handle from the current merged snapshot (denormalize). */
function lookupTab(store: StateStore, tabId: string): { url: string; title: string } | undefined {
  for (const b of store.getSnapshot().browsers) {
    for (const w of b.windows) {
      for (const t of w.tabs) {
        if (t.tabId === tabId) return { url: t.url, title: t.title };
      }
    }
  }
  return undefined;
}

/** Ingest a live extension event frame (only arrives while connected). */
export function ingestExtEvent(
  journal: JournalStore,
  store: StateStore,
  browser: BrowserId,
  frame: ExtEvent,
): void {
  const ts = frame.ts;
  if (frame.kind === "stateCapture") {
    // Blur capture — backfill the tab's most recent focus record.
    if (frame.tabId === undefined || frame.state === undefined) return;
    journal.backfillCapture(browser, makeExtTabId(browser, frame.tabId), frame.state);
    return;
  }
  if (frame.kind === "nav") {
    if (frame.tabId === undefined || frame.url === undefined) return;
    // Belt for OLD extension bundles: current ones redact userinfo at their
    // own mapper, but the journal denormalizes URLs into durable ndjson, so
    // the daemon re-applies hygiene rather than trusting the peer's version.
    const url = snapshotUrl(frame.url);
    const tabId = makeExtTabId(browser, frame.tabId);
    const navEpoch = journal.bumpNavEpoch(tabId, url);
    const info = lookupTab(store, tabId);
    journal.appendNav({
      ts,
      browser,
      tabId,
      url,
      ...(info?.title ? { title: info.title } : {}),
      ...(frame.transition ? { transition: frame.transition } : {}),
      navEpoch,
      source: "ext",
    });
    return;
  }
  // focus
  if (frame.windowId === undefined) return;
  const windowId = makeExtWindowId(browser, frame.windowId);
  if (frame.tabId !== undefined) {
    const tabId = makeExtTabId(browser, frame.tabId);
    const info = lookupTab(store, tabId);
    journal.appendFocus({
      ts,
      browser,
      kind: "tab-focus",
      windowId,
      tabId,
      ...(info ? { url: info.url, title: info.title } : {}),
      source: "ext",
    });
  } else {
    journal.appendFocus({ ts, browser, kind: "window-focus", windowId, source: "ext" });
  }
}

/** Ingest a poll-derived StateStore diff event (AppleScript-authority only). */
export function ingestStoreEvent(journal: JournalStore, store: StateStore, e: DaemonEvent): void {
  const browser = e.browser as BrowserId | undefined;
  if (!browser) return;
  const ts = e.ts;
  if (e.event === "window-focused" && e.windowId) {
    journal.appendFocus({
      ts,
      browser,
      kind: "window-focus",
      windowId: e.windowId,
      source: "applescript",
    });
  } else if (e.event === "tab-activated" && e.windowId && e.tabId) {
    const info = lookupTab(store, e.tabId);
    journal.appendFocus({
      ts,
      browser,
      kind: "tab-focus",
      windowId: e.windowId,
      tabId: e.tabId,
      ...(info ? { url: info.url, title: info.title } : {}),
      source: "applescript",
    });
  } else if (e.event === "tab-updated" && e.tabId) {
    const data = e.data as { url?: string; title?: string } | undefined;
    if (!data?.url) return;
    const navEpoch = journal.bumpNavEpoch(e.tabId, data.url);
    journal.appendNav({
      ts,
      browser,
      tabId: e.tabId,
      url: data.url,
      ...(data.title ? { title: data.title } : {}),
      navEpoch,
      source: "applescript",
    });
  }
}

/** One-shot MRU seed records from a browser state's lastAccessed timestamps. */
export function buildSeedRecords(state: BrowserState): FocusRecord[] {
  const out: FocusRecord[] = [];
  for (const w of state.windows) {
    for (const t of w.tabs) {
      if (t.lastAccessed === undefined) continue;
      out.push({
        ts: t.lastAccessed,
        browser: state.browser,
        kind: "tab-focus",
        windowId: w.windowId,
        tabId: t.tabId,
        url: t.url,
        title: t.title,
        source: "seed",
      });
    }
  }
  return out;
}
