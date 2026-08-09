/**
 * App metadata — read from package.json at runtime to avoid hand-syncing
 * the version when release-please bumps it (this file's `version` is the one
 * release-please mirrors here via `extra-files`; see docs/RELEASE.md).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface PackageJson {
  name: string;
  version: string;
  description?: string;
}

function loadPackageJson(): PackageJson {
  // dist/<bin>.js → ../package.json; src/<bin>.ts → ../package.json
  const path = resolve(__dirname, "..", "package.json");
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as PackageJson;
  } catch {
    return { name: "browser-tab-mcp", version: "0.0.0" };
  }
}

const pkg = loadPackageJson();

export const APP_NAME = pkg.name;
export const APP_VERSION = pkg.version;
export const APP_DESCRIPTION = pkg.description ?? "";

/**
 * Build identity — `<semver>+<count>.<sha>[.dirty.<ts>]`.
 *
 * Frozen into the bundle at build time by Vite `define` (scripts/build-stamp.mjs).
 * Plain semver only moves on release, so it cannot distinguish two builds
 * between releases — which is how a stale artifact keeps reporting a plausible
 * version. This changes on every build.
 */
declare const __BUILD_STAMP__: string | undefined;
declare const __BUILT_AT__: string | undefined;

/**
 * `tsx src/cli.ts` never goes through Vite, so there is no define to read.
 * Shell out to git lazily instead — only when someone actually asks for the
 * version, so normal startup never pays for it.
 */
function devStamp(): string {
  try {
    const git = (args: string[]) =>
      execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const count = git(["rev-list", "--count", "HEAD"]);
    const sha = git(["rev-parse", "--short=7", "HEAD"]);
    const dirty = git(["status", "--porcelain"]) !== "" ? ".dirty" : "";
    return `${APP_VERSION}+${count}.${sha}${dirty}.dev`;
  } catch {
    return `${APP_VERSION}+dev`;
  }
}

let cachedStamp: string | null = null;

export function buildStamp(): string {
  if (cachedStamp) return cachedStamp;
  cachedStamp = typeof __BUILD_STAMP__ === "string" ? __BUILD_STAMP__ : devStamp();
  return cachedStamp;
}

export function builtAt(): string | null {
  return typeof __BUILT_AT__ === "string" ? __BUILT_AT__ : null;
}
