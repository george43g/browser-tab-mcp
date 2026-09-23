/**
 * Build identity.
 *
 * These run under vitest, NOT a Vite build, so `__BUILD_STAMP__` is undefined
 * and every case here exercises the git-shell-out fallback — which is the
 * branch a `tsx src/cli.ts` run takes, and the one most likely to rot silently
 * because normal builds never reach it.
 */

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { APP_VERSION, buildStamp } from "../src/meta.js";

/**
 * A resolvable HEAD, not merely a `.git` directory.
 *
 * The scaffolder runs `git init` in its output, so a freshly generated repo has
 * a git dir with NO COMMITS — `rev-parse HEAD` fails there and the stamp
 * correctly falls back to bare semver. Guarding on `--git-dir` instead made
 * this test demand a sha inside the E2E smoke, where none can exist.
 */
function hasCommits(): boolean {
  try {
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: import.meta.dirname,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

describe("buildStamp", () => {
  it("always starts with the package version", () => {
    // The stamp EXTENDS semver rather than replacing it, so anything reading
    // the leading version out of it keeps working.
    expect(buildStamp().startsWith(APP_VERSION)).toBe(true);
  });

  it("is stable across calls (cached)", () => {
    // Cached deliberately: the fallback shells out to git up to four times, and
    // it is read on every REPL banner and TUI render.
    expect(buildStamp()).toBe(buildStamp());
  });

  it("carries a commit count and sha when the checkout has commits", () => {
    // No commits (fresh `git init`) or no git at all → bare semver, asserted by
    // the degradation suite instead.
    if (!hasCommits()) return;
    expect(buildStamp()).toMatch(/^\d+\.\d+\.\d+\+\d+\.[0-9a-f]{7}(\.dirty)?$/);
  });

  it("falls back to bare semver in a repo with no commits", () => {
    if (hasCommits()) return;
    // This is the path a freshly scaffolded repo takes, and the one the E2E
    // smoke exercises for real.
    expect(buildStamp()).toBe(APP_VERSION);
  });

  it("degrades to something usable rather than throwing", () => {
    // Contract: a published tarball or a shallow container still boots. The
    // worst case is bare semver, never an exception.
    expect(() => buildStamp()).not.toThrow();
    expect(buildStamp().length).toBeGreaterThan(0);
  });
});
