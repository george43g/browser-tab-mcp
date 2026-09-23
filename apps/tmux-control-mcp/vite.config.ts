import { builtinModules, createRequire } from "node:module";
import { resolve } from "node:path";
import { buildDefines } from "@george43g/build-config";
import banner from "rollup-plugin-banner2";
import { defineConfig } from "vite";

const require = createRequire(import.meta.url);
const { version } = require("./package.json") as { version: string };

/**
 * Vite library-mode build with two entry points.
 *
 *   src/index.ts       → dist/index.js   (library — runMcpServer/callMcpTool exports;
 *                                          also runnable directly: stress harness spawns it)
 *   src/cli.ts         → dist/cli.js     (the SINGLE BIN — subcommands: mcp/tui/doctor/repl/...)
 *
 * Bin shebang is added only to dist/cli.js. dist/index.js is a library
 * file (no shebang); it's still directly invokable via `node dist/index.js`
 * which is how the stress harness uses it.
 *
 * The TUI is loaded by cli.ts via dynamic `await import("./tui/index.js")` —
 * vite will chunk it into dist/ automatically; it does NOT need to be a bin.
 *
 * Externals: every dependency stays an `import` in the built output —
 * Node will resolve them at runtime. We never bundle our own packages
 * (workspace:*) or the SDK; users get the source-level tree.
 */
export default defineConfig({
  // Build identity, substituted at compile time. `src/meta.ts` reads these.
  //
  // This MUST happen in the app's own config: `define` only reaches modules
  // Vite bundles, and `/^@george43g\//` below is external — so a stamp exported
  // from a published kit would never be substituted, and would silently fall
  // through to a plausible-looking default forever.
  define: buildDefines(version),
  build: {
    target: "node22",
    outDir: "dist",
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.ts"),
        cli: resolve(__dirname, "src/cli.ts"),
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: [
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
        /^@george43g\//,
        /^@modelcontextprotocol\//,
        "commander",
        "fullscreen-ink",
        "ink",
        "react",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "zod",
      ],
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name]-[hash].js",
      },
      plugins: [
        banner((chunk) => {
          // Shebang on the single bin entry only.
          if (chunk.name === "cli") return "#!/usr/bin/env node\n";
          return undefined;
        }),
      ],
    },
  },
});
