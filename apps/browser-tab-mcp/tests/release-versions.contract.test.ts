/**
 * One repo, one version — enforced.
 *
 * WHY THIS EXISTS. `apps/chrome-extension` carried its own hand-bumped version
 * and sat at `0.2.0` while the tool shipped `1.1.1`. Nothing was red, because
 * nothing compared the two: the extension's own test only checked that its
 * `package.json` and `manifest.json` agreed *with each other*, which they
 * happily did — at the wrong number. Safari's Settings pane reads that manifest
 * version, so the browser confidently displayed a version that had not moved in
 * seven releases.
 *
 * The fix was to let release-please own every version-carrying file
 * (`extra-files` in release-please-config.json). This test is what stops the
 * fix from rotting: add a versioned file and forget to declare it, or let one
 * drift off the released version, and CI goes red naming the file.
 *
 * WHY IT LIVES HERE. The invariant is repo-wide, and this repo has no root test
 * package — `pnpm test` is `turbo run test`, per workspace. `browser-tab-mcp`
 * is the release artifact and the version it carries is the one `--version`
 * prints, so it is the package with the strongest claim to owning "is the
 * release version coherent". The test only READS files above itself.
 *
 * WHAT IT DOES NOT CLAIM. Discovery is not magic: it scans every workspace
 * `package.json` plus the extension manifest — the files that carry a version
 * today. A future version-carrying file of some other shape (an Info.plist, a
 * Cargo.toml) must be added to NON_PACKAGE_VERSION_FILES below. The Safari
 * container app is deliberately absent: its Xcode project is gitignored and its
 * version is stamped at build time from the manifest (see
 * apps/safari-extension/scripts/rebuild.sh).
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * The sentinel for "this package is internal and deliberately unversioned".
 * Workspace packages that ship *inside* the bin use it; they have no external
 * consumer to version for, so release-please rightly ignores them.
 */
const UNVERSIONED = "0.0.0";

/** Version-carrying files that are not a workspace `package.json`. */
const NON_PACKAGE_VERSION_FILES = ["apps/chrome-extension/public/manifest.json"];

interface VersionFile {
  /** Repo-relative POSIX path — the same string release-please config uses. */
  path: string;
  version: string;
}

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(REPO, path), "utf8")) as Record<string, unknown>;

/** Every `package.json` in the workspace, plus the root one. */
function workspacePackageJsons(): string[] {
  const found = ["package.json"];
  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(join(REPO, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = `${group}/${entry.name}/package.json`;
      try {
        readFileSync(join(REPO, rel), "utf8");
        found.push(rel);
      } catch {
        // A directory without a package.json is not a workspace member.
      }
    }
  }
  return found;
}

function allVersionFiles(): VersionFile[] {
  return [...workspacePackageJsons(), ...NON_PACKAGE_VERSION_FILES]
    .map((path) => ({ path, version: readJson(path).version as string }))
    .filter((f) => typeof f.version === "string");
}

/** Paths release-please rewrites on every release. */
function releasePleaseOwned(): { root: string; extras: string[] } {
  const config = readJson("release-please-config.json");
  const packages = config.packages as Record<string, { "extra-files"?: { path: string }[] }>;
  const root = packages["."];
  // A throw rather than an expect(): every caller dereferences `root`, so a
  // missing release line has to stop this function, not just fail one assertion.
  if (!root) throw new Error('release-please-config.json lost the root "." release line');
  return {
    // The `node` release-type rewrites the release line's own package.json.
    root: "package.json",
    extras: (root["extra-files"] ?? []).map((f) => f.path),
  };
}

const releasedVersion = (): string => readJson(".release-please-manifest.json")["."] as string;

describe("release version coherence", () => {
  it("every file claiming a real version is one release-please rewrites", () => {
    const { root, extras } = releasePleaseOwned();
    const owned = new Set([root, ...extras]);

    const claiming = allVersionFiles().filter((f) => f.version !== UNVERSIONED);
    const unowned = claiming.filter((f) => !owned.has(f.path));

    expect(
      unowned.map((f) => `${f.path} (${f.version})`),
      "these files carry a version release-please does not rewrite, so they will " +
        "silently freeze while the repo releases past them — add each to " +
        '"extra-files" in release-please-config.json, or set it to 0.0.0 if it is ' +
        "an internal package that should not be versioned",
    ).toEqual([]);
  });

  it("every release-please-owned file already holds the released version", () => {
    const { root, extras } = releasePleaseOwned();
    const expected = releasedVersion();

    const drifted = [root, ...extras]
      .map((path) => ({ path, version: readJson(path).version as string }))
      .filter((f) => f.version !== expected);

    expect(
      drifted.map((f) => `${f.path} is ${f.version}`),
      `.release-please-manifest.json says ${expected}; these disagree. release-please ` +
        "writes all of them in one commit, so drift means a file was added to " +
        "extra-files without reconciling it, or edited by hand",
    ).toEqual([]);
  });

  it("declares every extra-file path that actually exists", () => {
    const { extras } = releasePleaseOwned();
    const missing = extras.filter((path) => {
      try {
        readFileSync(join(REPO, path), "utf8");
        return false;
      } catch {
        return true;
      }
    });
    expect(
      missing,
      "release-please skips extra-files it cannot find — silently, with a green " +
        "release. A stale path here is a version that stops moving",
    ).toEqual([]);
  });

  it("the released version is loadable as a Chrome extension version", () => {
    // Chrome's grammar is NOT semver: 1-4 dot-separated integers, 0..65535, no
    // leading zeros, and no pre-release or build suffix. The manifest is now an
    // extra-file, so the day release-please cuts `1.2.0-rc.1` Chrome refuses to
    // load the extension at all. Fail here instead of in the browser.
    const version = releasedVersion();
    const parts = version.split(".");
    expect(parts.length, `"${version}" must have 1-4 dot-separated parts`).toBeLessThanOrEqual(4);
    for (const part of parts) {
      expect(part, `"${version}": part "${part}" must be digits only (no -rc, no +build)`).toMatch(
        /^(0|[1-9]\d*)$/,
      );
      expect(Number(part), `"${version}": part "${part}" must be <= 65535`).toBeLessThanOrEqual(
        65535,
      );
    }
  });

  it("keeps the released version out of the repo-relative path assumptions", () => {
    // Cheap canary on the REPO resolver: if this file ever moves, the reads
    // above would fail confusingly. Assert we found the real repo root.
    expect(relative(REPO, join(REPO, "release-please-config.json"))).toBe(
      "release-please-config.json",
    );
    expect(readJson("package.json").name).toBe("browser-tab");
  });
});
