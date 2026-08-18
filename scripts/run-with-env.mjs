#!/usr/bin/env node
/**
 * `VAR=value command…`, portably.
 *
 * The `VAR=value command` prefix is POSIX shell syntax. Under `cmd.exe` — what
 * pnpm uses on Windows — it is not an assignment, it is a command name that
 * does not exist, so the script fails before running anything. This bit
 * `test:no-native`, which is the ENTIRE point of that script: it exists to
 * prove the TypeScript fallback path works, and on Windows it never ran at all.
 *
 * Usage: node scripts/run-with-env.mjs KEY=value [KEY=value…] -- <cmd> [args…]
 *
 * CAVEAT: the command runs through a shell (`shell: true`), which is required
 * on Windows — Node cannot spawn a `.CMD` shim like `vitest.CMD` without one.
 * That means arguments are re-parsed by the shell, so this is for fixed script
 * commands, not for passing arbitrary user input.
 */

import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 1) {
  process.stderr.write("usage: run-with-env.mjs KEY=value… -- <cmd> [args…]\n");
  process.exit(2);
}

const env = { ...process.env };
for (const pair of argv.slice(0, sep)) {
  const eq = pair.indexOf("=");
  if (eq < 1) {
    process.stderr.write(`run-with-env.mjs: "${pair}" is not KEY=value\n`);
    process.exit(2);
  }
  env[pair.slice(0, eq)] = pair.slice(eq + 1);
}

const [cmd, ...args] = argv.slice(sep + 1);
if (!cmd) {
  process.stderr.write("run-with-env.mjs: no command after --\n");
  process.exit(2);
}

// `shell: true` so a platform shim (vitest.CMD on Windows) resolves from
// node_modules/.bin the same way a shell would find it.
const r = spawnSync(cmd, args, { stdio: "inherit", shell: true, env });
process.exit(r.status ?? 1);
