/**
 * Where the daemon puts things, per platform.
 *
 * The Windows IPC endpoint is the interesting one: it is a NAMED PIPE, not a
 * filesystem path, so the surrounding mkdir/stat/unlink work has to be skipped.
 * `isPipe()` is what callers gate on, and getting it wrong throws at daemon
 * start — the least recoverable moment.
 *
 * Note these assert path SHAPE (prefix, segments), not separators: `path.join`
 * emits `/` when the test runs on macOS/Linux and `\` on Windows, and pinning
 * the separator would make the suite pass on exactly one OS.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cacheDir, isPipe, logDir, socketPath, stateDir } from "./paths.js";

const saved = {
  platform: process.env.BROWSER_TAB_PLATFORM,
  local: process.env.LOCALAPPDATA,
  sock: process.env.BROWSER_TAB_SOCKET_PATH,
  state: process.env.BROWSER_TAB_STATE_DIR,
  cache: process.env.BROWSER_TAB_CACHE_DIR,
  log: process.env.BROWSER_TAB_LOG_DIR,
};
afterEach(() => {
  for (const [k, v] of Object.entries({
    BROWSER_TAB_PLATFORM: saved.platform,
    LOCALAPPDATA: saved.local,
    BROWSER_TAB_SOCKET_PATH: saved.sock,
    BROWSER_TAB_STATE_DIR: saved.state,
    BROWSER_TAB_CACHE_DIR: saved.cache,
    BROWSER_TAB_LOG_DIR: saved.log,
  })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function asWindows(): void {
  process.env.BROWSER_TAB_PLATFORM = "win32";
  process.env.LOCALAPPDATA = "C:\\Users\\g\\AppData\\Local";
  delete process.env.BROWSER_TAB_SOCKET_PATH;
  delete process.env.BROWSER_TAB_STATE_DIR;
  delete process.env.BROWSER_TAB_CACHE_DIR;
  delete process.env.BROWSER_TAB_LOG_DIR;
}

describe("windows layout", () => {
  it("uses a named pipe, not a file, for IPC", () => {
    asWindows();
    expect(socketPath()).toMatch(/^\\\\\.\\pipe\\browser-tab-/);
    expect(isPipe()).toBe(true);
  });

  it("namespaces the pipe per user — the pipe namespace is machine-wide", () => {
    asWindows();
    // Unlike a home directory, two users share one pipe namespace, so an
    // un-namespaced name would collide between logged-in users.
    expect(socketPath().replace(/^\\\\\.\\pipe\\browser-tab-/, "")).not.toBe("");
  });

  it("keeps state, cache and logs under LOCALAPPDATA", () => {
    asWindows();
    for (const dir of [stateDir(), cacheDir(), logDir()]) {
      expect(dir.startsWith("C:\\Users\\g\\AppData\\Local")).toBe(true);
      expect(dir).toContain("browser-tab");
    }
  });

  it("falls back to the profile path when LOCALAPPDATA is unset", () => {
    asWindows();
    delete process.env.LOCALAPPDATA;
    expect(cacheDir()).toContain("AppData");
  });
});

describe("macOS layout is unchanged", () => {
  it("uses a unix socket under the state dir", () => {
    process.env.BROWSER_TAB_PLATFORM = "darwin";
    delete process.env.BROWSER_TAB_SOCKET_PATH;
    delete process.env.BROWSER_TAB_STATE_DIR;
    expect(socketPath().endsWith("daemon.sock")).toBe(true);
    expect(isPipe()).toBe(false);
  });
});

describe("isPipe", () => {
  it("recognises both spellings of a pipe path", () => {
    // Node accepts the forward-slash form too, and a caller that only matched
    // backslashes would mkdir/unlink a pipe.
    expect(isPipe("\\\\.\\pipe\\x")).toBe(true);
    expect(isPipe("//./pipe/x")).toBe(true);
  });

  it("is false for every ordinary path", () => {
    expect(isPipe("/tmp/daemon.sock")).toBe(false);
    expect(isPipe("C:\\tmp\\daemon.sock")).toBe(false);
  });

  it("an explicit socket-path override still wins on Windows", () => {
    // Tests and multi-instance setups set BROWSER_TAB_SOCKET_PATH; the pipe
    // default must not override an explicit choice.
    asWindows();
    process.env.BROWSER_TAB_SOCKET_PATH = "C:\\tmp\\custom.sock";
    expect(socketPath()).toBe("C:\\tmp\\custom.sock");
    expect(isPipe()).toBe(false);
  });
});
