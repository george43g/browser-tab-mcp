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

/** Compute the stamp for a given semver. */
export function buildStamp(version) {
  const count = git(["rev-list", "--count", "HEAD"], "0");
  const sha = git(["rev-parse", "--short=7", "HEAD"], "nogit");
  const dirty = git(["status", "--porcelain"]) !== "";

  let stamp = `${version}+${count}.${sha}`;
  if (dirty) {
    const d = new Date();
    stamp += `.dirty.${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}`;
  }
  return stamp;
}

/** The `define` block both bundles share. */
export function buildDefines(version) {
  return {
    __BUILD_STAMP__: JSON.stringify(buildStamp(version)),
    __BUILT_AT__: JSON.stringify(new Date().toISOString()),
  };
}
