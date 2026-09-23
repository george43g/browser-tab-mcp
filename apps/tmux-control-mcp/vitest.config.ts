import { app } from "@george43g/vitest-config/vitest.app";
import { withCoverageFloor } from "@george43g/vitest-config/vitest.shared";

/**
 * Floor, not target — see `withCoverageFloor`. Measured 2026-08-09, the first
 * time the gate ever ran.
 *
 * The app preset targets 50/40/40/40. Statements and lines fall short because
 * the single integration test drives the MCP dispatch path and little else:
 * the CLI subcommands, the TUI entry and the HTTP command are all exercised
 * end-to-end by `pnpm stress` rather than by vitest, so they count as
 * uncovered here while being far from untested in practice.
 *
 * Ratcheted 29/79/92/29 → 34/77/93/34 by the build stamp. Statements, lines and
 * functions all rose; BRANCHES FELL BY 2, deliberately, and not because
 * anything went untested.
 *
 * Ratcheted 34/77/93/34 → 39/80/93/39 when `src/commands/http.ts` reached 100%
 * on every metric. Two lessons are baked into these numbers:
 *
 * 1. The old statement/line floor of 34 had NO margin — measured 34.00 — so
 *    adding explanatory COMMENTS to an uninstrumented file failed the gate at
 *    33.98. These leave ~1.7pp of headroom on purpose.
 * 2. A file that is never loaded reports a vacuous 100% for branches and
 *    functions. Covering `http.ts` for the first time therefore *lowered* both
 *    aggregates before the new tests pulled them back above. If a future
 *    change makes an untested file loadable, expect the same dip and read it
 *    as instrumentation catching up, not as coverage lost.
 *
 * `functions` stays at 93 rather than rising to 94: the app's function count is
 * small enough that one new uncovered helper moves it more than a point.
 *
 * `meta.ts`'s `__BUILD_STAMP__` branch is structurally uncoverable by vitest:
 * the identifier only exists after Vite's compile-time `define` substitution,
 * and vitest does not run a Vite build. Making it reachable from a test would
 * mean turning the define into a runtime read, which is the exact design this
 * feature rejects — a runtime read describes the checkout the process is
 * sitting in, not the build that produced the artifact.
 *
 * It is verified instead against the built output: the stamp appears as a
 * string literal in `dist/`, is stable across re-runs, and `dist/` contains no
 * `execFileSync`. Every other branch of the stamp — no git, shallow clone,
 * clean tree, dirty tree — is covered by `tests/meta-degraded.test.ts`.
 */
export default withCoverageFloor(app, {
  statements: 39,
  branches: 80,
  functions: 93,
  lines: 39,
});
