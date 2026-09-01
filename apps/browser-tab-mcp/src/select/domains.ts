/**
 * Live-move domains — adaptation-record ruling R3 (v1 model).
 *
 * The domain within which a tab can be live-moved is derived from what
 * ALREADY determines movability at runtime, never from the browser's name:
 * `move_tab` is extension-only, and `chrome.tabs.move` cannot cross the
 * incognito boundary. So v1 is:
 *
 *     ext:<browser>:<normal|incognito>   when the browser is extension-connected
 *     null                               otherwise (no live movement exists)
 *
 * This is resolution METADATA, not a predicate field — Phase 3's preflight
 * consumes it to block cross-domain live movement before the first mutation
 * (spec §24.5). It upgrades transparently when profile identity lands: richer
 * inputs change the id derivation, not the consumers.
 */

import type { BrowserRef } from "./browser-domain.js";

export function liveMoveDomainId(ref: BrowserRef): string | null {
  if (!ref.browser.extensionConnected) return null;
  switch (ref.kind) {
    case "tab":
    case "window": {
      const w = ref.kind === "tab" ? ref.window : ref.window;
      return `ext:${ref.browser.browser}:${w.incognito ? "incognito" : "normal"}`;
    }
    case "group": {
      if (ref.window === undefined) return null;
      return `ext:${ref.browser.browser}:${ref.window.incognito ? "incognito" : "normal"}`;
    }
    case "browser":
      // A browser spans both partitions; it has no single live-move domain.
      return null;
  }
}

export interface LiveMoveDomainSummary {
  /** Distinct non-null domain ids, in first-seen order. */
  domains: string[];
  /** Members with NO live-move domain (AppleScript-only, unknown window). */
  unknownCount: number;
  /** True when every member shares ONE domain and none are unknown. */
  uniform: boolean;
}

/**
 * Summary over a selection's refs — the §24.5 preflight input. `uniform`
 * false is what blocks live relocation for the whole materialized selection
 * in the initial implementation.
 */
export function summarizeLiveMoveDomains(refs: readonly BrowserRef[]): LiveMoveDomainSummary {
  const domains: string[] = [];
  let unknownCount = 0;
  for (const r of refs) {
    const d = liveMoveDomainId(r);
    if (d === null) {
      unknownCount += 1;
    } else if (!domains.includes(d)) {
      domains.push(d);
    }
  }
  return {
    domains,
    unknownCount,
    uniform: domains.length === 1 && unknownCount === 0 && refs.length > 0,
  };
}
