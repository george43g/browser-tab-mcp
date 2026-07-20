/**
 * Source merger — decides, per browser, whether extension-fed state or the
 * AppleScript poll wins.
 *
 * Rules:
 *  - An extension snapshot wins while its socket is alive AND the feed has
 *    shown liveness within maxExtensionAgeMs. The extension only pushes on
 *    tab/window events, so an idle-but-connected browser would otherwise age
 *    out; the WS server calls touch() on every inbound frame (incl. pongs)
 *    to keep a live-but-quiet feed authoritative. A dead socket stops
 *    ponging and is dropped by the server heartbeat → clearExtension().
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

  /**
   * Refresh a feed's liveness without replacing its state. Called by the WS
   * server on any inbound frame (a pong is enough) so a connected extension
   * that simply has no tab activity doesn't age out of the freshness window.
   */
  touch(browser: BrowserId): void {
    const feed = this.extensionFeeds.get(browser);
    if (feed) feed.receivedAt = Date.now();
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
