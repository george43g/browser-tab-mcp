# Research brief — the real-browser-effect testing gap (for a `/plan` session)

> **This is NOT an implementation plan.** George's instruction, verbatim: *"research and prep
> the planning brief, the next turn will be a proper /plan session so dont plan implementation
> now, plan your planning session by researching and measuring and experimenting"*. Everything
> here is measured or cited. The `/plan` session writes the tasks.

> **Precedence:** where this brief and any earlier chat summary disagree, this brief is correct.
> Raw research (verbatim command output, working code recipes, full tables) is committed
> alongside at `docs/agent-handoff/research/2026-08-22-command-sweep/R1…R9.md`. The brief
> summarises; the R-files are the evidence and the `/plan` session should read R1, R2 and R4
> in full before writing tasks.

## The one number

**2 of 31 command surfaces are effect-verified.** 21 are dispatch-only (fake adapter: proves
the call was routed and shaped, proves nothing about what the browser did). 5 have no test at
all. (R1, with file:line per cell.)

The two verified are `list_tabs` and `move_tab`, and only via their `list`/`move` CLI forms in
the existing 3-test Playwright suite.

## 1. Where we actually are (measured)

| Fact | Value | Source |
|---|---|---|
| Surfaces total (20 tools + 11 CLI-only) | 31 | R1 |
| Effect-verified / dispatch-only / zero-coverage | 2 / 21 / 5 | R1 |
| `e2e/**` typechecked anywhere in the repo | **No** — `tsc --listFiles` lists 0 files under `e2e/`; Playwright transpiles via esbuild and never invokes `tsc` | R3 Q1 |
| Coverage (browser-tab-mcp / extension-core) | 77.06% / 58.45% lines | R3 Q2 |
| `COVERAGE_GATE` armed in CI | No — dormant | R3 Q2 |
| CI medians (5 real runs) | ubuntu 3m14s · macos 1m47s · windows 3m03s · e2e-chromium 1m20s · e2e-chromium-win 2m25s · e2e-msedge-win 2m07s | R3 Q3 |
| Duplicated install+build steps per PR | 12, across 6 jobs, no artifact reuse | R3 Q4 |

**Two gaps, not one — and only one is coverable in CI.** R1's biggest surprise: the entire
**AppleScript/osascript path** (list, focus, tab_action, open_tab, open_window, set_window,
doctor's TCC probe) has **zero** real-browser exercise anywhere — `osascript` is mocked or
fixture-substituted at every layer. A Playwright/Chromium suite cannot touch that path at all.
So "the testing gap" is really: (a) the extension path, which a sweep suite CAN close, and
(b) the AppleScript path, macOS-only, which it cannot. The plan must say which it is closing
and must not imply it closed both.

## 2. What is feasible (experiments actually run — R2)

**E1 — reading the browser's own truth: WORKS.** `context.serviceWorkers()` (or
`waitForEvent("serviceworker")`, which `fixtures.ts:launchExtension()` already does) returns a
`Worker` whose `.evaluate()` runs in the extension's SW scope with full `chrome.*` access:
```js
let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
const tabs = await sw.evaluate(() => chrome.tabs.query({}));
const one  = await sw.evaluate((id) => chrome.tabs.get(id), tabs[0].id);
```
1–4ms per call after warm-up; no worker eviction observed over 40s idle. **This is the whole
"dual-truth" technique and it is proven.** The existing `roundtrip.e2e.test.ts` already holds
this handle to drive `chrome.windows.create` — reading state back out is the new part.

**E2 — gestured history: WORKS.** `page.click()` on a real `<a href>` **served over local HTTP
(not `data:`)** produces gesture-marked history that `chrome.tabs.goBack()` honours; identical
headed and headless. The gestureless control (`chrome.tabs.update({url})`) reproduced the
failure. **So back/forward CAN be tested in CI**, which settles the open question.

*Caveat worth carrying:* in the control, gestureless `goBack()` landed on `about:blank` rather
than no-op'ing — different from what we observed on George's real browsers (apparent no-op).
Most likely explanation is the test tab's history was `[about:blank, target]` so "back" had
only the blank to return to, whereas a real tab has a long gestured history to skip back
through. **Unverified** — do not assert either behaviour in a test until it's pinned down.

