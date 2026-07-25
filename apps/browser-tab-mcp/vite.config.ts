import { builtinModules } from "node:module";
import { resolve } from "node:path";
import banner from "rollup-plugin-banner2";
import { defineConfig } from "vite";

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
 * Externals: real npm runtime deps (SDK/ink/react/ws/zod/commander/
 * fullscreen-ink) stay an `import` in the built output — Node resolves them
 * at runtime, and they're listed in `dependencies` so a global install
 * (`pnpm add -g .`) fetches them. Our own workspace packages (`@george43g/*`,
 * `private:true` and unpublished) are NOT external — they bundle inline so
 * `dist/cli.js` is self-contained and installable outside the workspace.
 */
export default defineConfig({
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
        // NOTE: @george43g/* workspace packages are deliberately NOT external —
        // they bundle inline so the built bin is self-contained (pnpm add -g .).
        /^@modelcontextprotocol\//,
        "commander",
        "fullscreen-ink",
        "ink",
        "react",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "ws",
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
