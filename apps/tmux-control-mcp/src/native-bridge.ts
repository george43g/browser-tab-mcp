/**
 * Native bridge — try to load the Rust accelerator module. Returns null
 * when:
 *   - `MCP_DISABLE_NATIVE=1` is set (forced TS fallback for tests)
 *   - the `.node` binary doesn't exist (e.g. CI didn't build Rust)
 *
 * Caller code MUST treat null as "use TS fallback" and never as an error.
 * The whole point of the rust-accel module is graceful degradation.
 *
 * Lifted from imsg-mcp/src/native-bridge.ts. Generalized to use MCP_
 * prefix instead of IMSG_.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CgWindowInfo, NoopInput, NoopOutput } from "@george43g/shared-types";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface NativeModule {
  /** Demo: hand-mirrored implementation of the noop tool. */
  noopAccel(input: NoopInput): Promise<NoopOutput>;
  /** Plain hello-world used by integration tests. */
  hello(name: string): string;
  /**
   * One process's CoreGraphics windows, with titles when this process holds
   * Screen Recording consent. Optional: a module built before it existed lacks it.
   */
  listCgWindowsOfPid?(pid: number): CgWindowInfo[];
}

let _native: NativeModule | null | undefined;

export function tryLoadNative(): NativeModule | null {
  // Check env on every call (not just first-time) so tests that flip
  // MCP_DISABLE_NATIVE between cases see the change immediately. The
  // load itself is still cached on the success path below.
  if (process.env.MCP_DISABLE_NATIVE === "1") return null;
  if (_native !== undefined) return _native;

  try {
    const require = createRequire(import.meta.url);
    // Resolve the rust-accel package from the workspace; works both in
    // src/ (tsx) and dist/ (built bin) because node_modules sits above
    // both.
    const candidates = [
      join(__dirname, "..", "..", "rust-accel", "index.js"),
      join(__dirname, "..", "..", "..", "apps", "rust-accel", "index.js"),
    ];
    for (const path of candidates) {
      try {
        _native = require(path) as NativeModule;
        return _native;
      } catch {
        // try next
      }
    }
    _native = null;
    return null;
  } catch {
    _native = null;
    return null;
  }
}

export function hasNativeModule(): boolean {
  return tryLoadNative() !== null;
}

export function engineLabel(): "rust" | "ts" {
  return hasNativeModule() ? "rust" : "ts";
}

export interface CgWindowSource {
  osWindows: ((pid: number) => CgWindowInfo[]) | null;
  /** Why `osWindows` is null; reported as a client's `ambiguous` reason. */
  unavailable: string;
}

/**
 * The window list behind list's `processes` option. Absent is a reason, never
 * an error: tmux facts and pane processes still come back without it.
 */
export function cgWindowSource(): CgWindowSource {
  if (process.platform !== "darwin") {
    return { osWindows: null, unavailable: "CoreGraphics windows exist only on macOS" };
  }
  if (process.env.MCP_DISABLE_NATIVE === "1") {
    return { osWindows: null, unavailable: "the native module is disabled (MCP_DISABLE_NATIVE=1)" };
  }
  const native = tryLoadNative();
  if (!native) {
    return {
      osWindows: null,
      unavailable:
        "the rust-accel native module is not built (it needs a Rust toolchain at build time)",
    };
  }
  const list = native.listCgWindowsOfPid;
  if (typeof list !== "function") {
    return {
      osWindows: null,
      unavailable: "the rust-accel native module predates listCgWindowsOfPid; rebuild it",
    };
  }
  return { osWindows: (pid) => list.call(native, pid), unavailable: "" };
}
