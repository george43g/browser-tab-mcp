/**
 * Runs the upstream `node:test` suites for `scripts/mcp-apps.mjs` and
 * `scripts/for-each-mcp-app.mjs` inside `pnpm test`.
 *
 * Those scripts (and their tests) are adopted verbatim from
 * mcp-cli-starter-template 52a5386, so they stay byte-comparable with upstream
 * and a later sync is a copy, not a merge. Upstream runs them with
 * `node --test`; this repo's only test entry point is `turbo run test`, so
 * without this file the red drills (empty app set → exit 1) would never run
 * here. Same reasoning as release-verify.test.ts for a repo-root script:
 * browser-tab-mcp's suite is where repo-level machinery is checked.
 */

import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("upstream app-selection scripts", () => {
  it.each([
    "scripts/mcp-apps.test.mjs",
    "scripts/for-each-mcp-app.test.mjs",
  ])("%s passes under node --test", (suite) => {
    let out = "";
    try {
      out = execFileSync(process.execPath, ["--test", "--test-reporter=tap", join(REPO, suite)], {
        cwd: REPO,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(`${suite} failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
    }
    // A suite that ran nothing is not a pass.
    expect(out).toMatch(/# pass [1-9]/);
    expect(out).toMatch(/# fail 0/);
  }, 150_000);

  it("selects both MCP apps in this repo", () => {
    const out = execFileSync(process.execPath, [join(REPO, "scripts/mcp-apps.mjs")], {
      encoding: "utf8",
    });
    expect(out.trim().split("\n")).toEqual([
      "@george43g/browser-tab-mcp",
      "@george43g/tmux-control-mcp",
    ]);
  });
});
