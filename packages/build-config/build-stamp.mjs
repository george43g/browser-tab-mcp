#!/usr/bin/env node

/**
 * Build identity: a stamp that answers "is the artifact running the one I just
 * built?" as a fact rather than a guess.
 *
 * Semver only moves on release, so every build between two releases is
 * otherwise indistinguishable.
 *
 *   <semver>+<count>.<sha>[.dirty.<MMDDTHHmm>]
 *   0.9.0+412.a1b2c3d
 *   0.9.0+412.a1b2c3d.dirty.0809T0612
 *
 * WHY THIS PACKAGE IS PRIVATE AND MUST STAY THAT WAY
 *
 * Vite's `define` is compile-time textual substitution applied only to modules
 * Vite bundles. A module marked `external` never passes through it. Our apps
 * list `/^@george43g\//` in `rollupOptions.external`, and generated repos
 * install the kits from npm as real external dependencies — so a `buildStamp()`
 * exported from a PUBLISHED kit would reference a `__BUILD_STAMP__` that is
 * never substituted in the consumer.
 *
 * The failure mode is the dangerous kind: it degrades to a plausible-looking
 * fallback instead of erroring, so it looks like it worked. The reader must
 * live in the consumer's own bundled graph, which is why this is a
 * devDependency that produces `define` values, not a runtime export.
 *
 * Every git call degrades rather than throwing, so a published tarball or a
 * shallow container still builds.
 */

import { execFileSync } from "node:child_process";

function git(args, fallback) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return fallback;
  }
}

/**
 * Commit count — monotonic, so it tells you which of two builds is newer at a
 * glance. Derived from history rather than a committed counter, so it survives
 * a clean checkout and agrees between a laptop and CI instead of colliding.
 *
 * Returns "0" when git is unavailable OR the checkout is shallow. A shallow
 * clone reports a real-looking small number (1 on a default CI checkout), which
 * is worse than an obvious zero — hence the explicit shallow probe.
 */
function commitCount() {
  const shallow = git(["rev-parse", "--is-shallow-repository"], "true");
  if (shallow === "true") return "0";
  return git(["rev-list", "--count", "HEAD"], "0");
}

/** `MMDDTHHmm` — minute resolution separates two dev builds off one commit. */
function dirtyStamp(now) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(now.getMonth() + 1)}${p(now.getDate())}T${p(now.getHours())}${p(now.getMinutes())}`;
}

/**
 * @param {string} version  the package's semver, e.g. "0.9.0"
 * @param {Date}   [now]    injectable for tests
 * @returns {string} the full stamp
 */
export function buildStamp(version, now = new Date()) {
  const count = commitCount();
  const sha = git(["rev-parse", "--short=7", "HEAD"], "nogit");
  const dirty = git(["status", "--porcelain"], "");
  const suffix = dirty === "" ? "" : `.dirty.${dirtyStamp(now)}`;
  return `${version}+${count}.${sha}${suffix}`;
}

/**
 * Values ready to spread into a Vite `define`.
 *
 * `JSON.stringify` is required: `define` substitutes the value TEXTUALLY, so a
 * bare string would be emitted as an identifier and fail to parse.
 */
export function buildDefines(version, now = new Date()) {
  // `BUILD_STAMP` wins when set. turbo lists it in the build task's `env`, so
  // setting it makes the stamp part of the cache key — without that, a cached
  // build can replay an older stamp, which is precisely the stale-artifact
  // confusion this feature exists to remove.
  const stamp = process.env.BUILD_STAMP || buildStamp(version, now);
  return {
    __BUILD_STAMP__: JSON.stringify(stamp),
    __BUILT_AT__: JSON.stringify(now.toISOString()),
  };
}

// `--print` entry point. The turbo build task reads BUILD_STAMP from this, and
// it is the only way to see the stamp without running a build.
if (process.argv[2] === "--print") {
  const version = process.argv[3] ?? "0.0.0";
  process.stdout.write(`${buildStamp(version)}\n`);
}