**E3 — `discard`: RESOLVED by R9, and the id-swap is now CONFIRMED.** On macOS's bundled
Chromium it hard-crashes (`SEGV_ACCERR`, 3/3, no return value). But on **real Windows Edge**
(g-home-server) it returns cleanly and **the tab id changes, 3/3 runs**:
```
run 1: TARGET::239550782  ->  {"id":239550786,"discarded":true}
run 2: BEFORE-ID::229934170 ->  {"id":229934174,"discarded":true}
run 3: TARGET::263071999  ->  {"id":263072002,"discarded":true}
```
Then the Playwright context dies (`EVT::context-closed`, `pages=0`, worker gone). **I tested and
REFUTED the obvious explanation** — that Playwright tears down a context when its last page
closes: run 3 held a keep-alive page and the context still died.

**This is NOT a product defect.** `discard` against George's real, non-automated Edge during the
manual sweep left the browser alive; the teardown appears only under a Playwright/CDP-driven
headless context. Do not report it as "our command crashes browsers".

**So `discard` IS testable** — the return value is available *before* the teardown. It must live
in its **own spec file** whose fixture expects termination, asserting `returned.id !== requestedId`
rather than a post-discard `query` (unreachable by construction). It must never share a context
with other tests, or it takes them down and the failure looks like theirs. Full detail: R9.

**E4 — cost: cheap.** `startDaemon()` 280–550ms · `launchExtension()` 400–960ms · teardown
~350–380ms ⇒ **~1.0–1.9s per file**. Existing 3-test suite runs in 3.8–4.9s. An 8-file suite
with **fresh fixtures per file** projects to ~15–25s total.

## 3. The foundation, and where it would have to change (R4)

`apps/chrome-extension/e2e/fixtures.ts` exports `DIST`/`REPO_ROOT`/`CLI`, `CHANNEL`/
`EXPECTED_BROWSER`, `startDaemon()`, `launchExtension()`, `seedConfig()`, and re-exports
Playwright's `test`/`expect`. Isolation is real: `BROWSER_TAB_STATE_DIR`, `_CACHE_DIR`,
`BROWSER_TAB_SOCKET_PATH`, pid-derived WS port in 24500–26499, fake AppleScript adapter.
`seedConfig` deliberately omits the `browser` key so real UA auto-detection stays under test —
**do not "fix" that**, it is what makes the msedge leg a regression test for `edg/`-before-chrome.

**The blocker for one-file-per-family:** `playwright.config.ts` pins `workers: 1,
fullyParallel: false`, and `ephemeralPort()` is **pid-derived with a comment scoping it to a
serial run**. All spec files share one pid today. A multi-file suite needs a per-file port band —
precisely the retrofit the vitest side already had to do after a measured ~1-in-10 flake.

**Not usable from e2e:** `installFakeChrome`, `installNodeWebSocket` — they substitute for the
real APIs a real browser already has. `make*` factories and `withDaemonEnv` are fine.

## 4. Why this shape, on evidence (R5)

Ten real defects from this cycle, classified by the layer that would have caught each:

- **Class A — effect defects (5 of 10, including the two worst):** grouping that silently moved
  tabs across windows; focus that left the window minimized; back/forward; discard's id swap;
  cgWindowId oscillation. **The fake adapter is structurally incapable of catching any of them.**
  This is the empirical case for the sweep, and it is not speculative.
- **Class B — environment binding (the global-pipe hole, deploy-copy staleness, Chrome ≥137
  dropping `--load-extension`).** CI cannot catch these by construction. **More e2e tests would
  not have caught the global-pipe defect.** The fix is *identity assertions* — a test asserts the
  daemon it talks to is the one it started. Cheap, and it converts an invisible failure into a
  loud one. Should be its own task, not folded into "write more tests".
- **Class C — harness integrity (now 4 instances: two vitest `include` misses, the stress
  phantom pass, and the env-loader coverage artifact below).** The apparatus passes while
  proving nothing. **Most-repeated failure mode in this repo.** Any new suite must ship a
  did-it-actually-run guard.

## 5. Corrections to things I said before measuring (R8)

