/**
 * Browser binding for @george43g/control-language — DSL Phase 2, PR-A
 * (docs/agent-handoff/plans/2026-09-02-dsl-phase-2-browser-binding.md).
 *
 * Pure by construction: `makeBrowserDomain(snapshot)` closes over ONE
 * immutable Snapshot and answers the SelectionDomain ordered-view interface
 * from it. No daemon, journal, or I/O coupling — the temporal fields come
 * through an injected TemporalProvider (see temporal.ts) precisely so this
 * file never learns where journal state lives.
 *
 * Identity: stable keys are the EXISTING opaque handles verbatim (browser id
 * string, windowId, groupId, tabId) — no new id scheme. Handles are already
 * globally unique because they embed the browser. Selections built on them
 * are snapshot-bound, never durable identity (spec §23.1 gap 2).
 *
 * Branch order contract (adaptation record §7, last row): scope and relation
 * enumerations follow snapshot tree order exactly as the merge layer emits it
 * — browsers in snapshot order, windows in browser order, tabs in visual
 * order. browser-domain.test.ts pins this; raw browser API array order is
 * never assumed beyond what the snapshot already normalized.
 */

import type { FieldType, SelectionDomain } from "@george43g/control-language";
import type { BrowserState, BrowserWindow, Snapshot, Tab, TabGroup } from "@george43g/shared-types";
import type { TemporalProvider } from "./temporal.js";

export type BrowserRef =
  | { kind: "browser"; browser: BrowserState }
  | { kind: "window"; browser: BrowserState; window: BrowserWindow }
  | {
      kind: "group";
      browser: BrowserState;
      /** The group's window when the snapshot contains it; a group whose
       *  window is unknown still exists as a node, with no members. */
      window: BrowserWindow | undefined;
      group: TabGroup;
    }
  | { kind: "tab"; browser: BrowserState; window: BrowserWindow; tab: Tab };

/** Scope name → result kind. Named and finite so validation can list them. */
const SCOPES = new Map<string, string>([
  ["allBrowsers", "browser"],
  ["allWindows", "window"],
  ["allGroups", "group"],
  ["allTabs", "tab"],
  ["focusedWindow", "window"],
  ["tabsInFocusedWindow", "tab"],
]);

/** Relation name → result kind (explicit projections, never inferred). */
const RELATIONS = new Map<string, string>([
  ["windows", "window"],
  ["groups", "group"],
  ["tabs", "tab"],
  ["members", "tab"],
]);

/**
 * The typed field catalog. One namespace across kinds — readField answers
 * `undefined` for a field that does not apply to a ref's kind, which the
 * language treats under its unknown policy (exclude by default, §7 freeze).
 */
const FIELDS = new Map<string, FieldType>([
  ["title", "string"],
  ["url", "string"],
  ["scheme", "string"],
  ["host", "string"],
  ["domain", "string"],
  ["path", "string"],
  ["browser", "string"],
  ["windowId", "string"],
  ["groupId", "string"],
  ["color", "string"],
  ["state", "string"],
  ["index", "number"],
  ["lastAccessed", "number"],
  ["lastFocusedAt", "number"],
  ["lastNavigatedAt", "number"],
  ["pinned", "boolean"],
  ["active", "boolean"],
  ["audible", "boolean"],
  ["muted", "boolean"],
  ["discarded", "boolean"],
  ["grouped", "boolean"],
  ["incognito", "boolean"],
  ["focused", "boolean"],
]);

interface UrlParts {
  scheme?: string | undefined;
  host?: string | undefined;
  domain?: string | undefined;
  path?: string | undefined;
}

/**
 * URL decomposition for predicates. `domain` is the REGISTRABLE domain by the
 * two-label heuristic (last two labels) — wrong for co.uk-style public
 * suffixes, documented as approximate in the plan; `host` is exact and is the
 * field to use when precision matters. Unparseable URLs (about:, chrome:
 * parse fine; truly malformed ones don't) yield undefined parts, which the
 * unknown policy excludes rather than misclassifies.
 */
function urlParts(url: string): UrlParts {
  try {
    const u = new URL(url);
    const host = u.hostname || undefined;
    const labels = host?.split(".").filter((l) => l.length > 0) ?? [];
    const domain = labels.length >= 2 ? labels.slice(-2).join(".") : host;
    return {
      scheme: u.protocol.replace(/:$/, "") || undefined,
      host,
      domain,
      path: u.pathname || undefined,
    };
  } catch {
    return {};
  }
}

