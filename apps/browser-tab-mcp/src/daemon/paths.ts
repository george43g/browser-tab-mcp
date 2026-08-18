/**
 * Daemon filesystem layout. Everything env-overridable (and therefore
 * flag-overridable via the env↔flag binder).
 *
 * macOS / Linux:
 *   ~/.browser-tab/              state dir (socket, extension token, pid)
 *   ~/.cache/browser-tab/        snapshot.json + last.json + heartbeat.json
 *   ~/Library/Logs/browser-tab/  launchd stdout/stderr (macOS)
 *
 * Windows:
 *   %LOCALAPPDATA%\browser-tab\{state,cache,logs}
 *   \\.\pipe\browser-tab-<user>   IPC endpoint (a NAMED PIPE, not a file)
 *
 * The Windows IPC endpoint is the one path here that is not a filesystem path
 * at all. Node's `net` server binds a pipe name with the same `listen(path)`
 * call, but the surrounding filesystem work — mkdir the parent, stat for a
 * stale socket, unlink on shutdown — is meaningless and throws. `isPipe()`
 * exists so callers gate that work instead of discovering it at runtime.
 */

import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { isWindows } from "../platform.js";

export function stateDir(): string {
  if (process.env.BROWSER_TAB_STATE_DIR) return process.env.BROWSER_TAB_STATE_DIR;
  if (isWindows()) return join(localAppData(), "browser-tab", "state");
  return join(homedir(), ".browser-tab");
}

export function socketPath(): string {
  const override = process.env.BROWSER_TAB_SOCKET_PATH;
  if (override) return override;
  // Windows has no unix-domain socket in a user directory; the equivalent
  // per-user rendezvous is a named pipe. It is namespaced by username because
  // the pipe namespace is machine-wide, not per-user like a home directory.
  if (isWindows()) return `\\\\.\\pipe\\browser-tab-${safeUser()}`;
  return join(stateDir(), "daemon.sock");
}

/** Windows usernames can contain spaces; pipe names should not. */
function safeUser(): string {
  let name = "user";
  try {
    name = userInfo().username || "user";
  } catch {
    // A container with no passwd entry — the default is fine.
  }
  return name.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/**
 * True when the IPC endpoint is a Windows named pipe rather than a file.
 *
 * Callers use this to SKIP filesystem work — mkdir/stat/unlink on a pipe name
 * throw ENOENT or EINVAL, and the stale-socket dance has no meaning: Windows
 * reclaims a pipe when its last handle closes, so a dead daemon leaves nothing
 * behind to clean up.
 */
export function isPipe(path: string = socketPath()): boolean {
  return path.startsWith("\\\\.\\pipe\\") || path.startsWith("//./pipe/");
}

export function tokenPath(): string {
  return process.env.BROWSER_TAB_TOKEN_PATH ?? join(stateDir(), "extension-token");
}

export function cacheDir(): string {
  if (process.env.BROWSER_TAB_CACHE_DIR) return process.env.BROWSER_TAB_CACHE_DIR;
  if (isWindows()) return join(localAppData(), "browser-tab", "cache");
  return join(homedir(), ".cache", "browser-tab");
}

/** `%LOCALAPPDATA%`, falling back to the conventional path under the profile. */
function localAppData(): string {
  return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
}

export function snapshotPath(): string {
  return process.env.BROWSER_TAB_SNAPSHOT_PATH ?? join(cacheDir(), "snapshot.json");
}

export function lastScanPath(): string {
  return join(cacheDir(), "last.json");
}

/**
 * Liveness beacon for shell consumers. Deliberately NOT `snapshot.json`, whose
 * mtime must keep meaning "state changed" — a bar renderer that wants change
 * detection and a bar renderer that wants liveness need different files.
 */
export function heartbeatPath(): string {
  return process.env.BROWSER_TAB_HEARTBEAT_PATH ?? join(cacheDir(), "heartbeat.json");
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

/** Screenshot cache (one jpeg per navEpoch-keyed tab shot / per-window shot). */
export function shotsDir(): string {
  return process.env.BROWSER_TAB_SHOT_DIR ?? join(cacheDir(), "shots");
}

export function logDir(): string {
  if (process.env.BROWSER_TAB_LOG_DIR) return process.env.BROWSER_TAB_LOG_DIR;
  if (isWindows()) return join(localAppData(), "browser-tab", "logs");
  // `~/Library/Logs` is where macOS users (and Console.app) look; Linux has no
  // equivalent convention for a user agent, so state-home is the closest fit.
  if (process.platform === "darwin") return join(homedir(), "Library", "Logs", "browser-tab");
  return join(homedir(), ".local", "state", "browser-tab", "logs");
}

export const LAUNCHD_LABEL = "com.george43g.browser-tab";

export function launchAgentPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}
