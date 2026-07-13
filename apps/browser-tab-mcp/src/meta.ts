/**
 * App metadata — read from package.json at runtime to avoid hand-syncing
 * the version when semantic-release bumps it.
 */

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
