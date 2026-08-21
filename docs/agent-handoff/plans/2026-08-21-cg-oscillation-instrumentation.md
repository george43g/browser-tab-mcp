# cgWindowId oscillation — instrumentation-first Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. REQUIRED SUB-SKILL for Task 5: superpowers:systematic-debugging (the fix is measurement-gated).

**Goal:** Make the daemon's correlation observable enough that one churn cycle identifies WHY cgWindowIds flip to null during window churn, then fix the identified mechanism — not a guessed one.

**Architecture:** Two PRs. **PR-1 (Tasks 1-3):** a non-breaking diagnostics out-param on `correlateSnapshot`, structured logs at the three currently-silent points, a `BROWSER_TAB_CG_DIAG` env knob. **Measurement (Task 4):** one reproduction cycle on George's Mac against the instrumented daemon, analyzed against the decision table. **PR-2 (Task 5):** the fix the table selects, plus a regression pin.

**Tech Stack:** `@george43g/robustness` logger (`info`/`warn`, snake_case event names, flat field objects; NO debug level exists — detail rides `info` behind the env knob), vitest with the `BROWSER_TAB_YABAI_BIN` shim pattern from `tests/cg-correlation.test.ts`.

**Spec:** `docs/agent-handoff/BACKLOG.md:595-613` (the evidence entry) + § BRIEF item 4 — **with this correction, established by code exploration 2026-08-21:** the brief's hypothesis ("the event-driven merge path runs correlation without the yabai title borrow") is CONTRADICTED. `correlateSnapshot` has exactly one caller in `src/` (`correlate.ts:379`, inside `enrichWithCgWindowIds`), and both the poll path (`engine-loop.ts:124` → `merge.ts:80`) and the event path (`daemon/index.ts:753` → `engine-loop.ts:99` → `merge.ts:80`) reach that same line with the borrow gate intact. Also: the poll tick's extra correlation at `engine.ts:115` is DISCARDED for extension-fed browsers (merge substitutes `feed.state`, whose windows carry `cgWindowId: null` from `ws-server.ts:382`) — `merge.ts:80` is the sole author of their ids. And the observed evidence ("EVERY window read cg:none — **Safari too**") rules out any Chrome-extension-only mechanism.

## Global Constraints

- Rebuild with `pnpm build`, never bare `turbo run build`. `src/**` changes → README delta or `[skip-readme]`; PR-1 is instrumentation with a new env var → README env table + `.env.example` MUST gain `BROWSER_TAB_CG_DIAG` in the same commit (repo rule: every new env read lands in `.env.example` with its default).
- Do NOT widen `BOUNDS_TOLERANCE_PX` (`correlate.ts:49`) — documented anti-fix (`GOTCHAS.md:124-127`); widening makes tiled-window ambiguity worse.
- `correlateSnapshot`'s signature must stay call-compatible: 35 direct test call sites in `tests/correlate.test.ts`. The diag is an OPTIONAL trailing out-param.
- Logging idiom: `info("snake_case_event", { flat, fields })` — see `ws-server.ts:296-309`. correlate.ts already imports `warn` from `@george43g/robustness` (`correlate.ts:42`).
- The four surviving candidate mechanisms (decision table, Task 4) — instrumentation must discriminate ALL of them in one run:
  - **M1 stale-bounds:** `remerge()` (`engine-loop.ts:95-104`) correlates cached `lastPolled` bounds against a FRESH CG read; during churn every cached bound is wrong → zero exact matches → weaker tiers → drop. Path-differential; explains Safari nulling on a Chrome-triggered event.
  - **M2 silent yabai failure:** `readYabaiWindows` swallows every failure per-candidate (`correlate.ts:111-113`, bare catch, 2s timeout) and returns null unlogged → `titles === undefined` → the tested "stays null when no title map" behavior, indistinguishable from "yabai not installed".
  - **M3 sibling-claim cascade:** `correlate.ts:344` — a CG list containing a just-closed window (or missing a just-opened one) makes two snapshot windows claim one CG id → BOTH null. Best fit for "EVERY window read cg:none".
  - **M4 empty display origins:** `listDisplays()` → `[]` (native module absent/failing) silently disables the offset tier.

---

### Task 1 (PR-1): Diagnostics out-param on the pure core

**Files:**
- Modify: `apps/browser-tab-mcp/src/detect/correlate.ts` (`pickCgWindow` :246-266, `correlateSnapshot` :317-358)
- Test: `apps/browser-tab-mcp/tests/correlate.test.ts` (new describe block; existing 34 tests untouched)

