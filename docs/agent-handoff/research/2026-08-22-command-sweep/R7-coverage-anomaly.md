# R7 — The env-loader 0% coverage anomaly: ROOT-CAUSED (found while checking R3's numbers)

## Symptom
`COVERAGE=1 pnpm test` reports `@george43g/env-loader` at **0/0/0/0** (stmts/branch/funcs/lines).
R3 flagged this as "anomalous, not root-caused". It is now root-caused.

## It is NOT "the tests don't run"
Verified by running the package directly:
```
$ cd packages/env-loader && pnpm test
 ✓ src/index.test.ts (12 tests) 11ms
 Test Files  1 passed (1)
      Tests  12 passed (12)
```
12 tests pass. So this is a MEASUREMENT bug, not a testing gap — the opposite of what a
0% cell implies to a reader.

## Root cause
`packages/vitest-config/vitest.shared.ts:36-37`:
```ts
include: ["src/**/*.ts"],
exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/**/index.ts", "src/**/types.ts"],
```
`src/**/index.ts` is excluded as a **barrel-file heuristic** — normally correct, since a
barrel is re-exports with no logic worth covering. Measured across the workspace:

| package | `src/index.ts` lines | re-export lines | is it a barrel? |
|---|---|---|---|
| **env-loader** | **102** | **0** | **NO — it is the entire implementation** |
| extension-core | 31 | 11 | yes |
| mcp-kit | 32 | 6 | yes |
| shared-types | 58 | 10 | yes |
| test-kit | 39 | 6 | yes |

env-loader is the ONE package whose `index.ts` is implementation rather than a barrel, and
it is that package's ONLY source file. So 100% of its code is excluded from instrumentation,
and it reports 0% forever regardless of how well tested it is.

## Blast radius (why this belongs in the brief)
1. **Any plan that proposes arming `COVERAGE_GATE` must fix this first**, or env-loader fails
   the gate at 0% while being fully tested — and the "fix" someone reaches for under gate
   pressure is to write tests that already exist.
2. **Every real coverage gap inside env-loader is permanently invisible**, today, silently.
3. It makes R3's coverage table wrong in one cell — the numbers are otherwise usable, but
   this is a reminder that a 0 in a coverage report has two very different meanings and the
   report does not distinguish them.

## The fix (NOT applied — this turn is research, and it is a repo change needing a PR)
Narrow the heuristic so it excludes barrels rather than filenames. Either:
- **(a)** exclude `src/index.ts` only where it is a barrel — i.e. drop the blanket rule and
  list barrels explicitly per package; or
- **(b)** keep the rule but add a per-package override in `packages/env-loader/vitest.config.ts`
  (currently `export default shared` verbatim, byte-identical to mcp-kit's).
(b) is one file and no risk to other packages; (a) is more correct and touches everyone.
I'd take (b) now and (a) only if the gate is ever armed.

## Class
This is a **Class C defect** in the R5 taxonomy — the apparatus reporting something other than
the truth about itself. It is the fourth instance found in this repo (after the two vitest
`include` misses and the stress phantom pass), which strengthens R5's argument that any new
suite must carry a did-it-actually-run/did-it-actually-measure guard.
