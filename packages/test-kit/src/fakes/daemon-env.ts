/**
 * Daemon environment fake — replaces the copy-pasted 6-key `BROWSER_TAB_*`
 * beforeEach/afterEach blocks in the daemon integration tests with a single
 * `withDaemonEnv(tmp)` that returns a `restore()`.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface DaemonEnvOptions {
  /** Comma-separated browser ids. Default "chrome". */
  browsers?: string;
  /** Poll interval; default 60000 (no surprise ticks mid-test). */
  pollMs?: number;
  /** Ephemeral WS port. Omit to leave `BROWSER_TAB_WS_PORT` unset. */
  wsPort?: number;
  socketPath?: string;
  snapshotPath?: string;
  cacheDir?: string;
  tokenPath?: string;
}

/** Fresh temp dir under the OS tmpdir. */
export function makeTmpDir(prefix = "browser-tab-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** An ephemeral, high WS port dispersed enough to avoid parallel-test clashes. */
export function randomWsPort(base = 18790, span = 500): number {
  return base + Math.floor(Math.random() * span);
}

/**
 * Set the daemon's env knobs pointed at `tmp`, returning `{ restore() }` that
 * puts every touched key back to its prior value (deleting keys that were
 * unset). Always enables the fake AppleScript adapter.
 */
export function withDaemonEnv(tmp: string, over: DaemonEnvOptions = {}): { restore(): void } {
  const prev = new Map<string, string | undefined>();
  const set = (key: string, value: string): void => {
    if (!prev.has(key)) prev.set(key, process.env[key]);
    process.env[key] = value;
  };

  set("BROWSER_TAB_FAKE_ADAPTER", "1");
  set("BROWSER_TAB_BROWSERS", over.browsers ?? "chrome");
  set("BROWSER_TAB_SOCKET_PATH", over.socketPath ?? join(tmp, "daemon.sock"));
  set("BROWSER_TAB_SNAPSHOT_PATH", over.snapshotPath ?? join(tmp, "snapshot.json"));
  set("BROWSER_TAB_CACHE_DIR", over.cacheDir ?? tmp);
  set("BROWSER_TAB_POLL_MS", String(over.pollMs ?? 60000));
  set("BROWSER_TAB_TOKEN_PATH", over.tokenPath ?? join(tmp, "extension-token"));
  if (over.wsPort !== undefined) set("BROWSER_TAB_WS_PORT", String(over.wsPort));

  return {
    restore(): void {
      for (const [key, value] of prev) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}