**Interfaces:**
- Produces:

```ts
export interface BrowserCorrelationDiag {
  browser: string;
  windows: number;        // windows with bounds that entered correlation
  candidates: number;     // CG windows for this pid at layer 0
  exact: number;          // resolved at the exact-bounds tier
  shifted: number;        // resolved at the display-origin tier
  titleOnly: number;      // resolved at the title-only tier
  nulled: number;         // ended null (tier exhaustion)
  claimCollisions: number;// ids dropped because two windows claimed them
}
export interface CorrelationDiag {
  browsers: BrowserCorrelationDiag[];
  titlesAvailable: boolean;
  originsCount: number;
}
// signature grows one optional trailing param — all 35 existing call sites unchanged:
export function correlateSnapshot(snapshot, cgWindows, zOrdered = false, titles?, displayOrigins = [], diag?: CorrelationDiag): Snapshot
```

- [ ] **Step 1: Write the failing tests** (reuse the tiled fixtures at `correlate.test.ts:147-160` verbatim — same `TILED` bounds, same `cg()` helper):

```ts
describe("correlation diagnostics", () => {
  it("counts tier resolution per browser", () => {
    const diag: CorrelationDiag = { browsers: [], titlesAvailable: false, originsCount: 0 };
    correlateSnapshot(tiledSnapshot(), tiledCg, false, titles, [], diag);
    expect(diag.browsers[0]).toMatchObject({ windows: 3, candidates: 3, exact: 0, titleOnly: 3, nulled: 0 });
    expect(diag.titlesAvailable).toBe(true);
  });
  it("counts claim collisions as collisions, not plain nulls", () => {
    // two snapshot windows, one CG candidate both must claim (the :249 drop case)
    const diag = emptyDiag();
    correlateSnapshot(twoWindowsOneCg(), oneCg, false, undefined, [], diag);
    expect(diag.browsers[0]).toMatchObject({ claimCollisions: 2, nulled: 0 });
  });
  it("nulled counts tier exhaustion", () => {
    const diag = emptyDiag();
    correlateSnapshot(tiledSnapshot(), tiledCg, false, undefined, [], diag); // no titles → all ambiguous
    expect(diag.browsers[0]).toMatchObject({ nulled: 3, claimCollisions: 0 });
  });
});
```

