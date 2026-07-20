import { app } from "@george43g/vitest-config/vitest.app";
import { defineConfig, mergeConfig } from "vitest/config";

// The CLI bootstrap, the Ink TUI render trees, and one-off scripts aren't
// unit-covered (integration + stress exercise the daemon paths instead), so
// keep them out of the coverage denominator. Dormant until COVERAGE=1.
export default mergeConfig(
  app,
  defineConfig({
    test: {
      coverage: {
        exclude: ["src/cli.ts", "src/tui/**", "scripts/**"],
      },
    },
  }),
);
