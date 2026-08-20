#!/usr/bin/env node
/**
 * rust-accel's `build` script: `napi build` when a Rust toolchain exists,
 * a logged skip when none does.
 *
 * Turbo runs rust-accel#build on EVERY root `pnpm build`, so the app-level
 * guard (apps/browser-tab-mcp/scripts/build-native-optional.mjs) never gets
 * a say — a rustless machine failed the whole build before it could shrug.
 * CI cannot catch this: every GitHub runner image (linux, macos AND windows)
 * ships a preinstalled Rust toolchain, so the unguarded step looks
 * conditional-free until someone builds on a real machine with stock Node.
 * That machine was George's Windows box, 2026-08-21. The class of bug is
 * "the harness is more provisioned than the target".
 *
 * The asymmetry is deliberate: a MISSING toolchain skips (the accelerator is
 * optional — native-bridge.ts falls back to TS), but a PRESENT toolchain
 * that fails to compile still fails the build — that's a defect, not an
 * absence.
 *
 * Turbo caveat: a skip caches an empty output set for the current input
 * hash, so installing Rust later won't rebuild until an input changes.
 * `pnpm --filter rust-accel build` (the documented Troubleshooting path)
 * bypasses turbo and builds immediately.
 *
 * shell:true on both spawns: on Windows, `napi` is a .CMD shim that Node
 * refuses to spawn shell-less (EINVAL, CVE-2024-27980 hardening), and the
 * probe must resolve the same way the build does.
 */

import { spawnSync } from "node:child_process";

const probe = spawnSync("rustc", ["--version"], { stdio: "ignore", shell: true });
if (probe.error || probe.status !== 0) {
  process.stdout.write(
    "rust-accel: no Rust toolchain (rustc not runnable) — skipping the optional native build; the TypeScript fallback will be used.\n",
  );
  process.exit(0);
}

const build = spawnSync("napi", ["build", "--platform", "--release"], {
  stdio: "inherit",
  shell: true,
});
process.exit(build.status ?? 1);
