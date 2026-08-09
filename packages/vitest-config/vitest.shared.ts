import { defineConfig } from "vitest/config";

/**
 * Shared Vitest preset for `packages/*` (library code).
 *
 * Higher coverage thresholds — library code is reusable, so it earns
 * stricter coverage gates than app code.
 *
 * Usage: extend with `mergeConfig(shared, { ... })` in each package's
 * `vitest.config.ts`, or import this directly if no overrides are needed.
 */
export const shared = defineConfig({
  test: {
    globals: true,
    environment: "node",
    // .tsx in BOTH roots. A .ts-only pattern doesn't fail — it discovers
    // nothing, so the tests just never report. That already bit `src/` once
    // (the Ink TUI render tests silently ran zero); `tests/` had the same hole,
    // and AGENTS.md's taxonomy sends integration tests there, so an Ink/React
    // integration test landed exactly where it would never be collected.
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.turbo/**"],
    reporters: process.env.CI ? ["default", "junit"] : ["default"],
    outputFile: {
      junit: "./coverage/junit.xml",
    },
    coverage: {
      provider: "v8",
      // Two-flag design (kept out of the hot path so `pnpm test` stays fast):
      //   COVERAGE=1       → collect + write reports (lcov in CI, html locally)
      //   COVERAGE_GATE=1  → additionally FAIL under-threshold (dormant today —
      //                      we collect + report but don't gate yet)
      enabled: process.env.COVERAGE === "1",
      reporter: process.env.CI ? ["text", "lcov"] : ["text", "html"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/**/index.ts", "src/**/types.ts"],
      ...(process.env.COVERAGE_GATE === "1"
        ? { thresholds: { statements: 80, branches: 70, functions: 70, lines: 70 } }
        : {}),
    },
  },
});

export default shared;
