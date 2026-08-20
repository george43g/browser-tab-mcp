#!/usr/bin/env node
/**
 * The macOS half of CI, run where macOS actually is.
 *
 * WHY THIS EXISTS. `.github/workflows/ci.yml` deliberately has no
 * `macos-latest` leg: GitHub bills macOS at 10x Linux on a private repo, and on
 * 2026-08-18 that leg was 71% of the day's CI spend (38 jobs, 131 billable
 * minutes, $10.48) while testing almost nothing Linux did not. Almost — the
 * exception is real, and this script is it.
 *
 * WHAT ONLY A MAC CAN CHECK. `apps/rust-accel` splits on
 * `#[cfg(target_os = "macos")]`: the CoreGraphics implementation of
 * `list_cg_windows()` / `list_displays()` compiles ONLY on Darwin, and every
 * other target compiles a stub. No Linux or Windows runner ever type-checks,
 * borrow-checks or links that code — and it produces the cgWindowId that the
 * whole wm-stack join depends on. Everything else the macOS leg ran (lint,
 * typecheck, the suite, stress) is platform-independent and still runs on Linux.
 *
 * This is STRICTER than the runner was. macos-latest only proved the crate
 * COMPILED; here we compile it, load the resulting .node, and call into
 * CoreGraphics for real.
 *
 * Run with `pnpm verify:macos`. `.githooks/pre-push` runs it for you.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ACCEL = join(ROOT, "apps", "rust-accel");

const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const OFF = "\x1b[0m";

const say = (m) => process.stdout.write(`\n${BOLD}> ${m}${OFF}\n`);
const ok = (m) => process.stdout.write(`  ${GREEN}ok${OFF} ${m}\n`);
function die(m, hint) {
  process.stderr.write(`\n${RED}FAIL: ${m}${OFF}\n${hint ? `  ${hint}\n` : ""}`);
  process.exit(1);
}

function run(cmd, args, label) {
  say(label);
  try {
    execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
  } catch {
    die(
      `${label} failed.`,
      "Fix it before pushing, or use `git push --no-verify` if you know why.",
    );
  }
  ok(label);
}

// A non-Mac cannot perform these checks and must not be blocked by them. Linux
// CI remains the authority for everything else, so skipping is correct here
// rather than lenient.
if (process.platform !== "darwin") {
  process.stdout.write(
    `verify:macos - skipped: this is ${process.platform}, and these checks are Darwin-only.\n`,
  );
  process.exit(0);
}

// Without a Rust toolchain the ONE thing this script exists for cannot happen:
// `build:native:optional` would silently skip, and every assertion below would
// then pass against a stale or absent binary. That is a green run proving
// nothing, which is worse than a red one.
try {
  execFileSync("rustc", ["--version"], { stdio: "ignore" });
} catch {
  die(
    "no Rust toolchain, so the CoreGraphics code cannot be built.",
    "Install it (https://rustup.rs) - compiling that code is this script's whole purpose.",
  );
}

run(
  "pnpm",
  ["--filter", "rust-accel", "build"],
  "Build rust-accel (compiles the CoreGraphics path)",
);

say("Load the built native module and call into CoreGraphics");
const built = existsSync(ACCEL)
  ? readdirSync(ACCEL).filter((f) => f.endsWith(".node") && f.includes("darwin"))
  : [];
if (built.length === 0) die("the build produced no darwin .node.", `Looked in ${ACCEL}`);
ok(`built ${built.join(", ")}`);

const native = createRequire(import.meta.url)(join(ACCEL, "index.js"));

// The two macOS-only entry points, exercised for real. list_cg_windows needs no
// Screen Recording consent because it deliberately never reads kCGWindowName.
const windows = native.listCgWindows();
if (!Array.isArray(windows)) die("listCgWindows() did not return an array.");
ok(`listCgWindows() -> ${windows.length} window(s)`);

const displays = native.listDisplays();
if (!Array.isArray(displays) || displays.length === 0) {
  die("listDisplays() returned nothing - a Mac always has at least one display.");
}
ok(`listDisplays() -> ${displays.length} display(s)`);

// Shape check, so a silently-empty struct cannot pass as success — and so a
// renamed `#[napi(js_name = "...")]` is caught. The Rust<->Zod drift test
// compares SOURCE field names; only calling the built binary proves what napi
// actually emits at runtime, and a silent rename here would strip cgWindowId
// out of the wm-stack join without any test going red.
const badWindow = windows.find(
  (w) => typeof w.windowId !== "number" || typeof w.ownerPid !== "number",
);
if (badWindow) die(`a CG window came back malformed: ${JSON.stringify(badWindow)}`);
ok("CG windows carry numeric windowId + ownerPid");

const badDisplay = displays.find(
  (d) => typeof d.displayId !== "number" || typeof d.isMain !== "boolean",
);
if (badDisplay) die(`a display came back malformed: ${JSON.stringify(badDisplay)}`);
if (!displays.some((d) => d.isMain)) die("no display reports isMain - the napi mapping is wrong.");
ok("displays carry numeric displayId + boolean isMain, exactly one main");

run("pnpm", ["test"], "Test suite on the native path (the run CI can no longer make)");

process.stdout.write(
  `\n${GREEN}verify:macos passed${OFF} - the Darwin-only code is built, loaded and working.\n`,
);
