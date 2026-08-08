/**
 * Builds the MV3 bundle as THREE self-contained classic (IIFE) scripts:
 * background.js + options.js + popup.js, with manifest.json + *.html +
 * ui.css + icons/ copied verbatim from public/.
 *
 * Why per-entry IIFE instead of one ES-module multi-entry build: Safari's
 * current web-extension runtime does not support `background.type: "module"`
 * (the converter warns on it) and loads the background as a classic script,
 * which cannot use ES `import`. Emitting each entry fully inlined (no shared
 * chunks, no module syntax) keeps the same bundle working in Chrome AND
 * Safari. Run once per entry via EXT_ENTRY (see package.json build script).
 */

import { createRequire } from "node:module";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { buildDefines } from "../../scripts/build-stamp.mjs";

const pkgVersion = (createRequire(import.meta.url)("./package.json") as { version: string })
  .version;

const ENTRIES = {
  background: "src/background.ts",
  options: "src/options.ts",
  popup: "src/popup.ts",
  // Injected on demand via chrome.scripting.executeScript (page content /
  // state extraction). A stub in PR1 — batched into the file set now so the
  // Safari Xcode project only needs regenerating once.
  extract: "src/extract.ts",
} as const;

type EntryName = keyof typeof ENTRIES;

const entry = (process.env.EXT_ENTRY ?? "background") as EntryName;
if (!(entry in ENTRIES)) throw new Error(`unknown EXT_ENTRY "${entry}"`);
const isFirst = entry === "background"; // first pass clears dist + copies public/

export default defineConfig({
  // The manifest `version` must stay bare semver (Chrome rejects anything
  // else), so build identity rides in the JS instead — this is what lets the
  // daemon tell a reloaded bundle from a stale one.
  define: buildDefines(pkgVersion),
  // Copy public/ (manifest, html, css, icons) once, on the first pass only.
  publicDir: isFirst ? "public" : false,
  build: {
    outDir: "dist",
    emptyOutDir: isFirst,
    minify: false, // reviewable output — this extension handles an auth token
    target: ["chrome116", "safari16"],
    rollupOptions: {
      input: { [entry]: resolve(__dirname, ENTRIES[entry]) },
      output: {
        entryFileNames: "[name].js",
        format: "iife", // self-contained, no import chunks (Safari-safe)
        inlineDynamicImports: true,
      },
    },
  },
});
