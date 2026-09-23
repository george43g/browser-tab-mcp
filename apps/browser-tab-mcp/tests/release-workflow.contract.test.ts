/**
 * `.github/workflows/release.yml` reports every release line, not just ".".
 *
 * release-please-action namespaces per-package outputs as `<path>--<key>` and
 * special-cases "." to the bare key. The Summarize step read the bare keys
 * (`outputs.release_created`, `outputs.tag_name`), so with a second package a
 * tmux-control release would render as "release cut: false" — a green run
 * that says nothing happened when something did. The step now dumps every
 * `*release_created` / `*tag_name` output of whichever attempt ran.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const yml = readFileSync(join(REPO, ".github/workflows/release.yml"), "utf8");
const summarize = yml.slice(yml.indexOf("- name: Summarize"), yml.indexOf("  verify:"));

describe("release workflow", () => {
  it("summarises outputs generically, so every package path is reported", () => {
    expect(summarize).toMatch(/toJSON\(steps\.release\.outputs\)/);
    expect(summarize).toMatch(/toJSON\(steps\.retry\.outputs\)/);
    expect(summarize).not.toMatch(/outputs\.tag_name/);
    expect(summarize).not.toMatch(/outputs\.release_created/);
  });

  it("keeps its own permissions block and publishes nothing", () => {
    // Never answer a red Release run by changing permissions (AGENTS.md), and
    // versioning stays decoupled from distribution.
    expect(yml).toMatch(/permissions:\n {2}contents: write\n {2}pull-requests: write\n/);
    const steps = yml
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(steps).not.toMatch(/\b(npm|pnpm|yarn) publish\b/);
  });
});
