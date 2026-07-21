/**
 * Opaque id scheme for windows and tabs.
 *
 * Consumers (wm-stack, MCP clients) must treat these as opaque handles.
 * Internally they encode which native handle to use when executing a
 * command against a browser:
 *
 *   window (AppleScript):  "w:<browser>:<id>"
 *   window (extension):    "w:<browser>:x<id>"
 *   tab (chromium AS):     "t:<browser>:<id>"              — stable per session
 *   tab (extension):       "t:<browser>:x<id>"             — chrome.tabs id
 *   tab (safari AS):       "t:safari:w<windowId>:i<index1>" — synthetic, reissued on reorder
 *   tab group (extension): "g:<browser>:x<id>"             — chrome.tabGroups id
 *
 * AppleScript ids and extension ids are DIFFERENT id spaces — the "x"
 * prefix keeps them apart. While a browser's extension is connected,
 * list_tabs hands out x-ids and commands route over the extension socket;
 * AppleScript ids from older snapshots keep working for AppleScript-able
 * commands and fail with "re-run list_tabs" where they can't.
 */

import type { BrowserId } from "@george43g/shared-types";

const BROWSERS: readonly string[] = ["chrome", "chromium", "brave", "safari"];

export function makeWindowId(browser: BrowserId, nativeId: string | number): string {
  return `w:${browser}:${nativeId}`;
}

export function makeChromiumTabId(browser: BrowserId, nativeId: string | number): string {
  return `t:${browser}:${nativeId}`;
}

/** Safari tabs have no stable native id — identity is (window, 1-based index). */
export function makeSafariTabId(nativeWindowId: string | number, index1: number): string {
  return `t:safari:w${nativeWindowId}:i${index1}`;
}

export function makeExtWindowId(browser: BrowserId, extId: string | number): string {
  return `w:${browser}:x${extId}`;
}

export function makeExtTabId(browser: BrowserId, extId: string | number): string {
  return `t:${browser}:x${extId}`;
}

/** Tab groups exist only in the extension pathway (chrome.tabGroups). */
export function makeExtGroupId(browser: BrowserId, extId: string | number): string {
  return `g:${browser}:x${extId}`;
}

export interface ParsedGroupId {
  browser: BrowserId;
  nativeId: string;
}

/** Strict parser for tab-group handles — null on anything malformed. */
export function parseGroupId(id: string): ParsedGroupId | null {
  const m = /^g:([a-z]+):x(\d+)$/.exec(id);
  if (!m || !m[1] || !m[2] || !BROWSERS.includes(m[1])) return null;
  return { browser: m[1] as BrowserId, nativeId: m[2] };
}

export interface ParsedWindowId {
  browser: BrowserId;
  nativeId: string;
  /** True when the handle came from the extension pathway (x-prefixed). */
  ext: boolean;
}

export interface ParsedTabId {
  browser: BrowserId;
  /** Native tab id (AppleScript or extension; undefined for Safari synthetic). */
  nativeId?: string;
  /** True when the handle came from the extension pathway (x-prefixed). */
  ext: boolean;
  /** Safari AppleScript: native window id + 1-based tab index. */
  safari?: { nativeWindowId: string; index1: number };
}

/** Strict parser — returns null on anything malformed (ids get embedded in AppleScript). */
export function parseWindowId(id: string): ParsedWindowId | null {
  const m = /^w:([a-z]+):(x?)(\d+)$/.exec(id);
  if (!m || !m[1] || !m[3] || !BROWSERS.includes(m[1])) return null;
  return { browser: m[1] as BrowserId, nativeId: m[3], ext: m[2] === "x" };
}

/** Strict parser — returns null on anything malformed (ids get embedded in AppleScript). */
export function parseTabId(id: string): ParsedTabId | null {
  const safari = /^t:safari:w(\d+):i(\d+)$/.exec(id);
  if (safari?.[1] && safari[2]) {
    return {
      browser: "safari",
      ext: false,
      safari: { nativeWindowId: safari[1], index1: Number.parseInt(safari[2], 10) },
    };
  }
  const generic = /^t:(chrome|chromium|brave|safari):(x?)(\d+)$/.exec(id);
  if (generic?.[1] && generic[3]) {
    const ext = generic[2] === "x";
    // Non-ext numeric safari tab ids don't exist (synthetic form above).
    if (generic[1] === "safari" && !ext) return null;
    return { browser: generic[1] as BrowserId, nativeId: generic[3], ext };
  }
  return null;
}
