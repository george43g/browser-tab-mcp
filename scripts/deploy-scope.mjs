#!/usr/bin/env node
/**
 * Does a merge need a browser-tab deploy? The post-merge hook's path classifier.
 *
 * `.githooks/post-merge` runs `scripts/deploy-local.mjs` — build, restart the
 * live daemon, reload the extension, sideload Safari — after a merge on main.
 * It used to fire on ANY change under apps/, packages/ or scripts/. Once a
 * second app lives here, that restarts the browser daemon and runs a clean
 * xcodebuild for a merge that only touched tmux-control.
 *
 * The scope is DERIVED, not listed: browser-tab's own apps (DEPLOY_ROOTS) plus
 * every workspace package they depend on, transitively, read from package.json.
 * So a shared package (control-language, shared-types, mcp-kit…) still deploys,
 * a package only another app uses does not, and a new shared dependency is in
 * scope the moment browser-tab depends on it. Root `scripts/` stays in scope,
 * as before: deploy-local and the build wrappers live there.
 *
 * CLI: changed paths on stdin, one per line. Exit 0 = deploy, 1 = skip. An
 * internal error prints and exits 0 — the hook is advisory, and deploying on a
 * classifier bug is the old behaviour, never a silent skip.
 */

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The apps deploy-local.mjs builds, restarts or reloads. */
export const DEPLOY_ROOTS = [
  "apps/browser-tab-mcp",
  "apps/chrome-extension",
  "apps/safari-extension",
  // Loaded by the daemon at runtime; browser-tab-mcp builds it via
  // build:native:optional rather than a package dependency.
  "apps/rust-accel",
];

/** package name → repo-relative dir, and dir → its @workspace deps. */
function workspace(root) {
  const byName = new Map();
  const deps = new Map();
  for (const group of ["apps", "packages"]) {
    let kids = [];
    try {
      kids = readdirSync(join(root, group), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const kid of kids) {
      if (!kid.isDirectory()) continue;
      const dir = `${group}/${kid.name}`;
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
      } catch {
        continue;
      }
      if (typeof pkg.name === "string") byName.set(pkg.name, dir);
      const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
      deps.set(dir, Object.keys(all));
    }
  }
  return { byName, deps };
}

/** Repo-relative directories whose change must redeploy browser-tab. */
export function deployScope(root = REPO) {
  const { byName, deps } = workspace(root);
  const scope = new Set();
  const queue = [...DEPLOY_ROOTS];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (scope.has(dir)) continue;
    scope.add(dir);
    for (const name of deps.get(dir) ?? []) {
      const depDir = byName.get(name);
      if (depDir && !scope.has(depDir)) queue.push(depDir);
    }
  }
  return scope;
}

export function needsBrowserTabDeploy(paths, root = REPO) {
  const scope = deployScope(root);
  return paths.some((p) => {
    if (p.startsWith("scripts/")) return true;
    const m = /^((?:apps|packages)\/[^/]+)\//.exec(p);
    return m !== null && scope.has(m[1]);
  });
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
  let input = "";
  try {
    input = readFileSync(0, "utf8");
    const paths = input
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    process.exit(needsBrowserTabDeploy(paths) ? 0 : 1);
  } catch (err) {
    process.stderr.write(`deploy-scope: ${err?.message ?? err} — deploying anyway\n`);
    process.exit(0);
  }
}
