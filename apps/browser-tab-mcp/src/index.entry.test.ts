/**
 * THE WINDOWS BUG THIS PINS — the second home of the cli.ts backslash bug
 * (#64), missed when the first was fixed. On Windows `process.argv[1]` is
 * `C:\...\src\index.ts` — backslashes — so an unnormalized
 * endsWith("/src/index.ts") never matched, `runMcpServer()` never ran, and a
 * direct `node --import tsx src/index.ts` loaded the library and exited 0.
 * The stress harness's spawned server therefore died cleanly at import time
 * on every Windows machine, which the harness's own phantom-pass bug (fixed
 * alongside) converted into a green run of zero cases.
 */

import { describe, expect, it } from "vitest";
import { isDirectInvocation } from "./index.js";

describe("isDirectInvocation", () => {
  it("matches a POSIX entry path", () => {
    expect(isDirectInvocation("/Users/g/repo/apps/browser-tab-mcp/dist/index.js")).toBe(true);
    expect(isDirectInvocation("/Users/g/repo/apps/browser-tab-mcp/src/index.ts")).toBe(true);
  });

  it("matches a WINDOWS entry path", () => {
    expect(
      isDirectInvocation(
        "C:\\Users\\georg\\repos\\browser-tab-mcp\\apps\\browser-tab-mcp\\src\\index.ts",
      ),
    ).toBe(true);
    expect(isDirectInvocation("D:\\a\\browser-tab-mcp\\dist\\index.js")).toBe(true);
  });

  it("does not match some other file that merely ends in index.js", () => {
    // The suffix includes the directory on purpose — a dependency's own
    // `index.js` must not make this module think it is the entry point.
    expect(isDirectInvocation("/Users/g/repo/node_modules/other/index.js")).toBe(false);
    expect(isDirectInvocation("C:\\node_modules\\other\\index.js")).toBe(false);
    expect(isDirectInvocation(undefined)).toBe(false);
  });
});
