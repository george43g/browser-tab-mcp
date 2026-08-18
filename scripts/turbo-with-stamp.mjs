#!/usr/bin/env node
/**
 * Run a turbo task with `BUILD_STAMP` exported.
 *
 * WHY THIS IS NOT A SHELL ONE-LINER ANY MORE. The root scripts used to read
 *
 *   BUILD_STAMP=$(node scripts/build-stamp.mjs --print) turbo run build
 *
 * which is POSIX-only twice over: the `VAR=value command` prefix and the `$( )`
 * substitution. Under `cmd.exe` — what pnpm uses on Windows — that is not a
 * build command, it is a syntax error, so `pnpm build` could not run there at
 * all. The stamp itself is load-bearing (turbo.json lists BUILD_STAMP in
 * `tasks.build.env`, which is what stops a cached `dist/` from claiming an
 * older commit), so it cannot simply be dropped.
 *
 * Doing it in Node keeps ONE code path on every OS. The alternative —
 * pnpm's `shell-emulator` — would have changed how every script in the repo is
 * parsed on macOS and Linux too, to fix two lines.
 *
 * Usage: node scripts/turbo-with-stamp.mjs <task> [...turbo args]
 */

import { spawnSync } from "node:child_process";
import { computeBuildId } from "./build-stamp.mjs";

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write("usage: node scripts/turbo-with-stamp.mjs <task> [...turbo args]\n");
  process.exit(2);
}

// `shell: true` so the platform's `turbo` shim (turbo.CMD on Windows) resolves
// from node_modules/.bin the same way it does from a shell script.
const result = spawnSync("turbo", ["run", ...args], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, BUILD_STAMP: computeBuildId() },
});
process.exit(result.status ?? 1);
