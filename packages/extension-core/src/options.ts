/**
 * Options storage — token, port, browser-name pin. Lives in
 * storage.local (device-local; the token must not sync via storage.sync).
 */

import { api, type BrowserName, detectBrowserName } from "./runtime.js";

export type BrowserChoice = BrowserName | "auto";

export interface ConnectorOptions {
  token: string;
  port: number;
  /** Resolved browser identity sent to the daemon. */
  browser: BrowserName;
  /** What the user selected; auto is resolved afresh on each load. */
  browserChoice?: BrowserChoice;
}

const DEFAULTS = {
  token: "",
  port: 8790,
  // storage.local.get(object) returns ONLY the keys named here. Omitting
  // browser would silently discard a saved manual choice in real Chrome.
  browser: "auto" as const,
};

const BROWSERS: readonly BrowserName[] = [
  "chrome",
  "chromium",
  "brave",
  "edge",
  "chatgpt",
  "safari",
];

export async function loadOptions(): Promise<ConnectorOptions> {
  const stored = (await api.storage.local.get(DEFAULTS)) as Omit<
    Partial<ConnectorOptions>,
    "browser"
  > & {
    browser?: BrowserChoice;
  };
  const rawChoice = stored.browser;
  const choice: BrowserChoice =
    rawChoice === "auto" || (rawChoice !== undefined && BROWSERS.includes(rawChoice))
      ? rawChoice
      : "auto";
  return {
    token: stored.token ?? DEFAULTS.token,
    port: stored.port ?? DEFAULTS.port,
    browser: choice === "auto" ? detectBrowserName() : choice,
    browserChoice: choice,
  };
}

export async function saveOptions(options: ConnectorOptions): Promise<void> {
  await api.storage.local.set({
    token: options.token,
    port: options.port,
    browser: options.browserChoice ?? options.browser,
  });
}
