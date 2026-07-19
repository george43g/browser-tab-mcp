/**
 * Options storage — token, port, browser-name pin. Lives in
 * storage.local (device-local; the token must not sync via storage.sync).
 */

import { api, type BrowserName, detectBrowserName } from "./runtime.js";

export interface ConnectorOptions {
  token: string;
  port: number;
  browser: BrowserName;
}

const DEFAULTS: ConnectorOptions = {
  token: "",
  port: 8790,
  browser: detectBrowserName(),
};

export async function loadOptions(): Promise<ConnectorOptions> {
  const stored = (await api.storage.local.get(DEFAULTS)) as Partial<ConnectorOptions>;
  return { ...DEFAULTS, ...stored };
}

export async function saveOptions(options: ConnectorOptions): Promise<void> {
  await api.storage.local.set(options);
}
