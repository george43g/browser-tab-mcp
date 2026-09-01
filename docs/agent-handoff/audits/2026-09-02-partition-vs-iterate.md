# B21 audit — the partition-vs-iterate defect class

**Date:** 2026-09-02 (confirmed against wall clock at run time)
**Auditor:** browser-tab-mcp session (fork), executing BACKLOG B21
**Base commit:** `b9b1397`

## The rule audited against

> **Assert the selector, not only the result. Wherever a set PARTITIONS rather
> than ITERATES, an empty match moves every item to the other side silently.
> Iteration fails safe; partitioning fails inverted.**

General form: *testing presence when you need capability* — a comparison that
cannot fail reports success. Calibrating instances are in the B21 row
(BACKLOG.md): the robustness watchdog (B15), `proc.killed` (B16), mcpsync's
quote-blind secret scanner, g-home-server's inverted hygiene check.

## Verdict table — every site checked

One row per site, per B21's acceptance: a "fails safe" note with evidence, or
a fix plus a test that goes red when the selector matches nothing. A sweep
that only said "no instances found" would itself be an instance.

| # | Site | Verdict | Evidence |
|---|------|---------|----------|
| 1 | `src/detect/correlate.ts` — matching core (`pickCgWindow`, claim map) | **iterates, fails safe** | Empty candidate sets cascade exact→shifted→title→`null`, never a guess (`correlate.ts:306-341`); an id claimed twice nulls BOTH claimants (`correlate.ts:495-498`); zero candidates for a pid leaves ids null and is counted (`correlate.ts:475`). |
| 2 | `src/detect/correlate.ts` — diag trigger | **HIT (observability), fixed** | `windows` counted only bounds-carrying windows (`correlate.ts:473`) and the log trigger required `windows > 0`, so a browser whose windows ALL lost bounds (mapper regression) tallied `windows: 0` — indistinguishable from "nothing to correlate" — and the `cg_correlate` degradation line never fired. Correlation would go dark silently on the exact instrumentation built to chase the cgWindowId oscillation. **Fix:** `noBounds` counter + exported pure `correlationDegraded()` predicate replacing the inline condition. **Tests:** `tests/correlate.test.ts` "counts bounds-less windows and flags a fully-boundless browser as degraded" (red-when-empty), plus pins on all pre-existing degradation shapes. |
| 3 | `src/daemon/history.ts` | **the GOOD pattern, confirmed as reference** | Iterates per-target with per-source `status` rows; `Promise.allSettled` turns a throwing source into `status:"error"` instead of a lost call (`history.ts:180-210`); the EMPTY target set itself returns a named `unavailable` row per candidate with the reason (`history.ts:66-87,153-155`) — the empty match is reported, not silent. |
| 4 | `scripts/sweep-macos.mjs` — `redact()` / `ALLOWED_URLS` | **partitions in the SAFE direction** | Default-redact, allowlist-pass (`sweep-macos.mjs:1500-1508`): an empty/wrong `ALLOWED_URLS` redacts MORE, never less; home paths have an independent second pass. The inverted failure (empty selector → everything passes through) is impossible with `Set.has` on the allowlist side. |
| 5 | `scripts/sweep-macos.mjs` — exit verdict | **fails safe today; guard added** | `results` is provably non-empty at the summary — the Automation TCC probe records a row in every arm (pass/skip/fail) before the main body — and an unhandled throw exits non-zero. A zero-results guard (exit 1) was still added above the summary as defence against restructuring; precedent is the TUI soak's "0 samples exited 0" incident. *No unit test: the script executes on import and is macOS-GUI-bound; restructuring it into an importable module was ruled out of proportion for a defence-in-depth guard on a site whose current verdict is "fails safe".* |
| 6 | `tests/surface-coverage.contract.test.ts` | **exemplary — asserts its own selectors** | Anti-vacuity canary requires registry >10 tools and commander >5 CLI commands before anything else (`:56-62`); macos-local rows floored at ≥9 (`:195-206`); a deleted sweep report turns rows red via the evidence-path-exists test; an empty `results` array in the report reds every macos-local claim (fail-safe direction). |
| 7 | `apps/chrome-extension/e2e/run-guard.ts` + `run-guard-core.ts` | **exemplary** | `EXPECTED_MIN_TESTS` floor catches a collapsed run (`run-guard-core.ts:105`); per-spec participation with a reason-required allowlist checked in BOTH directions (`:114-138`); ledger-claim vs annotation checked in BOTH directions incl. typo'd annotations (`:141-170`). The guard only turns green→red (`:176`) so it cannot bury Playwright's own diagnostics. |
| 8 | `scripts/verify-release.mjs` | **HIT (real, two shapes), fixed** | (a) `tryRun("git ls-remote …") ?? ""` conflated *the remote could not be read* with *the remote has no tags* — a network/auth failure took the benign "no release tags exist yet — nothing to verify" early exit and returned `ok` over a repo with a dozen releases. The selector failing EMPTY moved the whole repo to the never-released side. (b) `gh --version` tested PRESENCE, then a failed `gh pr list`/`release view` query wore the "(gh unavailable)" note — in CI, where gh always exists, the untagged-release check (the one that catches the v1.0.0 silent abort) silently did not run. **Fix:** `tagsReadable`, `ghPresent`, `openPrQueryFailed` facts; unreadable remote is now a problem (red), gh-present-but-query-failed is a problem, and the open-PR note no longer claims "no open release PR" when the query failed. **Tests:** four new cases in `tests/release-verify.test.ts` (each red-when-empty against the old behavior). |
| 9 | `apps/browser-tab-mcp/scripts/check-usage-freshness.mjs` | **HIT (mild), fixed** | A missing checked-in artifact soft-passed as "not yet generated" unconditionally — right on a fresh template scaffold, wrong in THIS repo, where deleting `completions/browser-tab.bash` switched the drift gate off for that file with a green CI. **Fix:** exported pure `missingPolicy(checkedInExists, baselineLocked)` — soft-pass only when NO artifact is committed anywhere; once the baseline is locked, absence is deletion and fails. Execution moved behind a main-guard so the policy is importable. **Test:** `tests/usage-freshness-policy.test.ts` (red-when-empty: `missingPolicy(false, true) === "fail"`). Verified live: import is side-effect-free; `node scripts/check-usage-freshness.mjs` still exits 0 on the real (fresh) artifacts. |
| 10 | `scripts/verify-macos.mjs` | **exemplary** | Dies on missing rustc ("a green run proving nothing is worse than a red one", `:80-91`), on a build that produced no `.node` (`:103`), on empty displays ("a Mac always has at least one display", `:115`), and shape-checks so "a silently-empty struct cannot pass as success" (`:121-136`). |
| 11 | `scripts/build-rust-optional.mjs` | **correct asymmetry, already pinned** | Missing toolchain skips exit 0; present-but-failing toolchain propagates. Both worlds manufactured and asserted by `apps/browser-tab-mcp/tests/build-rust-optional.test.ts`. |
| 12 | `scripts/check-deps-stale.mjs` | **the GOOD pattern** | UNPARSED specifiers "reported, never guessed" (`:343-351`); the explicit SILENT-HOLE GUARD names every package the registry did not answer and says "this run proves nothing about staleness" when the list is long (`:353-366`). Reads resolved versions from `node_modules`, never the manifest. |
| 13 | `.github/workflows/readme-check.yml` | **HIT (real), fixed** | `git diff … \| grep -c … \|\| true`: a FAILED diff (unfetched base ref; `github.event.before` gone after a force push) produced count 0 → "No source code changes — README check skipped" → exit 0. The gate self-disabled on exactly the runs where it could not see the diff. **Fix (both PR and push steps):** compute the diff first and go red if the command fails ("cannot see what changed" ≠ "nothing changed"), then count from the captured output. *No committed test (GitHub Actions shell); the fixed logic was exercised locally: bad range → red, good range → counts, empty diff → count 0.* |
| 14 | `.github/workflows/ci.yml`, `release.yml`, `deps-check.yml`, `screenshots.yml` — gating conditionals | **iterate / scope, fail safe** | The `if:` conditions are OS-leg and repo-identity scoping, not result partitions. `release.yml` runs its verify job `if: always()` (fires even when the release step failed — the safe direction), with retry + schedule + `verify-release.mjs` behind it; `deps-check.yml`'s `if: failure()` is a notification, not a gate. |

## Tally

- **4 real hits fixed** (#2 correlate diag, #8 verify-release ×2 shapes, #9 usage-freshness, #13 readme-check), each with a test that goes red when the selector matches nothing — except #13 (workflow shell, exercised locally and documented above).
- **1 defence-in-depth guard** added where the current verdict is "fails safe" (#5 sweep exit).
- **9 sites confirmed clean**, three of which (#3 history, #6 surface-coverage, #7 run-guard) are the repo's reference implementations of the rule.

## Observations outside the fix set

- `correlateSnapshot`: a browser with `pid === null` but windows present early-returns before any diag counters are set (`correlate.ts:465`), so it appears as an all-zero diag row and never triggers the log. Believed unreachable in practice on macOS (the pid and the windows come from the same poll) — **unknown, not verified** — and correlation never runs off-macOS (`readCgWindows` returns null first). Left as-is; noted so the next reader doesn't rediscover it.
- The B21 row's path for the sweep (`apps/browser-tab-mcp/scripts/sweep-macos.mjs`) is stale — the script lives at `scripts/sweep-macos.mjs` (repo root).
