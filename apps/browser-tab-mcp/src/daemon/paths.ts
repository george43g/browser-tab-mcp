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

/** Focus/navigation journal directory (ndjson rings). */
export function journalDir(): string {
  return process.env.BROWSER_TAB_JOURNAL_DIR ?? join(cacheDir(), "journal");
}

/** Extracted page-content cache (one JSON file per navEpoch-keyed entry). */
export function contentDir(): string {
  return process.env.BROWSER_TAB_CONTENT_DIR ?? join(cacheDir(), "content");
}

/** URL-keyed annotation store (single ndjson file). */
export function annotationsPath(): string {
  return process.env.BROWSER_TAB_ANNOTATIONS_PATH ?? join(cacheDir(), "annotations.ndjson");
}

export function logDir(): string {
  return join(homedir(), "Library", "Logs", "browser-tab");
}

export const LAUNCHD_LABEL = "com.george43g.browser-tab";

export function launchAgentPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}
