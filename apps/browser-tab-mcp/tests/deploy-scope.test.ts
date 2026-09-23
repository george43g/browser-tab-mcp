/**
 * Which merges redeploy browser-tab (`.githooks/post-merge` →
 * `scripts/deploy-scope.mjs`).
 *
 * The hook used to deploy on ANY change under apps/, packages/ or scripts/.
 * With a second app in the repo that restarts the live browser daemon — and
 * sideloads Safari, a clean xcodebuild — for a merge that only touched
 * tmux-control. The scope is now browser-tab's own apps plus every workspace
 * package they depend on, derived from package.json files, so a shared
 * package still deploys and a package only another app uses does not.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { needsBrowserTabDeploy } from "../../../scripts/deploy-scope.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("post-merge deploy scope", () => {
  it.each([
    ["a browser-tab source file", ["apps/browser-tab-mcp/src/cli.ts"]],
    ["the connector extension", ["apps/chrome-extension/src/background.ts"]],
    ["the Safari wrapper", ["apps/safari-extension/scripts/rebuild.sh"]],
    ["the native module", ["apps/rust-accel/src/lib.rs"]],
    ["a shared package browser-tab depends on", ["packages/control-language/src/index.ts"]],
    ["a transitive workspace dependency", ["packages/shared-types/src/index.ts"]],
    ["a repo script", ["scripts/deploy-local.mjs"]],
    ["a mixed merge", ["apps/tmux-control-mcp/src/cli.ts", "apps/browser-tab-mcp/src/cli.ts"]],
  ])("deploys for %s", (_label, paths) => {
    expect(needsBrowserTabDeploy(paths, REPO)).toBe(true);
  });

  it.each([
    [
      "a tmux-control-only merge",
      ["apps/tmux-control-mcp/src/cli.ts", "apps/tmux-control-mcp/README.md"],
    ],
    ["a package only tmux-control uses", ["packages/build-config/build-stamp.mjs"]],
    ["a docs-only merge", ["docs/agent-handoff/PROGRESS-LOG.md", "AGENTS.md"]],
    ["nothing", []],
  ])("does not deploy for %s", (_label, paths) => {
    expect(needsBrowserTabDeploy(paths, REPO)).toBe(false);
  });

  it("is what the post-merge hook consults, over stdin", () => {
    const hook = readFileSync(join(REPO, ".githooks/post-merge"), "utf8");
    expect(hook).toContain("scripts/deploy-scope.mjs");
    expect(hook).not.toMatch(/grep -qE '\^\(apps\|packages\|scripts\)\/'/);
    const run = (input: string) =>
      spawnSync(process.execPath, [join(REPO, "scripts/deploy-scope.mjs")], { input }).status;
    expect(run("apps/tmux-control-mcp/src/cli.ts\n")).toBe(1);
    expect(run("apps/tmux-control-mcp/src/cli.ts\npackages/mcp-kit/src/index.ts\n")).toBe(0);
  });
});
