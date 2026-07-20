import { defineConfig, mergeConfig } from "vitest/config";
import { app } from "./vitest.app.ts";

/**
 * Vitest preset for the browser-EXTENSION runtime (`packages/extension-core`
 * + `apps/chrome-extension`) — reconnect/backoff timers, the `api` Proxy over
 * `globalThis.chrome`/`browser`, and DOM entry glue. NOT pure library code, so
 * it sits between the strict `shared` bar and the `app` bar.
 *
 * `environment: "node"` stays the default so DOM is **opt-in per-file** via a
 * `// @vitest-environment happy-dom` docblock — `socket.ts` tests need fake
 * timers + a `WebSocket` double but NO DOM, so a package-wide DOM env would be
 * wrong. Thresholds are dormant until `COVERAGE_GATE=1` (see `vitest.shared`).
 */
export const extension = mergeConfig(
  app,
  defineConfig({
    test: {
      environment: "node",
      coverage: {
        // Concatenated onto the shared excludes: thin DOM entry-glue that runs
        // `main()` on import and can't be meaningfully unit-covered.
        exclude: ["src/popup.ts", "src/options.ts"],
        ...(process.env.COVERAGE_GATE === "1"
          ? { thresholds: { statements: 55, branches: 45, functions: 45, lines: 45 } }
          : {}),
      },
    },
  }),
);

export default extension;
