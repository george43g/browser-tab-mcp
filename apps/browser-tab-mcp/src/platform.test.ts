/**
 * Platform gating — every branch driven on one OS.
 *
 * The whole point of `BROWSER_TAB_PLATFORM` is that the Windows paths are
 * testable from macOS/Linux CI. Without it these branches would ship untested
 * and be discovered by a Windows user hitting `spawn osascript ENOENT`.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  hasAppleScript,
  hasWindowCapture,
  hasWindowCorrelation,
  isMac,
  isWindows,
  platformId,
  unavailableBecause,
} from "./platform.js";

const saved = process.env.BROWSER_TAB_PLATFORM;
afterEach(() => {
  if (saved === undefined) delete process.env.BROWSER_TAB_PLATFORM;
  else process.env.BROWSER_TAB_PLATFORM = saved;
});

const as = (p: string) => {
  process.env.BROWSER_TAB_PLATFORM = p;
};

describe("platformId", () => {
  it("normalises the node names", () => {
    as("darwin");
    expect(platformId()).toBe("macos");
    as("win32");
    expect(platformId()).toBe("windows");
    as("linux");
    expect(platformId()).toBe("linux");
  });

  it("accepts its own names too, so the override reads naturally", () => {
    as("windows");
    expect(platformId()).toBe("windows");
    as("macos");
    expect(platformId()).toBe("macos");
  });

  it("calls anything else `other` rather than guessing", () => {
    as("freebsd");
    expect(platformId()).toBe("other");
  });
});

describe("capability gates", () => {
  it("macOS has all three", () => {
    as("darwin");
    expect([isMac(), hasAppleScript(), hasWindowCorrelation(), hasWindowCapture()]).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it("Windows has none of them — which is a statement, not a failure", () => {
    // AppleScript, CGWindowID and `screencapture -l` are all macOS concepts.
    // The extension is unaffected: it is plain MV3 and supplies tab/window
    // state and every write command on Windows Chrome.
    as("win32");
    expect(isWindows()).toBe(true);
    expect([hasAppleScript(), hasWindowCorrelation(), hasWindowCapture()]).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("Linux is treated like Windows here, not like macOS", () => {
    as("linux");
    expect(hasAppleScript()).toBe(false);
    expect(isWindows()).toBe(false);
  });

  it("explains itself in a sentence that names the platform and the fix", () => {
    as("win32");
    const why = unavailableBecause("Window capture");
    expect(why).toContain("macOS-only");
    expect(why).toContain("windows");
    expect(why).toContain("extension");
  });
});
