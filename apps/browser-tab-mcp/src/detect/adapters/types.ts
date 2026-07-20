/**
 * BrowserAdapter — one implementation per browser family.
 *
 * Adapters own the AppleScript specifics; everything above them speaks the
 * shared-types Snapshot contract. Command methods throw Error with an
 * actionable message (the tool layer wraps with wrapToolError).
 */

import type {
  BrowserId,
  BrowserState,
  CommandResult,
  MoveTabInput,
  OpenTabInput,
} from "@george43g/shared-types";

export interface AdapterSpec {
  browser: BrowserId;
  /** AppleScript application name, e.g. "Google Chrome". */
  appName: string;
  bundleId: string;
  /** Exact process name for pgrep -x. */
  processName: string;
}

export interface BrowserAdapter {
  spec: AdapterSpec;
  /** Never launches the browser. */
  probe(signal?: AbortSignal): Promise<{ running: boolean; pid: number | null }>;
  /**
   * Full read of windows+tabs. Returns a BrowserState with
   * dataSource: "applescript". Never launches the browser; returns
   * running:false + empty windows when the browser is not up.
   */
  readState(signal?: AbortSignal): Promise<BrowserState>;
  focusTab(tabId: string, signal?: AbortSignal): Promise<CommandResult>;
  closeTab(tabId: string, signal?: AbortSignal): Promise<CommandResult>;
  openTab(input: OpenTabInput, signal?: AbortSignal): Promise<CommandResult>;
  /**
   * Chromium: always throws (no state-preserving AppleScript move — needs
   * the extension, M5). Safari: performs the reload-based move when
   * input.allowReload is set, else throws.
   */
  moveTab(input: MoveTabInput, signal?: AbortSignal): Promise<CommandResult>;
}
