/**
 * The adapter for a platform that has no AppleScript.
 *
 * WHY AN ADAPTER AND NOT A BRANCH. Every read path in the daemon builds an
 * adapter per browser and calls it; the engine, the merge, the capability map
 * and the snapshot shape all assume one exists. Making `makeAdapter` return
 * `null` off macOS would push a platform check into each of those, and the one
 * someone forgot would surface as `spawn osascript ENOENT` — an errno, at the
 * point of use, with no hint that the platform is the reason.
 *
 * So Windows and Linux get an adapter that is HONEST rather than absent. It
 * reports the browser as not-running with an explicit `error`, and every
 * command throws a sentence that names the platform and points at the fix.
 *
 * This is not a degraded mode in practice. The connector extension is plain
 * MV3 and runs on Windows Chrome unchanged; when it connects, the merge makes
 * it authoritative and this adapter's state is discarded — exactly as it is on
 * macOS. What Windows genuinely loses is the no-extension fallback and the
 * cgWindowId join, and both of those are stated, not simulated.
 */

import type {
  BrowserState,
  CloseWindowInput,
  CommandResult,
  MoveTabInput,
  OpenTabInput,
  OpenWindowInput,
  SetWindowInput,
  TabActionInput,
} from "@george43g/shared-types";
import { platformId, unavailableBecause } from "../../platform.js";
import type { AdapterSpec, BrowserAdapter, FocusTabOptions } from "./types.js";

/** Every command surfaces the same explanation, named for what was attempted. */
function refuse(what: string): never {
  throw new Error(
    `${unavailableBecause(`${what} without the connector extension`)} ` +
      `Load the extension in this browser and retry — it executes this command directly.`,
  );
}

export function makeUnavailableAdapter(spec: AdapterSpec): BrowserAdapter {
  const reason = `No AppleScript on ${platformId()} — the connector extension is the only source of browser state here.`;
  return {
    spec,
    // `running: false` rather than a guess. The daemon must not claim a browser
    // is up when it has no way to look; the extension answers that when it
    // connects, and until then "unknown" is honestly reported as not-running
    // plus an `error` string the renderers already surface.
    probe: async () => ({ running: false, pid: null }),
    readState: async (): Promise<BrowserState> => ({
      browser: spec.browser,
      bundleId: spec.bundleId,
      pid: null,
      running: false,
      extensionConnected: false,
      dataSource: "applescript",
      error: reason,
      tabGroups: [],
      windows: [],
    }),
    focusTab: async (_tabId: string, _opts?: FocusTabOptions): Promise<CommandResult> =>
      refuse("focusing a tab"),
    closeTab: async (): Promise<CommandResult> => refuse("closing a tab"),
    openTab: async (_input: OpenTabInput): Promise<CommandResult> => refuse("opening a tab"),
    moveTab: async (_input: MoveTabInput): Promise<CommandResult> => refuse("moving a tab"),
    tabAction: async (_input: TabActionInput): Promise<CommandResult> => refuse("a tab action"),
    openWindow: async (_input: OpenWindowInput): Promise<CommandResult> =>
      refuse("opening a window"),
    setWindow: async (_input: SetWindowInput): Promise<CommandResult> => refuse("setting a window"),
    closeWindow: async (_input: CloseWindowInput): Promise<CommandResult> =>
      refuse("closing a window"),
  };
}
