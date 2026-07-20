import { defineConfig, mergeConfig } from "vitest/config";
import { shared } from "./vitest.shared.ts";

/**
 * Vitest preset for `apps/*` (orchestration code).
 *
 * Lower coverage thresholds than `packages/*` — apps mostly stitch
 * library calls together, so the threshold targets integration tests
 * exercising the dispatch and CLI paths rather than every branch.
 */
export const app = mergeConfig(
  shared,
  defineConfig({
    test: {
      coverage: {
        // Dormant until COVERAGE_GATE=1 (see vitest.shared). Overrides the
        // shared library thresholds with the lower app bar when gating is on.
        ...(process.env.COVERAGE_GATE === "1"
          ? { thresholds: { statements: 50, branches: 40, functions: 40, lines: 40 } }
          : {}),
      },
    },
  }),
);

export default app;
