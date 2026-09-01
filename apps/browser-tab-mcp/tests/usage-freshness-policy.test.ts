/**
 * The missing-artifact policy of `scripts/check-usage-freshness.mjs` (which
 * lives in this app's scripts/, so this suite is its home — same reasoning as
 * release-verify.test.ts for the repo-root release script).
 *
 * B21 (partition-vs-iterate, 2026-09-02): "checked-in copy missing" used to
 * soft-pass unconditionally as "not yet generated". That is right on a fresh
 * template scaffold and exactly wrong in a repo whose baseline is committed —
 * there, deleting `completions/browser-tab.bash` switched the drift gate OFF
 * for that file and CI stayed green. The policy is a pure exported function so
 * the selector cannot regress silently; importing the script is safe because
 * its execution sits behind a main-guard.
 */

import { describe, expect, it } from "vitest";
import { missingPolicy } from "../scripts/check-usage-freshness.mjs";

describe("usage-freshness missing-artifact policy", () => {
  it("byte-compares whenever the checked-in copy exists", () => {
    expect(missingPolicy(true, true)).toBe("compare");
    expect(missingPolicy(true, false)).toBe("compare");
  });

  it("soft-passes a missing copy only in the true scaffold state (no baseline at all)", () => {
    expect(missingPolicy(false, false)).toBe("soft-pass");
  });

  it("FAILS a missing copy once any artifact is committed — absence is deletion, not scaffolding", () => {
    // The red-when-empty case: before the fix this returned the soft-pass
    // branch and the drift gate silently stopped guarding the deleted file.
    expect(missingPolicy(false, true)).toBe("fail");
  });
});
