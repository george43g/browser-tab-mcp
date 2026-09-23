#!/usr/bin/env node
/**
 * readme-check — did each changed workspace's OWN README change with its source?
 *
 * `.github/workflows/readme-check.yml` used to count ANY changed README.md, so
 * editing the root README satisfied a change under `apps/<app>/src/` (BACKLOG
 * B27). With more than one app that is the common case: the check passed while
 * the changed app's README went stale.
 *
 * The rule: for each changed file under `apps/<x>/src/` or `packages/<x>/src/`,
 * the README nearest up-tree from it (on disk at HEAD) must be in the change,
 * falling back to the root README.md for a package with none of its own.
 * Bypass stays in the workflow: `[skip-readme]` in the commit or PR title.
 *
 * CLI: changed paths on stdin, one per line. Exit 0 = every relevant README
 * changed (or no source changed); 1 = gaps, listed. Dependency-free so the
 * workflow needs no install.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = /^(apps|packages)\/[^/]+\/src\//;

/** The README nearest up-tree from `path`, falling back to the root README. */
export function nearestReadme(path, root = REPO) {
  let dir = posix.dirname(path);
  while (dir !== "." && dir !== "/" && dir !== "") {
    const candidate = `${dir}/README.md`;
    if (existsSync(join(root, candidate))) return candidate;
    dir = posix.dirname(dir);
  }
  return "README.md";
}

export function readmeGaps(changed, root = REPO) {
  const touched = new Set(changed);
  const byReadme = new Map();
  for (const path of changed) {
    if (!SOURCE.test(path)) continue;
    const readme = nearestReadme(path, root);
    if (touched.has(readme)) continue;
    if (!byReadme.has(readme)) byReadme.set(readme, []);
    byReadme.get(readme).push(path);
  }
  return [...byReadme].map(([readme, sources]) => ({ readme, sources }));
}

function isMain() {
  try {
    return (
      process.argv[1] !== undefined &&
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
}

if (isMain()) {
  const changed = readFileSync(0, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const gaps = readmeGaps(changed);
  if (!changed.some((p) => SOURCE.test(p))) {
    console.log("No source code changes — README check skipped.");
    process.exit(0);
  }
  if (gaps.length === 0) {
    console.log("Every changed workspace's README was updated alongside its source.");
    process.exit(0);
  }
  for (const { readme, sources } of gaps) {
    const shown = sources.slice(0, 3).join(", ") + (sources.length > 3 ? ", …" : "");
    console.log(`::error::${readme} was not updated, but its source changed (${shown}).`);
  }
  console.log(
    "Update each README named above, or add [skip-readme] to the commit/PR title if a docs " +
      "update is genuinely not warranted.",
  );
  process.exit(1);
}
