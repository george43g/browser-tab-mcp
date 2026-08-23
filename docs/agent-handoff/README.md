# Agent handoff — active work state (START HERE)

> **Audience:** whichever agent is working this repo right now. (The 2026-07-27
> → 07-29 Codex interlude never happened — the tree was untouched and Claude
> resumed on 07-29.) **This directory is the single source of truth
> for in-flight work** — it replaces any private agent memory, which the other
> agent cannot read. Repo architecture/conventions live in `AGENTS.md`; this
> directory holds what the code can't tell you: status, the next task,
> decisions, backlog, and gotchas.
>
> Not to be confused with `docs/HANDOFF.md` — that's the *historical*
> original-build handoff (2026-07-21), still useful for the smoke checklist and
> key-files orientation map.

## How to use this directory

| File | Holds | When to touch |
|---|---|---|
| `README.md` (this) | Status + ground rules + doc map | Keep the Status section current as things land |
| `PROGRESS-LOG.md` | Append-only work journal | **Append an entry every working session** — what you did, how you verified it, what's next / blocked on |
| `PRD-DEPLOY-RUNBOOK.md` | **Historical**: the PR-D deploy runbook, EXECUTED 2026-07-29 | Read-only record — not the next task |
| `BACKLOG.md` | Deferred tasks, parked ideas, open questions for the user | Add / strike items as they land or get answered |
| `DECISIONS.md` | Decision log — what was chosen and why | Append new decisions; never rewrite old ones |
| `GOTCHAS.md` | Operational traps (this machine + this repo's CI) | Append when you hit a new one |

Rule of thumb: **if you learn something the repo can't re-teach, write it
here.** Nothing about this work may live only in an agent's private memory.

## Ground rules (user-set, non-negotiable)

1. **~~Never merge a PR without the user's explicit say-so.~~ SUPERSEDED
   2026-08-24 — George, verbatim: _"all prs are approved to merge"_** (said
   while approving #99 and #108 individually, then generalising). Standing
   authority to merge, **conditional on green CI** — the bar in rule 5 is
   unchanged, and a red or pending check is still a stop. The original rule is
   left visible rather than deleted, because the conditionality is the whole
   content of the change: what was withdrawn is the wait for a merge word, not
   the requirement that the PR be green and reported.

   Two things this does NOT cover, both learned the hard way and both still
   requiring a word: a PR that touches **another agent's in-flight work** (see
   #108), and anything under rule 4.
2. **Never commit/push to `main` directly** — branch per workstream, one PR
   per workstream, each independently green. Squash-merge with a
   conventional-commit title.
3. **Commits are signed** (1Password SSH signing). If signing fails
   (`1Password: failed to fill whole buffer`), ask the user to unlock
   1Password, then `git commit --amend --no-edit -S && git push --force-with-lease`.
4. **User-gated steps stay user-gated:** global install, `daemon install`
   (launchd + TCC consent), loading browser extensions, anything touching
   macOS permissions. Tell the user exactly what to run/click, then wait.
5. Per-PR verification bar: bare `pnpm lint` (read its REAL exit code — see
   GOTCHAS) · `pnpm typecheck` · `pnpm test` · `pnpm test:no-native` ·
   `pnpm build` · `pnpm stress` · e2e when the extension/daemon path is
   touched · sabotage-check any new guard test.
6. **No AI inside the tool.** browser-tab serves data/actuation; the consumer
   AI interprets. (`annotate` is a cache substrate, never intelligence.)

## Status (2026-08-22) — v1.4.0 released · Windows+Edge live-verified · zero open PRs

`main` = **`4bd864b`**. Working tree clean apart from two UNTRACKED specs that
are not this session's (`docs/tab-selection-transformation-language-spec.md` and
a root-level copy) — left in place deliberately.

**Released:** v1.4.0 (2026-08-22), cut unattended by release-please as usual.

**Landed this cycle:** Edge as a first-class browser (#84) · cg observability
PR-1 (#85) · TUI port onto tui-kit 0.5 primitives (#87) · `robustness@^0.11.0`
caret-starvation fix (#88) · disjoint integration-test port bands, which
root-caused a 3-red CI flake to a shared band, not the dep (#90) ·
branded-browser e2e — real Windows Edge + Windows Chromium in CI (#92) ·
checkpoint + backlog (#94) · stress step relabelled 14 cases (#95) ·
the real-browser-effect research brief (#96).

**Deployment:** the Windows box (`g-home-server`) is at v1.4.0 with George's
REAL Chrome and REAL Edge both connected as separate extension sessions, Edge
auto-detected via its `edg/` UA. **His browsers load from the
`D:\browser-tab-mcp\dist` DEPLOY COPY — refresh that after any rebuild or his
reload silently picks up a stale bundle.** The **Mac** deployment is still
behind and is user-gated (see BACKLOG).

**Testing posture, measured 2026-08-22:** 2 of 31 command surfaces are
effect-verified against a real browser; 21 are dispatch-only. The evidence and
the experiments behind that number are in
`plans/2026-08-22-command-sweep-research-brief.md` +
`research/2026-08-22-command-sweep/`. Read the brief before planning test work.

**Blocked on the user right now:** Mac redeploy + the `BROWSER_TAB_CG_DIAG=1`
churn measurement (which in turn blocks the cgWindowId oscillation bug) · the
Windows ONLOGON/headless ruling · picking the next work cycle (the command-sweep
e2e suite is a first-class candidate) · the `@george43g/mcp-kit` de-vendor.

## Historical status (2026-08-16) — v1.1.0 released · 3 stress-test fixes merged · release HELD

`main` = **`e95f6d8`**. Working tree clean. Daemon runs the merged build.

**Released:** v1.1.0 (2026-08-10) — the **second consecutive unattended cut**.
Release automation is proven twice; stop treating a cut as risky.

**Merged since, all from an adversarial stress pass (see "Stress-test findings"
in `BACKLOG.md`):**

| PR | What |
|---|---|
| **#42** `59131cf` | CLI exit codes — a failing tool exited **0** for every piped/`--json`/CI caller and 1 only for a human. Plus a stable `{error:{tool,message}}` JSON shape instead of leaking the MCP envelope. |
| **#43** `2edcc63` | Kit upgrade: `robustness@^0.7.0` / `cli-kit@^2.0.1` / `tui-kit@^0.4.1`. **Both app shims deleted** — `ShotBucket` and the REPL image adapter. |
| **#45** `e95f6d8` | TUI width safety — rows and chrome both clamped to the terminal. Two causes; see PROGRESS-LOG. |

**[RESOLVED — superseded; the release was later cut and the project is past v1.4.0 as of 2026-08-22. Kept verbatim as the record of the decision at the time.]** **OPEN AND DELIBERATELY HELD: PR #44 `chore(main): release 1.1.1`.** The user
chose "merge #45 only, hold the release" (2026-08-16) so more stress-test fixes
can batch into one version. Merging it cuts the release; it will re-title itself
as more lands. **Do not merge it without asking.**

**Kit version rule, learned twice the hard way:** run
`npm view @george43g/<kit> version` before any bump. cli-kit was relayed to us as
`1.0.0` twice and the registry served `2.0.0` (byte-identical `dist/`; a
docs-only commit's prose spelled a breaking-change token and cut a spurious
major). A relayed number is a cache with no invalidation.

**[SUPERSEDED — robustness is at `^0.11.0` since #88 (2026-08-22).]** **Available, NOT adopted:** `@george43g/robustness@0.8.1` (shutdown-cause
reporting, `WatchdogState.memorySampled`, live memory read before the first
sample). Adds two new diagnostics — `stdin_eof` and `orphaned` — that previously
emitted nothing; harmless for us (no `onDiagnostic` sink matches on names).
**Do NOT adopt 0.8.0** — it recorded shutdown cause before the exit-policy gate.
Not on the user's work list; ask before bumping.

## Historical status (2026-08-10) — v1.0.1 RELEASED unattended · kits are npm deps

**The release automation is PROVEN.** Merging release PR #37 minted tag
`v1.0.1` + the GitHub Release + the `autorelease: tagged` relabel with **no
manual recovery** — closing the #31→#33(wrong)→#36(right) saga. #38 (kit
migration) merged just before it: `@george43g/{robustness,cli-kit,tui-kit}` are
npm deps at `^0.6.0`/`^0.3.1`/`^0.3.3`, the four frozen workspace copies
(incl. unused `secrets`) are deleted, and the REPL works again.

**In flight right now:** branch `fix/safari-cgwindowid-correlation` — Safari
windows reported `cgWindowId: null` on any non-primary monitor because Safari's
WebExtension API reports `top` display-local while `left` stays global. Fixed in
`detect/correlate.ts` (display-origin offset tier → title-only last resort, and
the matched CG frame is adopted so `bounds` stop lying). Full detail + the
disproved earlier theory: `BACKLOG.md` item 5.

**Queued behind it** (user-sequenced, 2026-08-10):
1. ~~**Heartbeat file**~~ **DONE** — branch `feat/daemon-heartbeat`.
   `~/.cache/browser-tab/heartbeat.json`, written at the end of every completed
   engine tick (`EngineLoop.setOnTick` → `SnapshotWriter.heartbeat`), removed on
   a clean stop, carrying `snapshotChangedAt`. Kept separate from
   `snapshot.json` so that file's mtime keeps meaning "state changed" — the two
   questions ("alive?" / "current?") need two files.
2. ~~**Kit shim removal**~~ **DONE** — branch `chore/kit-upgrade-2026-08`.
   Consuming `robustness@^0.7.0` / `cli-kit@^2.0.0` / `tui-kit@^0.4.0`. Both
   shims gone: `ShotBucket` (robustness shipped the `tryAcquire` we specified)
   and the REPL image adapter (cli-kit's `ToolCallResult` now carries our
   `text | image` union). **cli-kit's version was relayed to us as 1.0.0 twice
   and is actually 2.0.0 — the two are byte-identical in `dist/`. Read
   `npm view`, never a relayed number.**

**Cross-session note:** the wm-stack consumer is adopting the read path now —
Chrome-only for M1, Safari deferred until the fix above lands, fixtures encoded
from the snapshot **file** surface. They asked to be pinged with the commit.

## Historical status (2026-08-09, later session) — v1.0.0 RELEASED · kits migrated

**v1.0.0 is released** (tag + GitHub Release + CHANGELOG exist — the tag was
cut *manually* after release-please's cut silently failed; the config is now
fixed, see GOTCHAS "release-cut" + `docs/RELEASE.md`). `main` history since
the bug sweep: **#31** v1.0.0 release PR · **#32** version-map fix · **#33**
release title pin (**wrong fix**, superseded) · **#34** test debts · **#36**
the real release-cut fix (componentless branch → component branch) · the
**kit-migration PR** (this session — see below).

**Open right now:**

- **Rolling release PR #37** `chore(main): release 1.0.1` — merging it
  (user-gated) is the end-to-end proof of the #36 fix: the workflow must mint
  the tag by itself. **After ANY release-PR merge, verify the tag exists.**
- **Kit migration PR** — `@george43g/{robustness,cli-kit,tui-kit}` are now
  npm deps (`^0.6.0`/`^0.3.1`/`^0.3.3`); the four frozen workspace copies
  (incl. unused `secrets`) are deleted. The REPL is repaired by cli-kit 0.3.1.
  Next upstream asks queued in BACKLOG: robustness `TokenBucket.tryAcquire`,
  cli-kit image-block `ToolCallResult`.
- **User-gated reloads for build `+32.6330b0c`**: Chrome
  (`chrome://extensions` ⟳) and Safari (Settings → Extensions → toggle
  "Browser Tab Helper Extension" off/on — the sideload has already been run).
  Until then `doctor` reports the stamp mismatch. (The extension bundles are
  untouched by everything since `6330b0c` — extension-core depends only on
  shared-types — so this reload is still the only browser-side step owed. The
  **daemon** is different: once the kit-migration PR merges, rebuild + restart
  it so it runs the published-kit bundle.)

Everything else deferred/parked lives in `BACKLOG.md` — start there.

## Historical status (2026-07-29)

**PR-D is DONE — the tool is deployed and smoke-tested against real Chrome +
Safari.** `move`, `get_page`, `act`, `screenshot`, `journal`, and daemon
restart/reconnect all verified live. **→ NEXT: BACKLOG item 1, the `cgWindowId`
tiebreaker** — PR-D proved the wm-stack join returns `null` for every Chrome
window under yabai tiling, which blocks the wm-stack rewire from being useful.
Full PR-D results + all three findings: `PRD-DEPLOY-RUNBOOK.md`.

Prior to that, all code work was already merged:

- `main` = `6b8508a`, clean, fully green: lint 0 warnings · typecheck ·
  test · test:no-native · stress 25/25 · e2e-chromium.
- Cleanup/productionization pass (order was C→B→A→D, user-chosen — see
  DECISIONS):
  - **PR-C #14** (`35efdf8`) — self-contained global bin: the five
    `@george43g/*` workspace packages bundle inline, so `pnpm add -g .`
    works. Clean-room proven (ran with zero workspace packages on disk).
  - **PR-B #15** (`1d22cbf`) — +37 risk tests: state-diff, engine-loop TTL
    floor, tabs-service daemon-down degrade (real dead socket, no mocks),
    registry catalog.
  - **PR-A #16** (`6b8508a`) — shared-types 1039-line barrel split into 9
    domain modules (`packages/shared-types/README.md` documents the layout +
    invariants); all 8 biome warnings cleared.
- Before that: the v2 contract expansion (#5–#10), TUI badges #11, favicons
  #12, Playwright e2e round-trip #13 — all merged. History: `git log`,
  `docs/HANDOFF.md`, `docs/FOLLOWUPS.md`.

`BACKLOG.md` holds the queue.

## Live machine state (verify, don't assume) — as of 2026-07-29

- launchd daemon `com.george43g.browser-tab` runs the **workspace** build
  (`apps/browser-tab-mcp/dist/cli.js`), WS port 8790, correlation tier
  `native`. **`daemon install` was deliberately NOT run** — it stays on the
  workspace path so the native tier and the existing TCC grant survive
  (DECISIONS 2026-07-29). If you ever repoint it, expect a TCC re-prompt.
- `browser-tab` **is installed globally** (`~/Library/pnpm/browser-tab`) — but
  pnpm *linked* the workspace rather than copying, so the global command
  depends on this repo staying put, and it loads the native `.node`.
  Agent tool-shells must prefix `PATH="$PNPM_HOME:$PATH"` for `pnpm add -g`.
- Both **Chrome and Safari run the real connector extension**
  (`extensionConnected: true`, full capabilities). Safari needed full Xcode —
  the user has it. Token `~/.browser-tab/extension-token` survives reloads.
- After any rebuild that should reach the daemon:
  `pnpm build && browser-tab daemon restart`. After an **extension** rebuild
  you must also reload it in the browser — a rebuilt extension is not a
  reloaded one (GOTCHAS).
