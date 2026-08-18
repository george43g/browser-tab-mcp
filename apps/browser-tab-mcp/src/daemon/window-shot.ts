/**
 * Tier-2 window capture — `screencapture -l <cgWindowId>` for any visible
 * window of any browser (not just the active tab). Opt-in behind
 * BROWSER_TAB_WINDOW_CAPTURE and gated by Screen Recording (TCC) — the
 * `doctor` probes the permission; a missing grant surfaces here as the
 * capture failing at call time.
 *
 * The binary path is env-overridable (BROWSER_TAB_SCREENCAPTURE_BIN) so tests
 * can point it at a fake that writes a fixture jpeg.
 */

import { execFile } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { envBool } from "@george43g/robustness";
import { hasWindowCapture, unavailableBecause } from "../platform.js";

const execFileP = promisify(execFile);

let tmpCounter = 0;

/**
 * Tier-2 (daemon screencapture) is opt-in — pixels of arbitrary windows.
 *
 * It is also macOS-only twice over: the binary is `/usr/bin/screencapture`, and
 * the id it takes is a CGWindowID, which nothing off macOS issues. The env var
 * can be set anywhere, so the platform gate comes FIRST — otherwise a Windows
 * user who opts in gets `spawn /usr/bin/screencapture ENOENT` instead of an
 * explanation. Tier-1 (`captureVisibleTab` through the extension) is
 * unaffected and works everywhere.
 */
export function windowCaptureEnabled(): boolean {
  if (!hasWindowCapture()) return false;
  return windowCaptureOptedIn();
}

function windowCaptureOptedIn(): boolean {
  return envBool("BROWSER_TAB_WINDOW_CAPTURE", false);
}

function screencaptureBin(): string {
  return process.env.BROWSER_TAB_SCREENCAPTURE_BIN ?? "/usr/bin/screencapture";
}

/**
 * Capture one CoreGraphics window (by CGWindowID) to an in-memory jpeg buffer.
 * `-x` silences the shutter sound, `-o` drops the window shadow, `-l` selects
 * the window id, `-t jpg` sets the format.
 */
export async function captureWindow(cgWindowId: number): Promise<Buffer> {
  if (!hasWindowCapture()) throw new Error(unavailableBecause("Window capture"));
  const tmp = join(tmpdir(), `browser-tab-shot-${process.pid}-${cgWindowId}-${tmpCounter++}.jpg`);
  try {
    await execFileP(screencaptureBin(), ["-x", "-o", "-t", "jpg", "-l", String(cgWindowId), tmp]);
    return readFileSync(tmp);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone / never written
    }
  }
}
