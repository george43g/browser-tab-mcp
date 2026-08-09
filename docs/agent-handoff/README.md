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
| `PRD-DEPLOY-RUNBOOK.md` | The next task (PR-D deploy), step-by-step | Check boxes / note results inline as steps complete |
| `BACKLOG.md` | Deferred tasks, parked ideas, open questions for the user | Add / strike items as they land or get answered |
| `DECISIONS.md` | Decision log — what was chosen and why | Append new decisions; never rewrite old ones |
| `GOTCHAS.md` | Operational traps (this machine + this repo's CI) | Append when you hit a new one |

Rule of thumb: **if you learn something the repo can't re-teach, write it
here.** Nothing about this work may live only in an agent's private memory.

## Ground rules (user-set, non-negotiable)

1. **Never merge a PR without the user's explicit say-so.** Open the PR, get
   CI green, report, and wait for the merge word.
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

## Status (2026-08-09, session close) — bug-sweep remediation COMPLETE

`main` = **`6330b0c`**, clean, CI green. The 14-defect bug sweep
(`BUGSWEEP-2026-08-07.md`) is fully remediated: **#22** handle validation ·
**#23** TUI viewport · **#24** build stamp · **#25→#27** `set_window` state
(three wrong fixes before the right one — see GOTCHAS, "geometry poisons a
minimized window") · **#26** human CLI output + env flags · **#28**
release-please · **#29** turbo cache key + `.tsx` test collection · **#30**
`focus_tab` contract + `history.sources` + doc fixes. The plan file
(`~/.claude/plans/gleaming-tumbling-koala.md`) is now historical.

**Open right now:**

- **PR #31 `chore: release main`** — release-please's rolling release PR.
  ⚠ It proposes **`1.0.0`** (release-please's *initial-release* default;
  `bump-minor-pre-major` only affects later bumps). USER DECISION: accept
  1.0.0, or add `"release-as": "0.1.0"` to `release-please-config.json` for
  one cycle. Merging #31 mints the first tag + GitHub Release + CHANGELOG.
- **User-gated reloads for build `+32.6330b0c`**: Chrome
  (`chrome://extensions` ⟳) and Safari (Settings → Extensions → toggle
  "Browser Tab Helper Extension" off/on — the sideload has already been run).
  Until then `doctor` reports the stamp mismatch.
- **Upstream handover**: paste `UPSTREAM-HANDOFF-MESSAGE.md` to the
  `mcp-cli-starter-template` agent (reference doc: `UPSTREAM-KIT-BRIEF.md`).

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
