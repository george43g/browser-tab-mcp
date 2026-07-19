/**
 * Source merger — decides, per browser, whether extension-fed state or the
 * AppleScript poll wins.
 *
 * Rules:
 *  - An extension snapshot wins while its socket is alive AND the data is
 *    fresh (younger than 2× the poll interval).
 *  - AppleScript fills in browsers with no extension (Safari until M6,
 *    anything the user didn't install the extension in).
 *  - Correlation enrichment (cgWindowId) is applied AFTER merging, since
 *    extension window bounds also need the CG join.
 *
 * M4 ships the AppleScript side; the extension registry is populated by
 * the WS server in M5.
 */

import type { BrowserId, BrowserState, Snapshot } from "@george43g/shared-types";
import { enrichWithCgWindowIds } from "../detect/correlate.js";

export interface ExtensionFeed {
  state: BrowserState;
  receivedAt: number;
}

export class SourceMerger {
  private extensionFeeds = new Map<BrowserId, ExtensionFeed>();

  setExtensionState(browser: BrowserId, state: BrowserState): void {
    this.extensionFeeds.set(browser, { state, receivedAt: Date.now() });
  }

  clearExtension(browser: BrowserId): void {
    this.extensionFeeds.delete(browser);
  }

  extensionConnected(browser: BrowserId): boolean {
    return this.extensionFeeds.has(browser);
  }

  /** Merge the latest AppleScript poll with any live extension feeds. */
  async merge(polled: Snapshot, maxExtensionAgeMs: number): Promise<Snapshot> {
    const now = Date.now();
    const browsers = polled.browsers.map((polledState) => {
      const feed = this.extensionFeeds.get(polledState.browser);
      if (feed && now - feed.receivedAt <= maxExtensionAgeMs) {
        return {
          ...feed.state,
          // The poll knows process-level truth better than the extension.
          pid: polledState.pid ?? feed.state.pid,
          running: polledState.running,
          extensionConnected: true,
          dataSource: "extension" as const,
        };
      }
      return { ...polledState, extensionConnected: this.extensionFeeds.has(polledState.browser) };
    });
    const merged: Snapshot = { ...polled, browsers, source: "daemon" };
    return enrichWithCgWindowIds(merged);
  }
}