- [ ] **Step 2: Run to verify they fail** (`diag` param doesn't exist).

- [ ] **Step 3: Implement.** `pickCgWindow` returns `{ cg: CgWindowInfo | null; tier: "exact" | "shifted" | "title" | "none" }` internally (rename the current body; keep the exported behavior identical). `correlateSnapshot` tallies per browser into `diag` when provided: tier counts from the pick results, `claimCollisions` from the `claims.get(cg.windowId) !== 1` branch at :344, `nulled` from `cg === null`. Purity preserved: no logging, no I/O, no behavior change — the function's OUTPUT snapshot must be byte-identical with or without `diag` (assert that in one extra test: `expect(withDiag).toEqual(withoutDiag)`).

- [ ] **Step 4: Run the FULL correlate suite** — all 34 existing tests + new ones PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/browser-tab-mcp/src/detect/correlate.ts apps/browser-tab-mcp/tests/correlate.test.ts
git commit -m "feat(detect): correlation diagnostics out-param — tier counts, claim collisions, no behavior change"
```

---

### Task 2 (PR-1): Log the three silent points

**Files:**
- Modify: `apps/browser-tab-mcp/src/detect/correlate.ts` (`readYabaiWindows` :86-116, `enrichWithCgWindowIds` :360-384)
- Modify: `apps/browser-tab-mcp/src/daemon/engine-loop.ts` (`tick` :112-135, `remerge` :95-104)
- Modify: `apps/browser-tab-mcp/.env.example` (new: `BROWSER_TAB_CG_DIAG=0`)
- Test: `apps/browser-tab-mcp/tests/cg-correlation.test.ts` (extend, same yabai-shim pattern)

- [ ] **Step 1: Write the failing test** — yabai failure is currently invisible; pin that it warns:

```ts
it("a failing yabai binary is logged, not swallowed", async () => {
  // shimYabai variant: #!/bin/sh\nexit 1  (copy shimYabai at :57, make it exit 1)
  const warns = captureWarns(); // vi.mock @george43g/robustness partially: importOriginal, spy warn
  await enrichWithCgWindowIds(tiledSnapshot());
  expect(warns.some(([msg, data]) => msg === "yabai_query_failed" && typeof data?.durMs === "number")).toBe(true);
});
```

(Partial-mock shape: `vi.mock("@george43g/robustness", async (importOriginal) => ({ ...(await importOriginal()), warn: warnSpy }))` — hoisted above imports.)

- [ ] **Step 2: Run to verify it fails** (no such warn exists).

- [ ] **Step 3: Implement the three points.**

**(a) `readYabaiWindows`** — per-candidate failure and final give-up both warn:

```ts
const started = Date.now();
try { … } catch (err) {
  warn("yabai_query_failed", { bin, message: (err as Error).message, durMs: Date.now() - started });
}
// after the loop, before `return null`:
warn("yabai_titles_unavailable", { candidates: yabaiCandidates().length });
```

(2s timeout under churn — yabai itself is busy retiling — now shows up as `durMs≈2000` instead of nothing. M2's fingerprint.)

**(b) `enrichWithCgWindowIds`** — build a `CorrelationDiag`, pass it to `correlateSnapshot`, then:

```ts
const nulled = diag.browsers.reduce((n, b) => n + b.nulled + b.claimCollisions, 0);
if (nulled > 0 || cgDiagEnabled()) {
  info("cg_correlate", {
    borrowed: borrowedTitles,          // did the needsTitleTiebreak borrow fire
    titlesAvailable: diag.titlesAvailable,
    origins: diag.originsCount,
    browsers: diag.browsers,           // small array of flat objects
    cgReadMs, borrowMs,                // Date.now() deltas around the two reads
  });
}
```

`cgDiagEnabled()` reads `BROWSER_TAB_CG_DIAG` (default off; quiet steady-state stays quiet — the log fires exactly when ids degrade, which is the event under investigation). Add the var to `.env.example` with a one-line comment in this commit.

**(c) `engine-loop.ts`** — stamp `this.lastPolledAt = Date.now()` where `tick()` assigns `this.lastPolled` (:119), and log the trigger + staleness on every merge:

```ts
// in tick(), before merger.merge(...):
info("cg_merge_trigger", { trigger: "poll", lastPolledAgeMs: Date.now() - this.lastPolledAt });
// in remerge(), before merger.merge(...):
info("cg_merge_trigger", { trigger: "event", lastPolledAgeMs: Date.now() - this.lastPolledAt });
```

Gate both behind `cgDiagEnabled()` (remerge fires on every extension event — unconditional logging would be noisy). This is M1's fingerprint: `trigger:"event"` + large `lastPolledAgeMs` + `exact:0` in the adjacent `cg_correlate` line. Note `browsersToPoll` (`engine-loop.ts:138-142`): extension-connected browsers rescan only every `EXT_VERIFY_EVERY_TICKS = 6` ticks, so ages up to ~30s are NORMAL — the diagnostic question is whether nulls correlate with age.

- [ ] **Step 4: Run** `pnpm --filter browser-tab-mcp test` — PASS (the diag-enabled paths are exercised by the extended cg-correlation tests; steady-state tests see no new output).

- [ ] **Step 5: Sabotage check** — comment out the `yabai_query_failed` warn → test red → restore → verify `git diff` shows only intended changes.

- [ ] **Step 6: Commit**

```bash
git add apps/browser-tab-mcp/src/detect/correlate.ts apps/browser-tab-mcp/src/daemon/engine-loop.ts apps/browser-tab-mcp/.env.example apps/browser-tab-mcp/tests/cg-correlation.test.ts
git commit -m "feat(daemon): cg correlation observability — yabai failures logged, diag line on id degradation, merge-trigger staleness"
```

---

### Task 3 (PR-1): README + ship the instrumentation

- [ ] **Step 1:** README env table gains `BROWSER_TAB_CG_DIAG`; one paragraph in the correlation section: "when ids degrade, the daemon logs `cg_correlate` with per-tier counts".
- [ ] **Step 2:** `pnpm verify` + (macOS) `pnpm verify:macos` via the pre-push hook — the native path matters here since correlation is the feature.
- [ ] **Step 3:** Push branch `feat/cg-observability`, open PR-1 titled `feat(daemon): cgWindowId correlation observability`. **George's word gates the merge, and the MEASUREMENT needs this build running as the Mac daemon — which means a Mac redeploy (user-gated). George already owes the Mac a v1.3.2 redeploy; fold this into the same redeploy.**

---

### Task 4: The measurement (one churn cycle, George-adjacent)

Not a code task. Protocol:

- [ ] **Step 1:** With the instrumented daemon deployed and `BROWSER_TAB_CG_DIAG=1` in the daemon's env (launchd plist env or `~/.browser-tab` env file — however the deployed daemon reads env on this machine), confirm via `browser-tab daemon status` that the running build carries the instrumentation (check the build stamp — the rebuilt-on-wrong-branch trap is documented; check `doctor`'s build line).
- [ ] **Step 2:** Reproduce the BACKLOG repro exactly: open the TUI, note cg badges; two `browser-tab window open` calls + `r` refresh; watch for `cg:none` flips; wait for repair. ~5 minutes of churn.
- [ ] **Step 3:** Pull the NDJSON (`$TMPDIR/browser-tab-mcp/…` per the daemon's log dir; or `get_logs` under MCP_DEV) and filter `cg_correlate`, `cg_merge_trigger`, `yabai_query_failed`, `yabai_titles_unavailable` around the flip timestamps.
- [ ] **Step 4: Decide against the table** — one mechanism per fingerprint:

| Fingerprint in the logs at flip time | Mechanism | Fix (Task 5 implements EXACTLY ONE) |
|---|---|---|
| `trigger:"event"`, large `lastPolledAgeMs`, `exact:0`, `shifted+titleOnly` attempts | **M1 stale bounds** | Sticky ids (below) — retention beats rescan-per-event |
| `yabai_query_failed durMs≈2000` / `yabai_titles_unavailable`, `titlesAvailable:false`, `nulled>0` | **M2 yabai under churn** | Cache the last good `TitleMap` for ~10s and reuse on failure (a title is stable over seconds; a missing map nulls everything) |
| `claimCollisions > 0` dominating | **M3 sibling cascade** | Prior-assignment tiebreak: a window that held id X last snapshot keeps X when the collision set includes X |
| `origins: 0` on a multi-display machine | **M4 no native origins** | Doctor check + warn; offset tier documented as requiring the native module |

More than one fingerprint may appear; fix the one that accounts for the observed flips, file the rest as BACKLOG entries with their log evidence attached.

**The likely fix, sketched now so Task 5 is not a placeholder — STICKY IDS (M1, and it also blunts M3):** a CG window's id is stable for the window's lifetime (ids never change on move/resize — only close). So retention is principled: once handle H resolved to cg id X, keep X while X is still present in the current CG candidate list for the same pid, even when THIS round's bounds/title matching failed. Implementation: in `enrichWithCgWindowIds`'s caller layer (daemon-side, NOT in pure `correlateSnapshot`), hold `Map<windowHandle, cgWindowId>`; after correlation, for each window that came back null, restore the remembered id IF it exists in this round's candidate set AND no other window resolved to it this round; windows that resolved update the map; ids absent from the CG list evict. **Safety bound:** `screenshot`'s window tier captures by cgWindowId (`daemon/screenshot.ts:222-236`) — a WRONG id captures the wrong window silently, so stickiness must never override a FRESH successful resolution, only fill a null. Bounds adoption (`correlate.ts:348-350`) doesn't fire for restored ids (no fresh match to adopt from) — restored windows keep their reported bounds; state that in the fix PR.

---

### Task 5 (PR-2): The gated fix + regression pin

**Precondition: Task 4 completed and ONE mechanism selected. Do not start this task on hypothesis — that is how the contradicted brief hypothesis would have cost a cycle.**

- [ ] **Step 1: Write the failing regression test** reproducing the measured mechanism with fixtures — e.g., for M1/sticky: correlate once with resolving inputs (ids assigned), then correlate again with degraded inputs (no titles, stale bounds) against the SAME CG list → ids must survive; then with the CG window REMOVED from the list → id must evict to null.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement the table-selected fix** (sticky-ids sketch above if M1/M3; title-cache if M2; doctor surface if M4).
- [ ] **Step 4:** Full suite + `pnpm verify:macos` + the Task 4 repro re-run on the Mac: badges must survive the two-window-open churn with zero `cg:none` flips.
- [ ] **Step 5:** Close the BACKLOG evidence entry (:595-613) with the measured mechanism + log excerpt; note the brief's hypothesis was contradicted and what replaced it.
- [ ] **Step 6:** Push branch `fix/cg-oscillation`, open PR-2 with the evidence in the body. George's word gates the merge.
