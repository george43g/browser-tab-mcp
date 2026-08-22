# R5 — Defect-class analysis: which layer would have caught each real bug

Compiled from this repo's own defect history (AGENTS.md + PROGRESS-LOG). Every row is a
bug that ACTUALLY HAPPENED, not a hypothetical. The purpose is to justify the shape of a
new test suite empirically rather than by taste: if a proposed layer would not have caught
anything on this list, it is not worth building.

## The table

| # | Defect | How it was actually found | Layer that would have caught it | Fake adapter could? |
|---|---|---|---|---|
| 1 | `group_tabs create` omitted `createProperties.windowId` → Chrome grouped into the FOCUSED window and MOVED the tabs there; a grouping op became a mass cross-window move | dogfood, 2026-08-20 (AGENTS.md:32) | real-browser e2e, dual-truth: assert each tab's `windowId` is UNCHANGED after grouping | **No** — the fake does not model Chrome's grouping semantics |
| 2 | `focus_tab` left a focused tab inside a still-minimized window (AppleScript path reordered without un-minimizing; raising a minimized window is a no-op, so ORDER was the fix) | manual observation | unit once semantics known (`src/detect/adapters/focus.test.ts`); **discovery** needed a real minimized window | No |
| 3 | e2e's `cli()` silently reached the developer's REAL console daemon via the per-user global named pipe instead of the throwaway one | only reproducible on a box with a second daemon (measured 2026-08-22, AGENTS.md:286) | **none of today's layers** — CI has one daemon, so CI cannot falsify it | No |
| 4 | Stress "phantom pass": driver's hang-kill suppressed the workload's correctness verdict; printed `0 samples` and exited 0 | noticed by reading output | harness self-verification — "zero collected samples is a failure" | n/a |
| 5 | `tab_action back/forward` appears to no-op (Chromium marks gestureless history entries skippable) | manual sweep, then George's live gesture test | real-browser e2e where history is built by a **trusted click**, not by `navigate` | **No** — no fake has session history |
| 6 | `discard` replaces the tab id | manual sweep | real-browser e2e asserting id via the extension's own `chrome.tabs` view | **No** — invisible to a fake |
| 7 | cgWindowId oscillates (extension-fed windows flip `cg=N` → `cg:none` on churn) — STILL OPEN | TUI live drive | real browser + window churn + native module; macOS-only, so not CI-able today | No |
| 8 | Vite's default `browser` resolve condition swapped `picocolors` for its stub → the shipped bin was monochrome while tests stayed colourful | noticed; now guarded by `tests/bundle.build-output.test.ts` running the real bin under `FORCE_COLOR` | build-output behavioural test (assert on the ARTIFACT, not the source) | n/a |
| 9 | TUI `m` (move mode) unreachable since #45 — the guard read a memo that returned `[]` outside move mode | TUI live drive (PR #77) | TUI integration render test | n/a |
| 10 | Connector version frozen at `0.2.0` across seven releases while Safari faithfully displayed it | noticed | contract test over version-carrying files (now `release-versions.contract.test.ts`) | n/a |

## The three classes, and what each implies for the plan

**Class A — effect defects (#1, #2, #5, #6, #7).** The command dispatched correctly and the
browser did something other than intended. The fake adapter asserts DISPATCH and is
structurally incapable of catching any of these. **Only real-browser dual-truth catches
Class A**, and Class A is where this cycle's real bugs actually were — 5 of 10, and the two
most severe (a grouping op that silently moved tabs across windows; a focus that left the
window minimized). This is the empirical case for the sweep suite. It is not speculative.

**Class B — environment-binding defects (#3, plus the deploy-copy staleness and branded
Chrome's `--load-extension` removal).** Correct code bound to the wrong environment.
CI cannot catch these *by construction* — "the harness is more provisioned than the target",
and in #3's case CI has exactly one daemon so the ambiguity it needs never exists.
**Implication: the fix for Class B is not more tests, it is identity assertions** — a test
should assert the daemon it is talking to is the one it started (pid/build/socket), and a
deploy should assert the artifact it loaded is the one just built. Cheap, layer-agnostic,
and it converts an invisible failure into a loud one. Worth a plan task on its own; do not
let it get folded into "write more e2e tests", which would not have caught #3.

**Class C — harness-integrity defects (#4, plus vitest's `include` silently collecting zero
`.tsx` files TWICE per AGENTS.md, plus `e2e/**` apparently not being typechecked).** The test
apparatus passes while proving nothing. This repo has been bitten by this **three times**, which
is more often than any single product bug recurred. **Implication: any new suite must ship with
its own did-it-actually-run guard** — an assertion that the expected number of test files was
collected and that fixtures really started — because a suite that silently collects nothing is
indistinguishable from a green one. Given the history, this is the single highest-leverage
constraint to put in the plan's Global Constraints, and it costs almost nothing.

## What this rules OUT of scope, on evidence

- Broadening fake-adapter coverage: would not have caught a single Class A defect. Adding fake
  tests for the ~25 surfaces would raise the coverage number and change nothing about risk.
- Safari: no headless Safari, no Xcode-in-CI. Stays manual. Do not spend plan tasks on it.
- #7 (cgWindowId oscillation) is macOS-only and needs the native module + real window churn;
  it is a separate investigation, already parked, and should NOT be absorbed into this suite.

## Confidence

Rows 1-6 and 8-10 are documented in-repo (AGENTS.md / PROGRESS-LOG) and I have cited where.
Row 7 is documented as an open bug and is unverified as to root cause. The class assignments
are my analysis, not a quoted source — argue with them.