export interface BrowserDomainOptions {
  temporal?: TemporalProvider;
  /**
   * B24 fallback: the most-recently-focused window (journal `windowMru(1)`),
   * consulted ONLY when no window is OS-focused — on a real desktop, the
   * user driving from a terminal means every browser window truthfully
   * reports focused:false, which would otherwise empty the `focusedWindow`
   * scope in the tool's primary use case.
   */
  focusedWindowHint?: string | undefined;
  /** Fired when the hint was actually used, so callers can disclose it. */
  onFocusFallback?: (() => void) | undefined;
}

export function makeBrowserDomain(
  snapshot: Snapshot,
  opts: BrowserDomainOptions = {},
): SelectionDomain<BrowserRef> {
  // ---- one-pass index in snapshot tree order --------------------------------
  const browsers: BrowserRef[] = [];
  const windows: BrowserRef[] = [];
  const groups: BrowserRef[] = [];
  const tabs: BrowserRef[] = [];
  const byKey = new Map<string, BrowserRef>();
  const windowOf = new Map<string, BrowserRef>(); // tabId/groupId → window ref
  const browserOf = new Map<string, BrowserRef>(); // windowId → browser ref

  for (const b of snapshot.browsers) {
    const bRef: BrowserRef = { kind: "browser", browser: b };
    browsers.push(bRef);
    byKey.set(b.browser, bRef);
    const windowById = new Map(b.windows.map((w) => [w.windowId, w]));
    for (const w of b.windows) {
      const wRef: BrowserRef = { kind: "window", browser: b, window: w };
      windows.push(wRef);
      byKey.set(w.windowId, wRef);
      browserOf.set(w.windowId, bRef);
      for (const t of w.tabs) {
        const tRef: BrowserRef = { kind: "tab", browser: b, window: w, tab: t };
        tabs.push(tRef);
        byKey.set(t.tabId, tRef);
        windowOf.set(t.tabId, wRef);
      }
    }
    for (const g of b.tabGroups) {
      const gRef: BrowserRef = {
        kind: "group",
        browser: b,
        window: windowById.get(g.windowId),
        group: g,
      };
      groups.push(gRef);
      byKey.set(g.groupId, gRef);
      const wRef = byKey.get(g.windowId);
      if (wRef) windowOf.set(g.groupId, wRef);
    }
  }

  // Parsed-URL cache: predicates over host/domain hit the same tab repeatedly.
  const urlCache = new Map<string, UrlParts>();
  const partsOf = (t: Tab): UrlParts => {
    let p = urlCache.get(t.tabId);
    if (p === undefined) {
      p = urlParts(t.url);
      urlCache.set(t.tabId, p);
    }
    return p;
  };

  /**
   * The focused window: `focusedBrowser`'s focused window when the snapshot
   * says which browser is frontmost (native CG tier); otherwise, if EXACTLY
   * one running browser has a focused window, that one (deterministic and
   * honest — every Chromium reports `focused` on its own frontmost window);
   * otherwise unknown → empty scope. Empty is legal at resolve level; a
   * mutation over it errors under the §7 emptySelection default.
   */
  const focusedWindow = (): BrowserRef[] => {
    if (snapshot.focusedBrowser !== undefined) {
      const b = snapshot.browsers.find((x) => x.browser === snapshot.focusedBrowser);
      const w = b?.windows.find((x) => x.focused);
      const ref = w === undefined ? undefined : byKey.get(w.windowId);
      if (ref) return [ref];
      // focusedBrowser names a browser whose windows all report unfocused —
      // measured live 2026-09-02 (B24): CG says "safari is frontmost among
      // browsers" while the user is actually in a terminal, so no window is
      // focused. Fall through to the vacancy fallback below.
    } else {
      const focusedRefs = windows.filter(
        (r) => r.kind === "window" && r.window.focused && r.browser.running,
      );
      if (focusedRefs.length === 1) return focusedRefs;
      // MULTIPLE focused windows is a contest, and a hint must not settle a
      // contest — only fill a vacancy. Empty is the honest answer there.
      if (focusedRefs.length > 1) return [];
    }
    // B24 vacancy fallback: no window is OS-focused anywhere — degrade to
    // the journal's most-recently-focused window, disclosed via callback.
    if (opts.focusedWindowHint !== undefined) {
      const hinted = byKey.get(opts.focusedWindowHint);
      if (hinted?.kind === "window") {
        opts.onFocusFallback?.();
        return [hinted];
      }
    }
    return [];
  };

  const groupMembers = (g: Extract<BrowserRef, { kind: "group" }>): BrowserRef[] => {
    if (g.window === undefined) return [];
    return g.window.tabs
      .filter((t) => t.groupId === g.group.groupId)
      .map((t) => byKey.get(t.tabId))
      .filter((r): r is BrowserRef => r !== undefined);
  };

  return {
    kindOf: (r) => r.kind,
    stableKey: (r) => {
      switch (r.kind) {
        case "browser":
          return r.browser.browser;
        case "window":
          return r.window.windowId;
        case "group":
          return r.group.groupId;
        case "tab":
          return r.tab.tabId;
      }
    },
    byKey: (k) => byKey.get(k),
    scopes: () => SCOPES,
    scopeMembers: (name) => {
      switch (name) {
        case "allBrowsers":
          return browsers;
        case "allWindows":
          return windows;
        case "allGroups":
          return groups;
        case "allTabs":
          return tabs;
        case "focusedWindow":
          return focusedWindow();
        case "tabsInFocusedWindow": {
          const w = focusedWindow()[0];
          return w?.kind === "window"
            ? w.window.tabs
                .map((t) => byKey.get(t.tabId))
                .filter((r): r is BrowserRef => r !== undefined)
            : [];
        }
        default:
          return [];
      }
    },
    relations: () => RELATIONS,
    orderedMembers: (parent, relation) => {
      switch (relation) {
        case "windows":
          return parent.kind === "browser"
            ? parent.browser.windows
                .map((w) => byKey.get(w.windowId))
                .filter((r): r is BrowserRef => r !== undefined)
            : undefined;
        case "groups":
          return parent.kind === "window"
            ? parent.browser.tabGroups
                .filter((g) => g.windowId === parent.window.windowId)
                .map((g) => byKey.get(g.groupId))
                .filter((r): r is BrowserRef => r !== undefined)
            : undefined;
        case "tabs":
          return parent.kind === "window"
            ? parent.window.tabs
                .map((t) => byKey.get(t.tabId))
                .filter((r): r is BrowserRef => r !== undefined)
            : undefined;
        case "members":
          return parent.kind === "group" ? groupMembers(parent) : undefined;
        default:
          return undefined;
      }
    },
    parentOf: (r) => {
      switch (r.kind) {
        case "browser":
          return undefined;
        case "window":
          return browserOf.get(r.window.windowId);
        case "group":
          return windowOf.get(r.group.groupId);
        case "tab":
          return windowOf.get(r.tab.tabId);
      }
    },
    siblingsOf: (r) => {
      switch (r.kind) {
        case "browser":
          return browsers;
        case "window":
          return r.browser.windows
            .map((w) => byKey.get(w.windowId))
            .filter((x): x is BrowserRef => x !== undefined);
        case "group":
          return r.browser.tabGroups
            .filter((g) => g.windowId === r.group.windowId)
            .map((g) => byKey.get(g.groupId))
            .filter((x): x is BrowserRef => x !== undefined);
        case "tab":
          return r.window.tabs
            .map((t) => byKey.get(t.tabId))
            .filter((x): x is BrowserRef => x !== undefined);
      }
    },
    fields: () => FIELDS,
    readField: (r, field) => {
      switch (r.kind) {
        case "tab": {
          const t = r.tab;
          switch (field) {
            case "title":
              return t.title;
            case "url":
              return t.url;
            case "scheme":
              return partsOf(t).scheme;
            case "host":
              return partsOf(t).host;
            case "domain":
              return partsOf(t).domain;
            case "path":
              return partsOf(t).path;
            case "browser":
              return r.browser.browser;
            case "windowId":
              return r.window.windowId;
            case "groupId":
              return t.groupId;
            case "index":
              return t.index;
            case "lastAccessed":
              return t.lastAccessed;
            case "lastFocusedAt":
              return opts.temporal?.lastFocusedAt(t.tabId);
            case "lastNavigatedAt":
              return opts.temporal?.lastNavigatedAt(t.tabId);
            case "pinned":
              return t.pinned;
            case "active":
              return t.active;
            case "audible":
              return t.audible;
            case "muted":
              return t.muted;
            case "discarded":
              return t.discarded;
            case "grouped":
              return t.groupId !== undefined;
            case "incognito":
              return r.window.incognito;
            default:
              return undefined;
          }
        }
        case "window": {
          const w = r.window;
          switch (field) {
            case "title":
              return w.title;
            case "browser":
              return r.browser.browser;
            case "windowId":
              return w.windowId;
            case "focused":
              return w.focused;
            case "incognito":
              return w.incognito;
            case "state":
              return w.state;
            default:
              return undefined;
          }
        }
        case "group": {
          const g = r.group;
          switch (field) {
            case "title":
              return g.title;
            case "color":
              return g.color;
            case "browser":
              return r.browser.browser;
            case "windowId":
              return g.windowId;
            default:
              return undefined;
          }
        }
        case "browser":
          return field === "browser" ? r.browser.browser : undefined;
      }
    },
  };
}
