/**
 * lib/mcp-apps.mjs — which workspaces are MCP apps, and the one place that
 * turns "none of them" into a failure.
 *
 * WHY THIS EXISTS: `pnpm --filter <pattern>` that matches nothing prints "No
 * projects matched the filters" and EXITS 0, so a CI step whose filter matches
 * nothing passes green. `--fail-if-no-match` is accepted and ignored on pnpm
 * 10.29.3 — an unknown flag that changes nothing looks exactly like a flag that
 * worked (measured, DEFERRED #52). Gates that selected apps by the name shape
 * `<scope>/*-mcp` were therefore vacuous for any app without that suffix, and
 * silent about it.
 *
 * The fix is not another checker that reads the workflow YAML back and confirms
 * coverage — that is a third list to keep in sync. It is to DERIVE the gated
 * set: `for-each-mcp-app.mjs` runs a script for exactly the apps reported here,
 * so an app cannot be added without being gated.
 *
 * SCOPE is keyed on an AFFIRMATIVE fact — the workspace's package.json declares
 * `@george43g/mcp-kit` in dependencies ∪ devDependencies ∪ peerDependencies,
 * which is what makes it an MCP app — never on a name shape and never on a
 * hand-list of directory names. Same marker, for the same reason, as
 * check-stdout-purity.mjs:34 (rationale at :20-23). CLI meta-tools (the
 * scaffolder) are not MCP apps and are named explicitly at their call sites.
 *
 * `requireMcpApps` EXITS 1 WHEN IT FINDS NONE. A gate with nothing to check is
 * a failure, never a pass — that is the entire defect this module ends. Both
 * callers go through it, so the empty case can only ever be red, in one place.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const MCP_MARKER = "@george43g/mcp-kit";

/** Repo root, from scripts/lib/. */
export const REPO_ROOT = resolve(import.meta.dirname, "../..");

/**
 * Every `apps/*` workspace whose manifest declares the marker.
 *
 * Returns `{ apps, unnamed }` — `apps` entries are `{ dir, name }`, where
 * `name` is what `pnpm --filter` addresses; `unnamed` holds marked workspaces
 * with no package name, which the caller must treat as a failure rather than
 * skip (see requireMcpApps).
 */
export function mcpApps(root = REPO_ROOT) {
  const apps = [];
  const unnamed = [];
  let kids = [];
  try {
    kids = readdirSync(join(root, "apps"), { withFileTypes: true });
  } catch {
    return { apps, unnamed };
  }
  for (const kid of kids) {
    if (!kid.isDirectory()) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(root, "apps", kid.name, "package.json"), "utf8"));
    } catch {
      // No manifest (or unparseable) — not an app workspace.
      continue;
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    if (!(MCP_MARKER in deps)) continue;
    // A nameless workspace cannot be addressed by `pnpm --filter`, so it would
    // drop out of every gate — the exact failure mode this module prevents.
    if (typeof pkg.name !== "string" || pkg.name.length === 0) {
      unnamed.push(`apps/${kid.name}`);
      continue;
    }
    apps.push({ dir: `apps/${kid.name}`, name: pkg.name });
  }
  apps.sort((a, b) => a.name.localeCompare(b.name));
  return { apps, unnamed };
}

/** The list, or a hard failure with a message naming `who` asked. */
export function requireMcpApps(who, root = REPO_ROOT) {
  const { apps, unnamed } = mcpApps(root);
  if (unnamed.length > 0) {
    console.error(`${who}: FAILED — MCP app workspace(s) with no package name:`);
    for (const dir of unnamed) console.error(`  • ${dir}`);
    console.error("  `pnpm --filter` addresses a package by name, so an unnamed workspace");
    console.error("  silently drops out of every gate. Give it a scoped `name`.");
    process.exit(1);
  }
  if (apps.length === 0) {
    console.error(`${who}: FAILED — no apps/* workspace declares ${MCP_MARKER}.`);
    console.error("  A gate with nothing to check is a failure, not a pass. Either the repo");
    console.error("  has no MCP app (then delete the gates that call this), or the marker or");
    console.error("  the manifest shape changed — update MCP_MARKER in scripts/lib/mcp-apps.mjs.");
    process.exit(1);
  }
  return apps;
}
