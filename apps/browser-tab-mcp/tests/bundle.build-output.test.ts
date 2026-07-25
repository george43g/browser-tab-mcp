/**
 * Static guard on the BUILT dist/ bundle — the global-install contract CI
 * otherwise can't see. The bin must be SELF-CONTAINED: `@george43g/*`
 * workspace packages (`private:true`, unpublished) are bundled inline, NOT
 * left as runtime `import`s, so `pnpm add -g .` installs only the real npm
 * deps and the bin runs outside the workspace.
 *
 * Deliberately re-externalizing the workspace packages (re-adding
 * `/^@george43g\//` to vite.config.ts `external`, or setting them back as
 * runtime `dependencies`) MUST turn this red.
 *
 * Requires a prior build: this package's turbo.json makes `test` depend on
 * its own `build`, so dist/ is fresh whenever the suite runs.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");

/** Only import-position specifiers — NOT `@george43g` inside help-text strings. */
const IMPORT_SPECIFIER = /(?:\bfrom|\bimport|\brequire\()\s*["']@george43g\/[^"']+["']/g;

const distJsFiles = (): string[] =>
  existsSync(DIST) ? readdirSync(DIST).filter((f) => f.endsWith(".js")) : [];

describe("built bin is self-contained (global-install contract)", () => {
  it("dist/ is present (run `pnpm --filter @george43g/browser-tab-mcp build` first)", () => {
    expect(existsSync(join(DIST, "cli.js")), "dist/cli.js missing — build the app first").toBe(
      true,
    );
    expect(existsSync(join(DIST, "index.js")), "dist/index.js missing — build the app first").toBe(
      true,
    );
  });

  it("no dist chunk imports a @george43g/* workspace package (they must bundle inline)", () => {
    const offenders: string[] = [];
    for (const file of distJsFiles()) {
      const src = readFileSync(join(DIST, file), "utf8");
      const hits = src.match(IMPORT_SPECIFIER);
      if (hits) offenders.push(`${file}: ${[...new Set(hits)].join(", ")}`);
    }
    expect(
      offenders,
      `built output still imports @george43g/* (bundle regressed — check vite.config external + package.json deps):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the bin carries the node shebang", () => {
    expect(readFileSync(join(DIST, "cli.js"), "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  });
});
