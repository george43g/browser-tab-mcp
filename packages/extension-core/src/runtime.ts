/**
 * Cross-browser WebExtension API shim. Safari and Firefox expose
 * `browser` (promise-based); Chrome exposes `chrome` (promise-based since
 * MV3). Both are close enough for the subset we use.
 */

function resolveApi(): typeof chrome {
  const g = globalThis as { browser?: typeof chrome; chrome?: typeof chrome };
  const found = g.browser ?? g.chrome;
  if (!found) {
    throw new Error("WebExtension API unavailable — not running inside a browser extension.");
  }
  return found;
}

/**
 * Lazily-resolved so pure mapper modules stay importable in Node (tests);
 * only actual API property access requires a browser context.
 */
export const api: typeof chrome = new Proxy({} as typeof chrome, {
  get(_target, prop) {
    return (resolveApi() as unknown as Record<PropertyKey, unknown>)[prop];
  },
});

export type BrowserName = "chrome" | "chromium" | "brave" | "safari";

/** Best-effort self-identification, overridable from the options page. */
export function detectBrowserName(): BrowserName {
  const ua = (globalThis.navigator?.userAgent ?? "").toLowerCase();
  if (ua.includes("safari") && !ua.includes("chrome") && !ua.includes("chromium")) {
    return "safari";
  }
  // Brave/Chromium are not reliably distinguishable from the UA; the
  // options page lets the user pin the name when it matters.
  return "chrome";
}
