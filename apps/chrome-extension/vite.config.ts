/**
 * Builds the MV3 bundle: background.js + options.js into dist/, with
 * manifest.json + options.html copied verbatim from public/. `dist/` is
 * directly loadable via chrome://extensions → "Load unpacked".
 */

import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    minify: false, // reviewable output — this extension handles an auth token
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background.ts"),
        options: resolve(__dirname, "src/options.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        format: "es",
      },
    },
    target: "chrome116", // WS keepalive floor
  },
});
