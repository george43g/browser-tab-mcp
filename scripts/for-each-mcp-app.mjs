#!/usr/bin/env node
/**
 * for-each-mcp-app.mjs — run `pnpm --filter <app> <args…>` for EVERY MCP app.
 *
 *   node scripts/for-each-mcp-app.mjs check:usage
 *   node scripts/for-each-mcp-app.mjs stress
 *   node scripts/for-each-mcp-app.mjs exec npm pack --dry-run
 *
 * The set comes from scripts/lib/mcp-apps.mjs (the mcp-kit dependency marker),
 * never from a name-shaped filter. `pnpm --filter "<scope>/*-mcp" <script>`
 * exits 0 when it matches nothing, so an app without the suffix was silently
 * ungated and the step still went green (DEFERRED #52, measured on pnpm
 * 10.29.3). Deriving the set makes that drift impossible rather than merely
 * detectable: a new app is gated because it depends on mcp-kit, not because
 * someone remembered to widen a filter.
 *
 * Two differences from the glob it replaces, both deliberate:
 *   - An empty set is a hard failure (lib/mcp-apps.mjs owns that message).
 *   - One `pnpm --filter <exact-name>` per app, so an app missing the script
 *     fails instead of being carried by a sibling that has it. pnpm's recursive
 *     run only errors when NONE of the selected packages has the script
 *     (ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT), which is the same vacuous-pass shape.
 *
 * Every app runs even after one fails, so CI reports the whole picture.
 */

import { spawnSync } from "node:child_process";

import { REPO_ROOT, requireMcpApps } from "./lib/mcp-apps.mjs";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("for-each-mcp-app: FAILED — no pnpm script or command given.");
  console.error("  Usage: node scripts/for-each-mcp-app.mjs <pnpm-script> [args…]");
  process.exit(2);
}

const apps = requireMcpApps("for-each-mcp-app");

const failed = [];
for (const app of apps) {
  console.log(`\n-- for-each-mcp-app: ${app.name} > pnpm ${args.join(" ")}`);
  const run = spawnSync("pnpm", ["--filter", app.name, ...args], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (run.error) {
    failed.push(`${app.name}: could not spawn pnpm (${run.error.code ?? run.error.message})`);
  } else if (run.signal) {
    failed.push(`${app.name}: killed by ${run.signal}`);
  } else if (run.status !== 0) {
    failed.push(`${app.name}: exited ${run.status}`);
  }
}

if (failed.length > 0) {
  console.error(`\nfor-each-mcp-app: FAILED for ${failed.length} of ${apps.length} app(s):`);
  for (const line of failed) console.error(`  • ${line}`);
  process.exit(1);
}

console.log(
  `\nfor-each-mcp-app: \`${args.join(" ")}\` passed for ${apps.length} MCP app(s): ` +
    `${apps.map((a) => a.name).join(", ")}.`,
);
