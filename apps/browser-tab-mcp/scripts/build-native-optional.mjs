#!/usr/bin/env node
/**
 * Build the Rust accelerator if a toolchain is present; shrug if not.
 *
 * WHY THIS IS NOT A SHELL ONE-LINER ANY MORE. It used to be
 *
 *   (pnpm --filter @george43g/rust-accel build 2>/dev/null) || (echo '…' && exit 0)
 *
 * — a subshell, a `/dev/null` redirect and `||`, none of which `cmd.exe`
 * understands. On Windows that made `pnpm build` fail outright rather than
 * skipping an OPTIONAL component, which is the opposite of what the line was
 * for.
 *
 * The accelerator is genuinely optional: `native-bridge.ts` falls back to the
 * TypeScript path, and CI already tests both (`pnpm test:no-native`). The crate
 * target-gates its CoreGraphics dependency, so it compiles anywhere a Rust
 * toolchain exists — but a machine without `cargo` must still get a working
 * build.
 */

import { spawnSync } from "node:child_process";

const run = spawnSync("pnpm", ["--filter", "@george43g/rust-accel", "build"], {
  stdio: ["ignore", "inherit", "pipe"],
  shell: true,
});

if (run.status === 0) process.exit(0);

// Report WHY it was skipped. The old version discarded stderr entirely, so a
// real compile error looked identical to "no toolchain installed".
const stderr = (run.stderr?.toString() ?? "").trim();
const reason =
  /cargo|rustc|napi/i.test(stderr) && stderr ? stderr.split("\n").slice(-3).join("\n") : "";
process.stdout.write(
  "⚠️  Rust native build skipped — the TypeScript fallback will be used.\n" +
    (reason ? `   last lines from the build:\n   ${reason.replace(/\n/g, "\n   ")}\n` : ""),
);
process.exit(0);