- **"My two probe scripts become tests" — wrong.** There is ONE (`mcp-probe.mjs`, a transcript
  with zero assertions). The HTTP surface is **already** covered by a committed test,
  `apps/browser-tab-mcp/tests/http-interface.integration.test.ts`. The transport family is
  smaller than I claimed; HTTP is infrastructure to extend, not a script to promote.
- **back/forward is not an open bug.** Verified working on George's real Edge across two
  gestured hops, and `forward` verified immediately after. It is a **behaviour to pin**, not a
  defect to fix — and the test should pin the gestureless case too, so the intervention is
  documented in CI instead of rediscovered.
- **`env-loader` 0% coverage is a measurement artifact, not a testing gap** (R7,
  root-caused): `packages/vitest-config/vitest.shared.ts:37` excludes `src/**/index.ts` as a
  barrel heuristic; env-loader is the one package whose `index.ts` is a 102-line implementation
  with zero re-exports, and its only source file. It has 12 passing tests and reports 0/0/0/0.
  **Any plan proposing to arm `COVERAGE_GATE` must fix this first**, or the gate blocks a fully
  tested package and the instinct under gate pressure is to write tests that already exist.

## 6. Decisions the `/plan` session must make

**D1 — scope: Class A subset first, or all 31 surfaces?** *Recommend the subset* (grouping,
focus/window-state, back/forward, discard-if-unblocked, move, plus stdio transport) — the
surfaces where a real-browser test would have caught a real bug. Cost: the coverage table stays
visibly incomplete; mitigate by making the suite state what it omits.

**D2 — fixture strategy: ANSWERED BY MEASUREMENT.** Fresh per file. E4 shows ~1–1.9s per file,
so the cost that would justify sharing does not exist. **This matters because R4's headline risk
was precisely that the shared-`beforeAll` pattern gets copied at scale for cost reasons, letting
one broken command cascade into unrelated failures and destroying per-command diagnostics.**
The measurement removes the motive. Requires the per-file port band from §3.

**D3 — gate CI from day one, or advisory?** *Recommend gating*, matching `e2e-chromium`'s
existing unconditional posture. A suite that doesn't gate doesn't get fixed.

**D4 — which matrix rows?** All three existing rows (they already exist and stay parallel per
George). Running only ubuntu would drop the win32 named-pipe path and Edge's UA-ordering
regression test.

**D5 — Class B identity assertions: in this plan or its own?** *Recommend one scoped task here.*

## 7. Open / blocked / unresolved

- **R9 — DONE.** `discard` is testable in an isolated spec (see §2 E3). Two residual unknowns:
  whether the same teardown occurs on the *Windows CI* msedge leg (measured on George's box, not
  on a GitHub runner), and whether the macOS `SEGV_ACCERR` is purely a bundled-build artifact.
  Neither blocks planning; both should be stated as assumptions in any `discard` task.
- **The gestureless-`goBack` discrepancy** (§2, E2 caveat) — unverified, don't assert it.
- **The AppleScript path** has no CI-reachable coverage strategy at all. Out of scope for a
  Chromium suite; say so explicitly rather than leaving it implied.
- **env-loader coverage fix** — root-caused, two candidate fixes in R7, not applied.

## 8. Do not re-litigate (decided, with evidence)

- `e2e-branded` matrix stays **parallel** (George, this session).
- Safari stays manual-only — no headless Safari, no Xcode-in-CI.
- Broadening fake-adapter coverage is not the fix (R5: zero Class A defects caught).
- `BOUNDS_TOLERANCE_PX` must not be widened (documented anti-fix).
- Branded Chrome ≥137 cannot CLI-load an unpacked extension — measured twice.

## 9. What this competes with (BACKLOG § BRIEF)

SurfingKeys mechanism A · **cgWindowId oscillation (the one OPEN product bug, consumer-visible:
the wm-stack join nulls out exactly during window rearrangement)** · extension identity+pairing
(shares SK's capability-URL question) · TUI polish (3 small known bugs) · B4 mcp-kit de-vendor
(gated on the peer's publish + George).

**My read, offered as an argument:** the sweep and cgWindowId are the two that pay for
themselves and they are complementary — cgWindowId is a live defect, the sweep is the apparatus
that would have caught it. If the cycle holds only one, cgWindowId has a user-visible symptom today.
