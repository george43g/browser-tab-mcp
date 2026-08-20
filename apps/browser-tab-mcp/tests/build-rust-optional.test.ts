/**
 * The optional-native build guard (scripts/build-rust-optional.mjs, wired as
 * rust-accel's `build` script) must SKIP — exit 0, say why — on a machine
 * with no Rust toolchain, and must PROPAGATE a real build failure when a
 * toolchain exists. CI can't cover the skip half naturally: every GitHub
 * runner image preinstalls Rust, so these tests manufacture both worlds via
 * PATH. The bug this guards against: turbo ran a raw `napi build` on every
 * root `pnpm build`, hard-failing the whole build on George's rustless
 * Windows box (2026-08-21) while every CI leg stayed green.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARD = resolve(__dirname, "../../../scripts/build-rust-optional.mjs");
const RUST_ACCEL_DIR = resolve(__dirname, "../../rust-accel");
const isWin = process.platform === "win32";

function makeFakeBin(dir: string, name: string, exitCode: number): void {
  if (isWin) {
    writeFileSync(join(dir, `${name}.cmd`), `@exit /b ${exitCode}\r\n`);
  } else {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\nexit ${exitCode}\n`);
    chmodSync(p, 0o755);
  }
}

function runGuard(pathValue: string) {
  return spawnSync(process.execPath, [GUARD], {
    cwd: RUST_ACCEL_DIR,
    env: {
      ...process.env,
      PATH: pathValue,
      ...(isWin ? { Path: pathValue, PATHEXT: ".COM;.EXE;.BAT;.CMD" } : {}),
    },
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("build-rust-optional guard", () => {
  it("skips with exit 0 and a reason when rustc is not on PATH", () => {
    const run = runGuard("");
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/skipping the optional native build/);
    expect(run.stdout).toMatch(/TypeScript fallback/);
  });

  it("propagates napi's failure when a toolchain IS present", () => {
    const fakes = mkdtempSync(join(tmpdir(), "bt-fake-toolchain-"));
    makeFakeBin(fakes, "rustc", 0);
    makeFakeBin(fakes, "napi", 3);
    const run = runGuard(fakes);
    expect(run.status).toBe(3);
    expect(run.stdout).not.toMatch(/skipping the optional native build/);
  });
});
