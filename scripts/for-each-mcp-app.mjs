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
import { basename } from "node:path";

import { REPO_ROOT, requireMcpApps } from "./lib/mcp-apps.mjs";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("for-each-mcp-app: FAILED — no pnpm script or command given.");
  console.error("  Usage: node scripts/for-each-mcp-app.mjs <pnpm-script> [args…]");
  process.exit(2);
}

const apps = requireMcpApps("for-each-mcp-app");

/**
 * How to run pnpm without assuming `spawn("pnpm")` works — it does not on
 * Windows, where pnpm on PATH is `pnpm.cmd` and spawn only resolves `.cmd`
 * through a shell (ENOENT otherwise; measured on windows-latest).
 *
 * 1. Under `pnpm run`, npm_execpath is pnpm itself: its JS entry (run it with
 *    this node) or a standalone binary (spawn it directly). No shell at all.
 *    The basename must say pnpm: under `npm run` it is npm-cli.js, and
 *    `npm --filter …` is not what was asked for.
 * 2. Otherwise (`node scripts/for-each-mcp-app.mjs …` straight from CI), POSIX
 *    spawns `pnpm` directly and Windows goes through cmd.exe as ONE command
 *    string. One string, not `shell: true` plus an args array: Node 24
 *    deprecates that pair (DEP0190) because it concatenates without escaping.
 *    The args are package and script names from this repo, never user input;
 *    each is still double-quoted when it holds anything cmd.exe would read.
 */
function pnpmInvocation(pnpmArgs) {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: set by pnpm itself, not a turbo task input.
  const execPath = process.env.npm_execpath ?? "";
  const name = basename(execPath).toLowerCase();
  if (/^pnpm\.[cm]?js$/.test(name)) {
    return { cmd: process.execPath, args: [execPath, ...pnpmArgs], shell: false };
  }
  if (name === "pnpm" || name === "pnpm.exe") {
    return { cmd: execPath, args: pnpmArgs, shell: false };
  }
  if (process.platform !== "win32") return { cmd: "pnpm", args: pnpmArgs, shell: false };
  const quoted = pnpmArgs.map((a) => (/^[\w@/.:=,+-]+$/.test(a) ? a : `"${a}"`));
  return { cmd: ["pnpm", ...quoted].join(" "), args: [], shell: true };
}

const failed = [];
for (const app of apps) {
  console.log(`\n-- for-each-mcp-app: ${app.name} > pnpm ${args.join(" ")}`);
  const pnpm = pnpmInvocation(["--filter", app.name, ...args]);
  const run = spawnSync(pnpm.cmd, pnpm.args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: pnpm.shell,
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
