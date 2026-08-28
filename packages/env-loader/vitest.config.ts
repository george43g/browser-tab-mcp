import shared from "@george43g/vitest-config/vitest.shared";
import { defineConfig } from "vitest/config";

/**
 * env-loader is the ONE package the shared barrel-file heuristic gets wrong.
 *
 * `vitest.shared.ts` excludes `src/**\/index.ts` from coverage because in four
 * of five packages that file is 6-11 lines of re-exports — measuring it is
 * noise. Here `src/index.ts` is a ~100-line IMPLEMENTATION with zero
 * re-exports, and it is the package's only source file, so the heuristic
 * excluded the entire package: 12 passing tests reporting 0/0/0/0.
 *
 * NOTE the override is a REPLACEMENT, not a merge. `mergeConfig` concatenates
 * arrays, so merging an `exclude` here would keep the shared `src/**\/index.ts`
 * entry and change nothing — measured, it still reported 0%. The list below is
 * therefore the shared list MINUS that one entry, spelled out.
 *
 * This is the per-package half of BACKLOG B5 (fix "b"): one file, no effect on
 * any other package. The more correct fix — teach the heuristic to recognise an
 * actual barrel rather than a filename — is deliberately NOT taken here because
 * it touches every package's numbers at once; do that only if `COVERAGE_GATE`
 * is ever armed. Whoever arms the gate must fix this FIRST, or it blocks a
 * fully tested package, and the instinct under gate pressure is to write tests
 * that already exist.
 */
const sharedTest = (shared as { test?: Record<string, unknown> }).test ?? {};
const sharedCoverage = (sharedTest.coverage ?? {}) as Record<string, unknown>;

export default defineConfig({
  ...shared,
  test: {
    ...sharedTest,
    coverage: {
      ...sharedCoverage,
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/**/types.ts"],
    },
  },
});
