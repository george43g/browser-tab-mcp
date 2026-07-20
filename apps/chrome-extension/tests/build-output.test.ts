/**
 * Static guards on the BUILT dist/ bundle — the Safari classic-script contract
 * CI otherwise can't see. Deliberately breaking any of these (drop
 * background.scripts, reintroduce background.type:"module", ship an ES-module
 * background) MUST turn this suite red.
 *
 * Requires a prior build: CI runs `pnpm build` before `pnpm test`, and this
 * package's turbo.json makes `test` depend on its own `build`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");

const read = (file: string): string => readFileSync(join(DIST, file), "utf8");

interface Manifest {
  manifest_version: number;
  background?: { service_worker?: string; scripts?: string[]; type?: string };
  options_page?: string;
  action?: { default_popup?: string; default_icon?: Record<string, string> };
  icons?: Record<string, string>;
}

const manifest = (): Manifest => JSON.parse(read("manifest.json")) as Manifest;

describe("built manifest.json", () => {
  it("is present (run the extension build first)", () => {
    expect(
      existsSync(join(DIST, "manifest.json")),
      "dist/manifest.json missing — run `pnpm --filter @george43g/chrome-extension build`",
    ).toBe(true);
  });

  it("is MV3", () => {
    expect(manifest().manifest_version).toBe(3);
  });

  it("ships BOTH background keys (Chrome service_worker + Safari background page)", () => {
    const bg = manifest().background;
    expect(bg?.service_worker, "background.service_worker (Chrome) missing").toBeTruthy();
    expect(
      Array.isArray(bg?.scripts) && bg.scripts.length > 0,
      "background.scripts (Safari background page) missing",
    ).toBe(true);
  });

  it("does NOT declare background.type:module (Safari can't load a module SW)", () => {
    expect(manifest().background?.type).not.toBe("module");
  });

  it("wires the popup and options pages", () => {
    expect(manifest().action?.default_popup).toBeTruthy();
    expect(manifest().options_page).toBeTruthy();
  });

  it("references only assets that exist on disk", () => {
    const m = manifest();
    const paths = [
      ...Object.values(m.icons ?? {}),
      ...Object.values(m.action?.default_icon ?? {}),
      m.action?.default_popup,
      m.options_page,
    ].filter((p): p is string => typeof p === "string");
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(existsSync(join(DIST, p)), `missing dist asset: ${p}`).toBe(true);
    }
  });
});

describe("built entry JS is a classic IIFE (not ES modules)", () => {
  for (const file of ["background.js", "options.js", "popup.js"]) {
    it(`${file}: no top-level import/export, no dynamic import, wrapped in an IIFE`, () => {
      const src = read(file);
      const offending = src.split("\n").filter((l) => /^\s*(import|export)\b/.test(l));
      expect(offending, `top-level module syntax in ${file}:\n${offending.join("\n")}`).toEqual([]);
      expect(src.includes("import("), `dynamic import() in ${file}`).toBe(false);
      expect(src.trimStart().startsWith("("), `${file} is not IIFE-wrapped`).toBe(true);
    });
  }
});

describe("built HTML loads classic scripts (no type=module)", () => {
  for (const file of ["options.html", "popup.html"]) {
    it(`${file}: no <script type="module">`, () => {
      expect(/<script[^>]*type=["']module["']/.test(read(file))).toBe(false);
    });
  }
});
