# R6 — What the /plan session must DECIDE, and what it is competing with

Written before the research agents reported, so it deliberately contains no findings —
only the decision structure and the opportunity cost. Findings slot in later.

## A. The forced choices (each needs a decision before tasks can be written)

Each is stated as a choice with a cost, not a menu. My recommendation is first.

**D1 — Suite scope: all ~25 surfaces, or the Class A subset?**
- *Recommend:* start with the surfaces where a real-browser test would have caught a real
  bug (grouping, focus/window-state, back/forward, discard, move) and the transports; defer
  the rest. Cost: the coverage table stays visibly incomplete, which invites "we tested it"
  misreadings — mitigate by making the suite's own README state what it deliberately omits.
- *Alternative:* full sweep of every surface. Cost: a much larger suite whose marginal tests
  cover surfaces where dispatch-only has never failed us; more CI minutes and more flake
  surface for no measured risk reduction.

**D2 — Fixture strategy: fresh per file, or shared context?**
Depends on the measured per-fixture cost (R2/E4). If a daemon+browser launch is cheap, fresh
per file is strictly better (isolation, parallelism, honest failures). If it is expensive,
sharing trades isolation for wall-clock and introduces cross-test coupling — which is the
classic source of e2e flake. **Do not decide this from taste; decide it from the number.**

**D3 — Does the suite gate CI, or run advisory first?**
- *Recommend:* gate from day one, matching `e2e-chromium`'s existing posture (unconditional,
  no `continue-on-error`). A suite that doesn't gate doesn't get fixed.
- *Alternative:* advisory for one cycle. Cost: real-browser flake is discovered in a mode
  where nobody has to act on it, so it is discovered slowly.

**D4 — Which matrix rows run the sweep?**
The existing three (ubuntu-chromium, windows-chromium, windows-msedge) already exist and
George has decided they stay parallel. The question is only whether the sweep runs on ALL
three or one. Cost of all three: ~3× the sweep's minutes, free on a public repo, and it is
the only way the win32 named-pipe path and Edge's UA ordering keep their coverage.

**D5 — Class B (environment binding) — in this plan or its own?**
Per R5, more e2e tests would not have caught the global-pipe defect. The fix is identity
assertions. It is small and unrelated to the sweep's mechanics. *Recommend:* one task inside
this plan, explicitly scoped, rather than a separate cycle — it is ~an afternoon and it
closes a class that has already bitten once.

## B. What this competes with (from BACKLOG § BRIEF, 2026-08-21)

The sweep is not the only candidate for the cycle. Stated fairly, so the choice is real:

1. **SurfingKeys mechanism A** — serve `config.js` from the daemon; kills a dead-copy drift
   that is verified real. Has one unsolved design question already identified (SK's plain GET
   cannot send an auth header → capability URL vs auth exemption), and it shares that question
   with #6 below, so doing them together is cheaper than doing either alone.
2. **cgWindowId oscillation** — the one OPEN product bug, macOS-only, consumer-visible
   (the wm-stack join nulls out exactly during window rearrangement, its moment of need).
   Plan shape is already settled: instrument both merge paths for one churn cycle BEFORE
   changing anything. This is the only item on the list that is a live defect rather than
   an investment.
3. **Extension identity + pairing** (manifest `key`, then a fetch-token button) — kills the
   per-machine token paste. Shares the capability-URL question with #1.
4. **TUI polish** — three small known bugs (stale message after cancel, half-page motions
   don't retire the message, `--fields summary` header prints "0 tabs").
5. **B4 mcp-kit de-vendor** — gated on the peer's publish and on George.

**My read, offered as an argument not a conclusion:** the sweep (this brief) and #2 are the
two that pay for themselves, and they are complementary — #2 is a defect, the sweep is the
apparatus that would have caught it. #1+#3 are a natural pair but neither is urgent. If the
cycle can only hold one, #2 is the one with a user-visible symptom today.

## C. What the /plan session should NOT re-litigate

Decided, with evidence, do not reopen:
- The `e2e-branded` matrix stays **parallel** (George, this session).
- Safari stays manual-only — no headless Safari, no Xcode-in-CI.
- Broadening fake-adapter coverage is not the fix (R5: would have caught zero Class A bugs).
- `BOUNDS_TOLERANCE_PX` must not be widened (documented anti-fix).
- Branded Google Chrome ≥137 cannot load an unpacked extension by CLI — measured twice.
