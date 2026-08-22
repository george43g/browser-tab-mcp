# R3 — Baselines for e2e-suite planning brief

Measured 2026-08-22 against `/Users/george/repos/browser-tab-mcp` @ `main` (HEAD `3264605`). No files edited, nothing committed/pushed.

---

## Q1 — Is `apps/chrome-extension/e2e/**` excluded from typecheck?

**Verdict: CONFIRMED. e2e files are never typechecked.**

### tsconfig, verbatim

`apps/chrome-extension/tsconfig.json`:
```json
{
  "extends": "@george43g/tsconfig/base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "types": ["chrome"],
    "noEmit": true
  },
  "include": ["src/**/*.ts", "vite.config.ts"],
  "exclude": ["node_modules", "dist"]
}
```
`include` is `["src/**/*.ts", "vite.config.ts"]` — the `e2e/` directory is not named and doesn't match `src/**`, so it falls outside `include` regardless of `exclude`.

Referenced base, `packages/tsconfig/base.json`, verbatim:
```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "display": "@george43g/tsconfig/base",
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "allowSyntheticDefaultImports": true,
    "esModuleInterop": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "exclude": ["node_modules", "dist", "build", "coverage"]
}
```
The base config carries no `include` of its own (compilerOptions + exclude only), so it does not pull `e2e/` in either.

### Empirical proof

