/**
 * Daemon filesystem layout. Everything env-overridable (and therefore
 * flag-overridable via the env↔flag binder).
 *
 *   ~/.browser-tab/            state dir (socket, extension token, pid)
 *   ~/.cache/browser-tab/      snapshot.json + last.json for shell consumers
 *   ~/Library/Logs/browser-tab/  launchd stdout/stderr
 */

import { homedir } from "node:os";
import { join } from "node:path";

export function stateDir(): string {
  return process.env.BROWSER_TAB_STATE_DIR ?? join(homedir(), ".browser-tab");
}

export function socketPath(): string {
  return process.env.BROWSER_TAB_SOCKET_PATH ?? join(stateDir(), "daemon.sock");
}

export function tokenPath(): string {
  return process.env.BROWSER_TAB_TOKEN_PATH ?? join(stateDir(), "extension-token");
}

export function cacheDir(): string {
  return process.env.BROWSER_TAB_CACHE_DIR ?? join(homedir(), ".cache", "browser-tab");
}

export function snapshotPath(): string {
  return process.env.BROWSER_TAB_SNAPSHOT_PATH ?? join(cacheDir(), "snapshot.json");
}

export function lastScanPath(): string {
  return join(cacheDir(), "last.json");
}

export function logDir(): string {
  return join(homedir(), "Library", "Logs", "browser-tab");
}

export const LAUNCHD_LABEL = "com.george43g.browser-tab";

export function launchAgentPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}
