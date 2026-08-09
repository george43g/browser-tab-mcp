/**
 * Build identity — `<semver>+<count>.<sha>[.dirty.<MMDDTHHmm>]`.
 *
 * Answers "is the build I think is running actually running", which plain
 * semver cannot: a version only moves on release, so every build between two
 * releases is indistinguishable. That is exactly how a stale extension bundle
 * can sit in the browser reporting a plausible version.
 *
 *   count  `git rev-list --count HEAD` — monotonic, so you can tell at a glance
 *          which of two builds is newer. Derived from history rather than a
 *          committed counter file, so it survives clean checkouts and agrees
 *          between a laptop and CI instead of colliding.
 *   sha    short commit — ties the build back to source.
 *   dirty  uncommitted changes. Two dev builds off the same commit would
 *          otherwise look identical, so a minute-resolution timestamp is
 *          appended to keep successive dev builds distinguishable.
 *
 * Consumed at build time via Vite `define` (see the vite.config.ts files) so
 * the stamp is frozen into the bundle rather than recomputed at runtime.
 *
 * ## Why the git part is also a CLI (`--print`)
 *
 * Turbo caches `build` on file inputs, and git state is not a file — so a
 * docs-only commit changed no input, turbo replayed `dist/`, and the bundle
 * kept claiming the PREVIOUS commit. A stamp that a cache replay can falsify
 * is worse than no stamp. So the identity is lifted into an env var that turbo
 * hashes: the root `build`/`stress` scripts run `--print` and export
 * `BUILD_STAMP`, `turbo.json` lists it in `tasks.build.env`, and `buildId()`
 * below prefers it — which makes what turbo HASHED and what Vite BAKED the same
 * string by construction.
 *
 * `BUILD_STAMP` carries only the git identity (`<count>.<sha>[.dirty.<ts>]`),
 * not the semver, because the two bundles have different versions and share one
 * env var. Side benefit: the four extension entries are separate Vite passes, so
 * computing per-pass could straddle a minute boundary and stamp the same build
 * two ways; one exported value can't.
 */

import { execFileSync } from "node:child_process";

function git(args, fallback = "") {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // No git (published tarball, shallow container) — degrade, never throw.
    return fallback;
  }
}

const pad = (n) => String(n).padStart(2, "0");

/** Version-independent git identity: `<count>.<sha>[.dirty.<MMDDTHHmm>]`. */
export function computeBuildId() {
  const count = git(["rev-list", "--count", "HEAD"], "0");
  const sha = git(["rev-parse", "--short=7", "HEAD"], "nogit");
  const dirty = git(["status", "--porcelain"]) !== "";

  let id = `${count}.${sha}`;
  if (dirty) {
    const d = new Date();
    id += `.dirty.${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}`;
  }
  return id;
}

/**
 * The identity to bake in: the exported `BUILD_STAMP` when the caller set one
 * (the value turbo hashed), else computed here.
 */
export function buildId() {
  const fromEnv = process.env.BUILD_STAMP?.trim();
  if (fromEnv) return fromEnv;
  // Inside a turbo task (TURBO_HASH is set by turbo) an unset BUILD_STAMP means
  // git state is NOT in the cache key — the exact hole that let a replayed
  // dist/ claim the wrong commit. Say so instead of silently stamping.
  if (process.env.TURBO_HASH) {
    process.emitWarning(
      "BUILD_STAMP is unset inside a turbo task: build identity is not part of the " +
        "cache key, so a cached dist/ can carry a stale commit. Use `pnpm build` " +
        "(which exports it) rather than calling turbo directly.",
    );
  }
  return computeBuildId();
}

/** Compute the stamp for a given semver. */
export function buildStamp(version) {
  return `${version}+${buildId()}`;
}

/** The `define` block both bundles share. */
export function buildDefines(version) {
  return {
    __BUILD_STAMP__: JSON.stringify(buildStamp(version)),
    __BUILT_AT__: JSON.stringify(new Date().toISOString()),
  };
}

// CLI: `node scripts/build-stamp.mjs --print` → the git identity, for the root
// build scripts to export as BUILD_STAMP. Always recomputed from git (an
// inherited BUILD_STAMP would defeat the point of asking).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--print")) process.stdout.write(`${computeBuildId()}\n`);
  else {
    process.stderr.write("usage: node scripts/build-stamp.mjs --print\n");
    process.exit(2);
  }
}