Ran the actual package script:
```
$ pnpm --filter @george43g/chrome-extension typecheck
> @george43g/chrome-extension@1.4.0 typecheck /Users/george/repos/browser-tab-mcp/apps/chrome-extension
> tsc -p tsconfig.json --noEmit
```
(exits 0, no output — passes clean either way, so this alone doesn't prove scope.)

Ran `tsc -p tsconfig.json --noEmit --listFiles` (full output saved to `research/tsc-listfiles.txt`, 253 files total — mostly `@types/node`/`@types/chrome`/vite/rollup/postcss lib `.d.ts` files pulled in by the module graph). Filtering to this package's own source:
```
$ grep "apps/chrome-extension/" tsc-listfiles.txt
/Users/george/repos/browser-tab-mcp/apps/chrome-extension/src/background.ts
/Users/george/repos/browser-tab-mcp/apps/chrome-extension/src/extract.ts
/Users/george/repos/browser-tab-mcp/apps/chrome-extension/src/status-view.ts
/Users/george/repos/browser-tab-mcp/apps/chrome-extension/src/options.ts
/Users/george/repos/browser-tab-mcp/apps/chrome-extension/src/popup.ts
/Users/george/repos/browser-tab-mcp/apps/chrome-extension/vite.config.ts
```
```
$ grep -c "e2e/" tsc-listfiles.txt
0
```
Zero files under `e2e/` appear anywhere in the compiled file set — `fixtures.ts`, `load.e2e.test.ts`, `roundtrip.e2e.test.ts` are all absent.

### How e2e code executes instead

`apps/chrome-extension/playwright.config.ts` points `testDir: "e2e"`, `testMatch: "**/*.e2e.test.ts"`. `test:e2e` runs `playwright test`, which transpiles TS via esbuild on the fly — it does **not** invoke `tsc`, so it also does not typecheck (esbuild strips types, it doesn't check them). There is no separate `tsconfig` inside `e2e/` and no `tsc` step anywhere in `ci.yml`'s `e2e-chromium`/`e2e-branded` jobs (grep of the workflow for `tsc`/`typecheck` under those jobs: none — see Q4 step lists below). So today, a type error introduced only in `apps/chrome-extension/e2e/*.ts` would not be caught by `pnpm typecheck`, `pnpm --filter @george43g/chrome-extension typecheck`, or by CI's `Typecheck` step (which itself only runs `if: runner.os == 'Linux'` in the `build-test` matrix, per Q4).

---

## Q2 — Coverage today

Ran `COVERAGE=1 pnpm test` from repo root (turbo `test` pipeline). Completed in ~13s wall (turbo total), all packages passed, gate NOT armed (`COVERAGE_GATE` unset). Full log: `research/coverage-run.log`.

```
$ COVERAGE=1 pnpm test
...
   • Packages in scope: @george43g/biome-config, @george43g/browser-tab-mcp, @george43g/chrome-extension,
     @george43g/env-loader, @george43g/extension-core, @george43g/mcp-kit, @george43g/rust-accel,
     @george43g/safari-extension, @george43g/shared-types, @george43g/test-kit, @george43g/tsconfig,
     @george43g/vitest-config
   • Running test in 12 packages
...
 Tasks:    11 successful, 11 total
Cached:    0 cached, 11 total
  Time:    12.931s
EXIT_CODE:0
```
(11 of 12 in-scope packages actually run a `test` script — `biome-config`/`tsconfig`/etc. either have none or are subsumed; the 6 packages below are the ones with `coverage: enabled` vitest configs and non-trivial source.)

### Per-package coverage (`% Stmts / % Branch / % Funcs / % Lines`, "All files" row, v8 provider)

```
@george43g/env-loader:      All files |    0.00 |     0.00 |    0.00 |    0.00
@george43g/mcp-kit:         All files |   90.59 |    85.48 |   93.75 |   90.59
@george43g/shared-types:    All files |   98.75 |   100.00 |   50.00 |   98.75
@george43g/extension-core:  All files |   58.45 |    78.85 |   70.58 |   58.45
@george43g/chrome-extension:All files |   61.48 |    66.21 |   93.33 |   61.48
@george43g/browser-tab-mcp: All files |   77.06 |    80.97 |   80.76 |   77.06
```

Notes on the two extremes:
- `env-loader` shows 0% across the board despite its 1 test file passing (`Test Files 1 passed (1)`) — its coverage `include` pattern (`src/**/*.ts`) apparently isn't matching what the single test actually exercises, or the package's real logic lives in an excluded/differently-shaped file. Flagged as-is; not investigated further per scope of this task.
- `shared-types` Functions is 50% against Stmts/Branch/Lines near-100% — a small number of exported-but-untested helper functions, not a systemic gap.

Per-file breakdowns (every file, not just the summary row) are in `research/coverage-run.log` under each package's `% Coverage report from v8` block, e.g. `apps/browser-tab-mcp`'s worst files are `src/detect/adapters/chromium.ts` (26.28% stmts), `src/detect/adapters/safari.ts` (21.69%), `src/detect/osascript.ts` (34.83%), `src/daemon/launchd.ts` (11.59%) — all AppleScript/launchd glue that can't run in CI sandboxes, consistent with the "degrade explicitly" architecture described in the repo's CLAUDE.md.

### Where reports are written

Per-package `./coverage/` (relative to each package root), driven by `packages/vitest-config/vitest.shared.ts`:
```ts
coverage: {
  provider: "v8",
  enabled: process.env.COVERAGE === "1",
  reporter: process.env.CI ? ["text", "lcov"] : ["text", "html"],
  reportsDirectory: "./coverage",
  include: ["src/**/*.ts"],
  exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/**/index.ts", "src/**/types.ts"],
  ...(process.env.COVERAGE_GATE === "1"
    ? { thresholds: { statements: 80, branches: 70, functions: 70, lines: 70 } }
    : {}),
}
```
This run (local, not CI) wrote `text` + `html` (`coverage/index.html` per package) — confirmed present for the 6 packages that ran: `apps/browser-tab-mcp/coverage/`, `apps/chrome-extension/coverage/`, `packages/{shared-types,mcp-kit,extension-core,env-loader}/coverage/`. In CI (`CI` env set) the reporter switches to `text` + `lcov`, and `ci.yml`'s `Upload coverage` step globs `**/coverage/lcov.info` into a `coverage-${{ matrix.os }}` artifact (Linux leg only).

Stale, git-untracked leftovers found on disk from a prior run (2026-07-23) at `packages/{robustness,secrets,cli-kit}/coverage/` — these three packages have **zero git-tracked files** (`git ls-files` returns empty for all three) and are absent from turbo's "Packages in scope" list above, confirming the CLAUDE.md claim that they were deleted once the equivalent `@george43g/robustness`/`secret-store`/`@george43g/cli-kit` npm packages caught up. Their coverage directories are inert history, not part of this baseline.

### Threshold configuration (dormant — gate not armed)

Three presets, layered (`packages/vitest-config/`):

- `vitest.shared.ts` (library preset, `packages/*`): gate thresholds `{ statements: 80, branches: 70, functions: 70, lines: 70 }`
- `vitest.app.ts` (app preset, `apps/*`, extends shared): gate thresholds `{ statements: 50, branches: 40, functions: 40, lines: 40 }`
- `vitest.extension.ts` (browser-runtime preset, `packages/extension-core` + `apps/chrome-extension`, extends app): gate thresholds `{ statements: 55, branches: 45, functions: 45, lines: 45 }`

All three apply their `thresholds` block **only** `if (process.env.COVERAGE_GATE === "1")` — otherwise coverage is collected/reported but nothing fails a build.

`COVERAGE_GATE` in CI: grepped `.github/workflows/ci.yml` — the only `COVERAGE` reference is:
```yaml
      - name: Coverage (collect + report — non-gating)
        if: runner.os == 'Linux'
        env:
          COVERAGE: "1"
        run: pnpm test
```
`COVERAGE_GATE` does not appear anywhere in `ci.yml`. **Gate is confirmed NOT armed in CI today** — matches the "dormant" framing in the repo's own CLAUDE.md and the step's own comment.

Cross-check against current numbers: at the library-preset gate (80/70/70/70), `mcp-kit` (90.6/85.5/93.75/90.6) and `shared-types` stmts/branch/lines all clear it but `shared-types` Functions (50%) would fail; `extension-core` (58/79/71/58) would fail on statements/functions/lines. At the app-preset gate (50/40/40/40), `browser-tab-mcp` (77/81/81/77) clears comfortably. At the extension-preset gate (55/45/45/45), `chrome-extension` (61/66/93/61) clears. So arming the gate today would immediately fail at least `env-loader` (0%) and `shared-types`/`extension-core` on functions — this is a real, non-trivial gap, not a rounding issue.

---

## Q3 — CI timings, measured from real runs

Auth check (per instructions, `GH_TOKEN` unset per-call, absolute binary):
```
$ env -u GH_TOKEN /opt/homebrew/bin/gh auth status
✓ Logged in to github.com account george43g (keyring)
```

Pulled job-level `started_at`/`completed_at` for the 5 most recent **completed `CI` workflow runs** (`gh api repos/george43g/browser-tab-mcp/actions/runs/{id}/jobs`), spanning both a `push` to `main` and several `pull_request` runs on branch `docs/checkpoint-4`:

Run IDs sampled: `32560736043`, `32560555468`, `32560294899`, `32559883367`, `32559709428` (all completed `success`, 2026-08-22 07:29–07:55 UTC — this is a tight ~26-minute window since these are the 5 most recent completed runs at measurement time; there was no older run history available without going back to different days, so range/median here reflect back-to-back runs rather than a longer time baseline — noted as a caveat, not papered over).

Per-job durations (`completed_at - started_at`), 5 samples each, sorted ascending, in `MmSSs`:

| Job | Samples | Median | Range |
|---|---|---|---|
| `ubuntu-latest · node 24` | 2m54, 3m09, 3m14, 3m14, 3m17 | **3m14s** | 2m54s – 3m17s |
| `macos-latest · node 24` | 1m30, 1m43, 1m47, 1m52, 2m31 | **1m47s** | 1m30s – 2m31s |
| `windows-latest · node 24` | 2m14, 3m00, 3m03, 3m20, 3m35 | **3m03s** | 2m14s – 3m35s |
| `e2e (chromium)` | 1m15, 1m18, 1m20, 1m35, 1m42 | **1m20s** | 1m15s – 1m42s |
| `e2e (chromium, windows)` | 2m08, 2m14, 2m25, 2m31, 2m45 | **2m25s** | 2m08s – 2m45s |
| `e2e (msedge, windows)` | 1m56, 2m07, 2m07, 2m09, 2m28 | **2m07s** | 1m56s – 2m28s |

Raw job rows (verbatim `gh api` output, one run shown as example; full 5-run dump was captured in-session and is reproducible via the command below):
```
$ env -u GH_TOKEN /opt/homebrew/bin/gh api repos/george43g/browser-tab-mcp/actions/runs/32560736043/jobs \
    --jq '.jobs[] | {name, status, conclusion, started_at, completed_at}'
{"completed_at":"2026-08-22T07:53:00Z","conclusion":"success","name":"e2e (chromium)","started_at":"2026-08-22T07:51:42Z","status":"completed"}
{"completed_at":"2026-08-22T07:55:17Z","conclusion":"success","name":"windows-latest · node 24","started_at":"2026-08-22T07:51:42Z","status":"completed"}
{"completed_at":"2026-08-22T07:54:07Z","conclusion":"success","name":"e2e (chromium, windows)","started_at":"2026-08-22T07:51:42Z","status":"completed"}
{"completed_at":"2026-08-22T07:55:00Z","conclusion":"success","name":"ubuntu-latest · node 24","started_at":"2026-08-22T07:51:43Z","status":"completed"}
{"completed_at":"2026-08-22T07:53:50Z","conclusion":"success","name":"e2e (msedge, windows)","started_at":"2026-08-22T07:51:43Z","status":"completed"}
{"completed_at":"2026-08-22T07:53:29Z","conclusion":"success","name":"macos-latest · node 24","started_at":"2026-08-22T07:51:42Z","status":"completed"}
```

This matches the repo's own CLAUDE.md note about "healthy 3.2-min-median jobs" for the macOS leg cost analysis — measured macOS median here is 1m47s but ubuntu is 3m14s and windows 3m03s, so per-PR **wall-clock critical path** (jobs run in parallel, but the slowest ubuntu/windows leg + the slowest e2e leg gate the merge) is roughly max(~3m14s build-test, ~2m45s worst e2e sample) ≈ **3–4 minutes** end to end per PR, not summed.

---

## Q4 — What the e2e jobs actually do (verbatim from `.github/workflows/ci.yml`)

### `e2e-chromium` (job name: `e2e (chromium)`, `runs-on: ubuntu-latest`, `timeout-minutes: 20`)

No job-level `if:` gate — runs unconditionally on every push/PR (confirmed: no `if:` key on this job at all).

Steps, in order:
1. `Checkout` — `actions/checkout@v6` — **setup**
2. `Setup pnpm` — `pnpm/action-setup@v6` (`version: 10.29.3`) — **setup**
3. `Setup Node` — `actions/setup-node@v6` (`node-version: "24"`, `cache: pnpm`) — **setup**
4. `Setup Rust` — `dtolnay/rust-toolchain@stable` — **setup** (no `if:` gate — always runs here, unlike the matrix job's Linux/macOS-only Rust setup)
5. `Install dependencies` — `run: pnpm install --frozen-lockfile` — **install** (duplicated)
6. `Build (extension bundle + daemon CLI)` — `run: pnpm build` — **build** (duplicated)
7. `Install Playwright chromium (+ OS deps)` — shell script wrapping `pnpm --filter @george43g/chrome-extension exec playwright install --with-deps chromium` in a `timeout 360` + one retry (clears `/var/lib/apt/lists/*` between attempts) — **test-tooling install** (also effectively duplicated per-job, since e2e-branded's chromium leg repeats an unguarded version of this)
8. `Run e2e (built extension ↔ throwaway daemon)` — `run: pnpm --filter @george43g/chrome-extension test:e2e` — **test** (the only step actually named as gating an `if:`-conditional upload)
9. `Upload Playwright report on failure` — `if: failure()` — **artifact upload**, only on failure

### `e2e-branded` (job name: `e2e (${{ matrix.channel }}, windows)`, `runs-on: windows-latest`, `timeout-minutes: 20`, matrix `channel: [chromium, msedge]` → 2 job instances)

No job-level `if:` gate — runs unconditionally, matrix produces both `chromium` and `msedge` rows every time.

Steps, in order:
1. `Checkout` — `actions/checkout@v6` — **setup**
2. `Setup pnpm` — `pnpm/action-setup@v6` (`version: 10.29.3`) — **setup**
3. `Setup Node` — `actions/setup-node@v6` (`node-version: "24"`, `cache: pnpm`) — **setup** (no Rust setup step at all in this job — Windows builds TS-only)
4. `Install dependencies` — `run: pnpm install --frozen-lockfile` — **install** (duplicated)
5. `Build (extension bundle + daemon CLI)` — `run: pnpm build` — **build** (duplicated)
6. `Install Playwright chromium` — `if: matrix.channel == 'chromium'` — `run: pnpm --filter @george43g/chrome-extension exec playwright install chromium` — **test-tooling install**, gated to the `chromium` row only (msedge is real preinstalled Windows Edge, needs no install)
7. `Run e2e against ${{ matrix.channel }}` — `run: pnpm --filter @george43g/chrome-extension test:e2e`, `env: E2E_BROWSER_CHANNEL: ${{ matrix.channel }}` — **test**
8. `Upload Playwright report on failure` — `if: failure()` — **artifact upload**, only on failure

### Every `if:` gate found in these two jobs, verbatim

```yaml
# e2e-chromium — no job-level if:
      - name: Upload Playwright report on failure
        if: failure()

# e2e-branded — no job-level if:
      - name: Install Playwright chromium
        if: matrix.channel == 'chromium'
      - name: Upload Playwright report on failure
        if: failure()
```
(For contrast, the sibling `build-test` matrix job DOES gate several OS-independent steps to `if: runner.os == 'Linux'` — Lint, Shellcheck, Typecheck, Coverage, `test:no-native`, usage-artifact freshness check, npm-pack — but neither e2e job has any such per-OS/per-branch gating; both are pure "always run" jobs.)

### Duplicated install+build work, counted

Per PR run, the following **6 separate jobs** each independently run their own full `pnpm install --frozen-lockfile` + `pnpm build`:
1. `build-test` (ubuntu-latest)
2. `build-test` (macos-latest)
3. `build-test` (windows-latest)
4. `e2e-chromium` (ubuntu-latest)
5. `e2e-branded` (windows-latest, chromium)
6. `e2e-branded` (windows-latest, msedge)

→ **6 × `pnpm install` + 6 × `pnpm build` = 12 duplicated install/build steps per PR**, each on its own isolated runner with no cross-job artifact reuse (no `actions/upload-artifact`/`download-artifact` handoff of `dist/` between jobs — every job rebuilds from source). The user has decided to keep the matrix parallel, so this count is reported as-is, not as a recommendation to collapse it.

---

## Caveats / things NOT independently re-verified beyond what's stated

- Q3's 5-run sample window is ~26 minutes of wall-clock (5 consecutive completed runs), not spread across days — reported as the actual last-5, per the question's own framing, with the tightness of the window flagged above rather than hidden.
- Q2's `env-loader` 0% coverage number is reported as measured, with a one-line note that it looks anomalous given the package's 1 passing test file; not root-caused (out of scope for a baseline-measurement task).
- Did not attempt to run `COVERAGE=1 COVERAGE_GATE=1 pnpm test` to get a live pass/fail read against the armed gate — the arithmetic cross-check above (comparing measured % against the threshold literals in `vitest.*.ts`) is provided instead and flagged as arithmetic, not a second measured run.
