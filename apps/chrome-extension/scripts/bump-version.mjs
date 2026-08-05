#!/usr/bin/env node
/**
 * Manual version bump for the connector extension.
 *
 * The manifest `version` is the ONLY user-facing version of this extension —
 * Chrome/Safari surface it in the extensions list, and it is NOT published to
 * npm (the app is `private`). This command keeps `public/manifest.json` and
 * `package.json` in lockstep so one invocation bumps "the extension version",
 * and a build-output test (`tests/build-output.test.ts`) fails CI if they drift.
 *
 * Usage (from the repo root):
 *   pnpm --filter @george43g/chrome-extension run bump           # patch (default)
 *   pnpm --filter @george43g/chrome-extension run bump minor
 *   pnpm --filter @george43g/chrome-extension run bump major
 *   pnpm --filter @george43g/chrome-extension run bump 1.4.0     # explicit X.Y.Z
 *
 * A bumped file is NOT a reloaded extension: rebuild + reload afterward
 * (`build`, then chrome://extensions reload, or `safari-extension sideload`).
 * This is separate from the wire `protocolVersion` (single-sourced as
 * WIRE_PROTOCOL_VERSION in @george43g/shared-types — bump that when the
 * daemon↔extension contract changes) and from npm release (deliberately off).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "public", "manifest.json");
const PKG = join(ROOT, "package.json");

// Anchored to a line-leading `"version"` key so it never matches
// `"manifest_version": 3` (unquoted value) or any nested field.
const VERSION_RE = /^(\s*"version":\s*")(\d+\.\d+\.\d+)(")/m;
const SEMVER = /^\d+\.\d+\.\d+$/;

/** Read the current version out of a JSON file without reformatting it. */
function readVersion(path) {
  const match = VERSION_RE.exec(readFileSync(path, "utf8"));
  if (!match) throw new Error(`no top-level "version" field in ${path}`);
  return match[2];
}

/** Rewrite ONLY the version substring, leaving every other byte untouched. */
function writeVersion(path, next) {
  const src = readFileSync(path, "utf8");
  if (!VERSION_RE.test(src)) throw new Error(`no top-level "version" field in ${path}`);
  writeFileSync(path, src.replace(VERSION_RE, `$1${next}$3`));
}

function nextVersion(current, arg) {
  if (SEMVER.test(arg)) return arg; // explicit target
  const [major, minor, patch] = current.split(".").map(Number);
  switch (arg) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`unknown bump "${arg}" — use patch | minor | major | X.Y.Z`);
  }
}

const arg = process.argv[2] ?? "patch";
const current = readVersion(MANIFEST);
if (!SEMVER.test(current)) throw new Error(`manifest version "${current}" is not X.Y.Z`);

// Guard the invariant the test enforces: the two files must already agree.
const pkgCurrent = readVersion(PKG);
if (pkgCurrent !== current) {
  throw new Error(
    `manifest (${current}) and package.json (${pkgCurrent}) are out of sync — reconcile before bumping`,
  );
}

const next = nextVersion(current, arg);
writeVersion(MANIFEST, next);
writeVersion(PKG, next);

console.log(`browser-tab connector: ${current} → ${next}`);
console.log(
  "Next: `pnpm --filter @george43g/chrome-extension build`, then reload in chrome://extensions (or `safari-extension sideload` + toggle).",
);
