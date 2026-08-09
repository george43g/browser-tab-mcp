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
  CloseWindowInput,
  CommandResult,
  MoveTabInput,
  OpenTabInput,
  OpenWindowInput,
  SetWindowInput,
  TabActionInput,
} from "@george43g/shared-types";

/**
 * Options for `focusTab`. `raiseWindow` defaults to TRUE in every pathway —
 * that is what focus_tab always did. With it false the adapter activates the
 * tab and touches nothing else: no un-minimize, no reordering, no `activate`.
 */
export interface FocusTabOptions {
  raiseWindow?: boolean;
}

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
  /**
   * Activate a tab, and (by default) raise its window. Reports the window's
   * before/after state on the result so a window manager can act without a
   * second read — browser-tab itself never touches Spaces or visibility.
   */
  focusTab(tabId: string, opts?: FocusTabOptions, signal?: AbortSignal): Promise<CommandResult>;
  closeTab(tabId: string, signal?: AbortSignal): Promise<CommandResult>;
  openTab(input: OpenTabInput, signal?: AbortSignal): Promise<CommandResult>;
  /**
   * Chromium: always throws (no state-preserving AppleScript move — needs
   * the extension, M5). Safari: performs the reload-based move when
   * input.allowReload is set, else throws.
   */
  moveTab(input: MoveTabInput, signal?: AbortSignal): Promise<CommandResult>;
  /**
   * Single-tab action. AppleScript supports navigate/reload for every
   * browser and back/forward on Chromium; mute/pin/discard/duplicate throw
   * with a "needs the extension" hint (capability-gated at the tool layer).
   */
  tabAction(input: TabActionInput, signal?: AbortSignal): Promise<CommandResult>;
  /** Open a window with the given URLs, optional bounds and state. */
  openWindow(input: OpenWindowInput, signal?: AbortSignal): Promise<CommandResult>;
  /** Move/resize/minimize/foreground an existing window. */
  setWindow(input: SetWindowInput, signal?: AbortSignal): Promise<CommandResult>;
  /** Close an entire window. */
  closeWindow(input: CloseWindowInput, signal?: AbortSignal): Promise<CommandResult>;
}
