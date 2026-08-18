/**
 * The one place that knows which OS this is.
 *
 * WHY THIS EXISTS. Until now the answer was "macOS", everywhere, implicitly:
 * there was not a single `process.platform` check in `src/`. The daemon shelled
 * out to `osascript`, installed a launchd plist, wrote logs to
 * `~/Library/Logs`, bound a unix socket, and correlated windows through
 * CoreGraphics — none of which exist on Windows, and all of which failed at the
 * point of use with an errno rather than an explanation.
 *
 * The connector extension, however, is plain MV3 and already runs on Windows
 * Chrome. That makes a Windows daemon worth having: the extension is a COMPLETE
 * data source on its own (it is the authoritative one on macOS too whenever it
 * is connected), so Windows loses the AppleScript fallback and the cgWindowId
 * join — and nothing else.
 *
 * So the rule this module encodes: **degrade explicitly, never crash**. Every
 * macOS-only capability is gated on a named predicate here rather than on a
 * `try/catch` around a subprocess, so `doctor` can say what is unavailable and
 * why instead of surfacing `spawn osascript ENOENT`.
 */

export type PlatformId = "macos" | "windows" | "linux" | "other";

/** Normalised platform. Overridable so tests can drive every branch on one OS. */
export function platformId(): PlatformId {
  const raw = process.env.BROWSER_TAB_PLATFORM ?? process.platform;
  switch (raw) {
    case "darwin":
    case "macos":
      return "macos";
    case "win32":
    case "windows":
      return "windows";
    case "linux":
      return "linux";
    default:
      return "other";
  }
}

export function isMac(): boolean {
  return platformId() === "macos";
}

export function isWindows(): boolean {
  return platformId() === "windows";
}

/**
 * Can this platform read browser state WITHOUT the extension?
 *
 * Only macOS can: the AppleScript adapters are the fallback that makes
 * `list_tabs` work with nothing installed in the browser. Everywhere else the
 * extension is not merely preferred, it is the only source — which is a
 * capability statement, not an error, and callers should present it that way.
 */
export function hasAppleScript(): boolean {
  return isMac();
}

/**
 * Can window bounds be joined to a window-manager id?
 *
 * The join key is a CGWindowID, which is a CoreGraphics concept. There is no
 * Windows equivalent in this contract (an HWND is not a cgWindowId and the
 * wm-stack consumer is yabai, which is macOS-only), so `cgWindowId` is simply
 * null off macOS rather than wrong.
 */
export function hasWindowCorrelation(): boolean {
  return isMac();
}

/** Can a window be captured by window id (`screencapture -l`)? macOS only. */
export function hasWindowCapture(): boolean {
  return isMac();
}

/**
 * A short, honest reason a macOS-only feature is unavailable here — for error
 * messages and `doctor` rows. Phrased so the reader learns what to do instead.
 */
export function unavailableBecause(feature: string): string {
  return (
    `${feature} is macOS-only and this is ${platformId()}. ` +
    `The connector extension supplies tab and window state on every platform; ` +
    `install it and the daemon works without this.`
  );
}
