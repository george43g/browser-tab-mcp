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

import { execFileSync } from "node:child_process";
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

/**
 * Colour survived the bundler.
 *
 * Vite's default `resolve.mainFields`/`conditions` lead with `"browser"`, so a
 * dependency that ships a browser build gets it — silently, with no warning and
 * no failure. `picocolors` ships `picocolors.browser.js` whose every colour
 * function is `String`, so the whole human CLI rendered in flat monochrome
 * while `tsx src/cli.ts` and vitest (which resolve like Node) stayed colourful.
 * The defect was invisible to every test that ran on source.
 *
 * The behavioural check below is the one that matters: it runs the REAL bin and
 * asserts bytes on the wire, so it catches the class regardless of which
 * dependency gets swapped next. Reverting the `resolve` block in
 * `vite.config.ts` MUST turn it red.
 */
/** A literal ESC would be an invisible control byte in source; spell it. */
const ANSI_SEQ = /\u001b\[/g;

describe("colour survives the bundler (node build must not take browser builds)", () => {
  /**
   * `FORCE_HUMAN` defeats the piped-stdout/CI inference that would otherwise
   * select JSON; `FORCE_COLOR` defeats the isatty check. Both are cli-kit's
   * documented escape hatches, so this needs no pty. `BROWSER_TAB_FAKE_ADAPTER`
   * keeps it hermetic — no daemon, no browser, no osascript.
   */
  const runList = (): string =>
    execFileSync(process.execPath, [join(DIST, "cli.js"), "list"], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        FORCE_HUMAN: "1",
        FORCE_COLOR: "1",
        BROWSER_TAB_FAKE_ADAPTER: "1",
        NO_COLOR: "",
      },
    });

  it("the built bin emits ANSI when colour is forced", () => {
    const out = runList();
    expect(out, "fake-adapter `list` produced no output at all").toContain("chrome");
    const ansi = out.match(ANSI_SEQ) ?? [];
    expect(
      ansi.length,
      "the built bin emitted ZERO ANSI sequences under FORCE_COLOR — a dependency's " +
        "browser build was bundled (check `resolve.mainFields`/`conditions` in vite.config.ts)",
    ).toBeGreaterThan(0);
  });

  it("no dist chunk contains a dependency's browser build", () => {
    const offenders: string[] = [];
    for (const file of distJsFiles()) {
      const hits = readFileSync(join(DIST, file), "utf8").match(/\b[A-Za-z0-9$]+_browser\b/g);
      if (hits) offenders.push(`${file}: ${[...new Set(hits)].join(", ")}`);
    }
    expect(
      offenders,
      `built output bundled a browser variant of a dependency — this is a NODE build:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
