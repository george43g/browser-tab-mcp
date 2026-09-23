/**
 * readme-check demands the RELEVANT readme (BACKLOG B27).
 *
 * `.github/workflows/readme-check.yml` used to count ANY changed README.md, so
 * editing the root README satisfied a change under
 * `apps/tmux-control-mcp/src/`. With two apps that is the common case, not an
 * edge: the check passed while the changed app's own README went stale. It now
 * requires, for each changed source file, the nearest README up-tree from it,
 * falling back to the root README when a package has none of its own.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readmeGaps } from "../../../scripts/readme-check.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const missing = (changed: string[]) => readmeGaps(changed, REPO).map((g) => g.readme);

describe("readme-check", () => {
  it("passes when nothing under a workspace's src/ changed", () => {
    expect(missing(["docs/x.md", "apps/tmux-control-mcp/tests/a.test.ts"])).toEqual([]);
  });

  it("requires the changed app's own README — the root README does not stand in", () => {
    expect(missing(["apps/tmux-control-mcp/src/cli.ts", "README.md"])).toEqual([
      "apps/tmux-control-mcp/README.md",
    ]);
  });

  it("requires browser-tab's README for browser-tab source, not tmux-control's", () => {
    expect(missing(["apps/browser-tab-mcp/src/cli.ts", "apps/tmux-control-mcp/README.md"])).toEqual(
      ["apps/browser-tab-mcp/README.md"],
    );
  });

  it("passes when the app's own README changed", () => {
    expect(
      missing(["apps/tmux-control-mcp/src/cli.ts", "apps/tmux-control-mcp/README.md"]),
    ).toEqual([]);
  });

  it("falls back to the root README for a package with none of its own", () => {
    expect(missing(["packages/extension-core/src/commands.ts"])).toEqual(["README.md"]);
    expect(missing(["packages/extension-core/src/commands.ts", "README.md"])).toEqual([]);
  });

  it("names every workspace that is missing its README, once each", () => {
    expect(
      missing([
        "apps/tmux-control-mcp/src/cli.ts",
        "apps/tmux-control-mcp/src/index.ts",
        "packages/control-language/src/index.ts",
        "packages/control-language/README.md",
      ]),
    ).toEqual(["apps/tmux-control-mcp/README.md"]);
  });

  it("is what both workflow steps run, and it exits 1 with a gap", () => {
    const yml = readFileSync(join(REPO, ".github/workflows/readme-check.yml"), "utf8");
    expect(yml.match(/node scripts\/readme-check\.mjs/g)?.length).toBe(2);
    expect(yml).not.toMatch(/README_CHANGED=/);
    const run = (input: string) =>
      spawnSync(process.execPath, [join(REPO, "scripts/readme-check.mjs")], { input, cwd: REPO })
        .status;
    expect(run("apps/tmux-control-mcp/src/cli.ts\nREADME.md\n")).toBe(1);
    expect(run("apps/tmux-control-mcp/src/cli.ts\napps/tmux-control-mcp/README.md\n")).toBe(0);
  });
});
