# tmux-control — a second control-tool app, and the monorepo test it carries

> **STATUS 2026-09-20 — PROPOSED, awaiting George's review.** Investigation and
> design are complete and every load-bearing mechanism below was measured on
> this Mac the same day. Nothing is built. Phase 0 is a go/no-go experiment
> whose result can end the plan; read its exit criteria before the rest.

**Requested by George, 2026-09-20:** *"its time you generate a new app - this is
ambitious but it really puts the monorepo to the test - if the test fails, that
determines we cant put multiple app control tools in here but hopefully it all
works out."* Asked which capability should lead v1, he chose **agent-safe
driving** over the wm-stack join, the event journal and semantic layouts.

**Gate note.** `docs/deep-application-control-platform-architecture.md`
(2026-08-29) already names this app (`apps/tmux-control`, its "Phase 4 — thin
tmux spike") and BACKLOG records that document as USER-GATED: no plan or code
until George rules on, among other things, "the browser/tmux product boundary".
This plan treats his request as lifting that gate **for the tmux app only**. The
document's other gated choices — the reduced transform set, the five-tool MCP
surface, the `control-language` naming — stay gated and nothing here depends on
them. Two of its rulings are adopted as written: **one monorepo while the
architecture is still being discovered**, and **no daemon first** (tmux is
already a persistent server; add one only if a journal or subscription fan-out
is measured to need it).

## 1. Why a program at all — and what it is NOT

The analysis George pasted is right that tmux needs far less than browsers did:
stable ids (`$2`/`@22`/`%32`), a complete verb surface, `-F` format strings and
a control-mode event feed all ship in the box, so browser-tab's two hardest
parts — correlation and the connector extension — have no analogue. For plain
manipulation, a skill is the right answer and `use-tmux-terminals` already is
one. **This app does not re-wrap the tmux CLI**, and a tool that mirrors
`move-window` behind an MCP name is out of scope for good.

What a skill cannot do is make an unsafe path impossible. Measured cost, one
session, 2026-09-07 → 2026-09-20:

- **Focus theft.** `new-window -t claude:` without `-d` moved George's screen
  onto an agent's job. The skill's rule covered `select-*` only; the fix had to
  be restated as a class (dotfiles `90a0155`).
- **ZLE mangling.** zsh autopair appended `}` to a `{ …; }` group sent by
  `send-keys`; the line died with `parse error near '}'` and read as a dead
  pane. Three panes lost to it.
- **Screen scraping.** `capture-pane` returned nothing, twice. Cause measured
  below: tmux's own "Pane is dead" line scrolls output into history.
- **No return value.** Completion was an until-loop grepping a pane for a
  marker string the command had to echo.

Every one is wrapper-shaped, every agent on the machine pays it, and the
previous attempt to fix it with an MCP was **tried and rejected**.

## 2. Existing solutions — the record

Searched 2026-09-20 across npm, GitHub, Homebrew, PyPI, skills.sh and this
fleet. The deliverable of that search is this record, not a verdict.

| Candidate | What it is | Finding |
|---|---|---|
| `bnomei/tmux-mcp` (`tmux-mcp-rs` 0.6.0, Rust) | the most active tmux MCP | **Installed fleet-wide, then removed 2026-08-30 as "not stable"** (this repo `76fb159`; `~/dotfiles/TMUX-MCP-EVALUATION.md`). Its verified defects are this plan's requirements: tracked mode forbids unquoted `#`, `&` and newlines; completion is a three-step side channel, not a return value; an isolated socket hides the work from the human; 57 tools is a standing context tax. |
| `tmux-python/libtmux-mcp` | one-call `run_command` → exit status + output | The right SHAPE, and the evaluation's own pick. Alpha, no tagged release, adds a Python runtime to a Node fleet. Design reference, not a dependency. |
| `libtmux/libtmux-ts` (+ `@libtmux/mcp`) | typed tmux control for Bun/TS, 45-tool MCP | MIT, but 0 stars, alpha-tagged, "not recommended for production". 45 tools repeats the context tax. |
| `k8ika0s/mcp-tmux` | tmux MCP with confirm-gated destructive ops | The only one with safety rails — **AGPL-3.0-only**, which would taint a wrapped binary. Pattern reference only. |
| `nickgnd/tmux-mcp` | the most-starred tmux MCP | Stale since 2026-02; detects completion by prompt-scraping — the exact anti-pattern. |
| `tmuxinator` + `sesh` | declarative layouts, session picker | **Already deployed in dotfiles.** Semantic layouts are ADOPT, never write: at most a naming script over these. Removed from this app's scope. |
| `openclaw/openclaw@tmux` (8.1K installs), `use-tmux-terminals` | agent skills over the plain CLI | The house skill stays the knowledge layer. This app is what it delegates the unsafe verbs to. |
| Node control-mode (`tmux -C`) parsers | — | None maintained (believed, not exhaustively read). A small write, later phase, and only if the journal is built. |
| tmux pane → CGWindowID join | — | Nothing exists. In-house prior art only: `src/detect/correlate.ts`. Later phase. |

**Decision: write a thin app over the tmux CLI**, because the one overlapping
tool was adopted, used for weeks and rejected for stated reasons, and the only
candidate with the right shape is an alpha Python server.

## 3. Measured on this Mac, 2026-09-20 (tmux 3.7b)

All on a private throwaway server (`tmux -L probe-<pid> -f /dev/null`), never
George's. These are the design's foundations, so they become test fixtures.

1. **A command run AS the pane's process needs no `send-keys`.**
   `new-window -d "sh -c '…'"` ran a string containing `{}`, `"`, `#` and `&`
   untouched. Nothing passes through zsh/ZLE, so autopair and quoting are moot.
2. **Exact exit codes, no markers.** With `remain-on-exit on`,
   `#{pane_dead}`/`#{pane_dead_status}` read `1`/`0`, `1`/`7`, `1`/`3` for
   commands exiting 0, 7 and 3; a still-running pane reads `0`/empty.
3. **Completion without polling.** `tmux wait-for <channel>` returned 1.03s
   after a 1s command signalled `wait-for -S <channel>`.
4. **Screen capture is unreliable BY CONSTRUCTION.** The "Pane is dead" message
   scrolls the screen one line (`#{history_size}` = 1), so a visible-only
   `capture-pane -p` lost the first output line every time. `-S -` recovers it.
5. **File capture is exact.** `( cmd ) > log 2>&1` and
   `set -o pipefail; ( cmd ) 2>&1 | tee log` both kept every line and the exit
   code (9 and 6). The `tee` form keeps the pane watchable live.
6. **The wm-stack join's open question is closed.** yabai's AX title for the
   kitty window is exactly tmux's `set-titles-string` output
   (`"Georges-MacBook-Pro ❐ claude ● 8 browser-tab-mcp"`), so a title tmux
   controls reaches yabai. kitty runs `--single-instance` (one pid, many
   windows), so pid alone can never pick the window; remote control is off.
   The join is buildable with a unique token in the title — a later phase.

## 4. Design

**Shape.** `apps/tmux-control-mcp`, package `@george43g/tmux-control-mcp`, single
bin `tmux-control`. The `-mcp` suffix is load-bearing, not taste: the scaffolder
forces it and `ci.yml`'s `--filter "@george43g/*-mcp"` steps silently skip any
other name. **No daemon, no TUI, no HTTP transport, no Rust.** It shells out to
`tmux` with `-F` format strings and parses tab-separated rows.

**Surfaces — four, deliberately.** One CLI subcommand per `ToolDefinition`, as
in browser-tab.

| Surface | MCP annotation | What it does |
|---|---|---|
| `list` / `tmux_list` | read-only | Snapshot: sessions (with `session_group`), windows, panes, clients, as JSON. `fields: "summary"` returns counts only. |
| `run` / `tmux_run` | open-world, NOT read-only | Run one command in a visible pane and return `{paneId, windowId, exitCode, timedOut, durationMs, output, logPath}`. |
| `release` / `tmux_release` | destructive, **scoped** | Kill windows THIS tool created, and nothing else — ownership is proven by a window option the tool set, never by a name match. |
| `doctor` | — | tmux on PATH and ≥ 3.2; server reachable; which session is the drive target and why; `remain-on-exit` and `set-titles` state. |

**`run`, step by step.**

1. **Pick the drive session — never the caller's choice by default.** Read
   `#{session_group}` of the target; the drive session is `<group>-agent`
   (dotfiles' measured rule: deriving from the session NAME invents
   `claude-vos-agent` for a third group member). Missing → create it detached
   and grouped (`new-session -d -t <group> -s <group>-agent`). An ungrouped
   session falls back to itself, and `doctor` says so.
2. **Create the window detached, always.** `new-window -d -P -F …`. There is no
   flag to drop `-d`; the whole point is that the unsafe form is unreachable.
3. **Mark ownership.** `set-option -w @tmux_control_owner <agent>@<host>` plus
   pane title `agent:<agent>/<slug>`, matching the house skill's grammar.
4. **Run the command as the pane process**, wrapped so output goes to a file
   and the exit code survives:
   `bash -c 'set -o pipefail; ( <cmd> ) 2>&1 | tee <log>; s=$?; tmux wait-for -S <chan>; exit $s'`.
   Input is an **argv array** (exec'd with no shell of ours) or a `script`
   string written to a temp file and run by path — so no quoting layer exists
   to get wrong. `remain-on-exit` is set **per window**, never globally.
5. **Wait on the channel** with a timeout (default 120s,
   `TMUX_CONTROL_RUN_TIMEOUT_MS`). On timeout: kill the pane's process group,
   report `timedOut: true`. Honours `AbortSignal`.
6. **Read the result from the file and `#{pane_dead_status}`**, never the
   screen. Output is `sanitize()`d, capped (`TMUX_CONTROL_OUTPUT_MAX`, tail
   kept), and `wrapUntrusted()` at the tool boundary.
7. **Leave the dead window for George** unless `release: true`; a finished
   pane he can read is the visibility the tmux rule exists for. Stale owned
   windows are pruned by count (`TMUX_CONTROL_KEEP`, default 10).

**Security — stated plainly because it is the design.** `tmux_run` executes
arbitrary commands. That is its purpose, and in Claude Code it grants nothing
Bash does not already; in another MCP host it IS a command-execution tool and
is annotated and described as one. It never interpolates caller text into a
shell string of its own, it is never registered `readOnlyHint`, and
`pr-review-sop`'s shell-exec row gets a recorded exception naming this file.
Interactive programs are out of scope for `run`; a `send-keys` verb is NOT in
v1, because shipping the unsafe path beside the safe one is how agents end up
back on it (the rejected MCP's own history, §2).

**Deferred, each with its trigger.** Journal + control-mode reader — when a
real "what was I doing" need appears (that is also the only thing that would
justify a daemon). The wm-stack join — when the wm-stack rewire starts; §3.6
says how. `control-language` binding over linked windows and session groups —
the architecture doc's Phase 4, still gated. Layouts — never here (§2).

## 5. The monorepo test — what passing means

George set the stakes, so the criteria are written before the experiment:

- **P1.** `mcp-scaffold add-mcp-app` produces a buildable app here, or its
  failures are fixable upstream in `mcp-cli-starter-template` (brief + bump,
  per the kit rule) rather than by forking generated code.
- **P2.** browser-tab's suite and e2e stay green with **zero edits under
  `apps/browser-tab-mcp/src/`**.
- **P3.** Every guard that would go SILENT for a second app is made loud. This
  is the real risk: six contract tests enumerate surfaces from browser-tab's
  `makeAppRegistry()`, so a tmux tool gets zero rows and nothing turns red.
- **P4.** A tmux-only merge does not restart the browser daemon or sideload
  Safari, and a flaky tmux test cannot redden browser-tab's release.
- **P5.** The lift list stays the size measured below. If Phase 1 keeps
  discovering single-app assumptions, that growth IS the result.

**Fail = any of P1–P4 needs a redesign rather than a lift.** Then the honest
outcome is a separate repo from the starter template, and this plan's §4 moves
there unchanged — the design does not depend on the monorepo; only
`control-language` sharing does, and v1 does not use it. Worth saying now: the
shared value is thinner than the workspace diagram suggests. Of nine packages
only `mcp-kit`, `control-language` and `env-loader` are substantive and
neutral; `shared-types` and `test-kit` carry neutral names over browser
payloads. The monorepo buys shared semantics and one CI bill, not a shared
runtime.

## 6. Phases

Each phase is its own PR. Phases 0–1 are specified to the file; 2–3 to the
interface, because their code is written against a skeleton Phase 0 has not
generated yet — pre-writing it would be fiction.

### Phase 0 — the scaffold experiment (go/no-go, throwaway)

`add-mcp-app` has **no dry-run** and runs with `force: true`, and it appends to
`.mcp.json`, which `mcpsync` owns here. So it runs in a disposable worktree.

- [ ] `git worktree add ../browser-tab-mcp-wt/tmux-scaffold -b exp/tmux-scaffold main`
- [ ] In it: `mcp-scaffold add-mcp-app tmux-control --target . --no-tui --no-http --no-rust-accel`
- [ ] Record every file created or modified (`git status --porcelain`), and
      each modification to an EXISTING file verbatim — especially `.mcp.json`,
      `turbo.json`, root `package.json`, `release-please-config.json`.
- [ ] `pnpm install && pnpm verify`. Record each failure against the table in
      Phase 1: predicted (a known lift) or new (a P5 data point).
- [ ] Decide against §5. Write the result into this file's STATUS line and
      delete the worktree. Nothing from it merges; Phase 2 re-runs the
      scaffold on a real branch with the lifts already in place.

### Phase 1 — make the repo admit a second app (no tmux code yet)

Measured single-app assumptions, from the 2026-09-20 audit. Silent ones first.

| Area | Evidence | Lift | If missed |
|---|---|---|---|
| Surface ledger | `tests/surface-coverage.contract.test.ts` reads `makeAppRegistry()` + a ledger whose rows have no app field | add `app` to `docs/surfaces/effect-coverage.json`; enumerate registries per app | **SILENT** — tmux ships uncovered; `doctor`/`mcp` names collide |
| Parity / annotations / log branding | `interface-parity`, `tool-annotations`, `cli-log-branding` (`BRANDED_BUCKET="browser-tab-cli"`) | parameterise by app or copy per app | **SILENT** — incl. B11's shared `$TMPDIR/mcp/` bucket recurring |
| Post-merge deploy | `.githooks/post-merge` fires on any `apps\|packages\|scripts` path; `deploy-local.mjs` hard-codes browser-tab's cli | scope the hook to browser-tab's inputs | a tmux-only merge restarts the daemon and sideloads Safari (P4) |
| readme-check | any `src/**` change is satisfied by any `README.md` | already BACKLOG **B27** — do it here | gate becomes decorative across apps |
| Rust drift | `shared-types/tests/drift.test.ts` hard-codes one crate | none now (no Rust) — note only | silent if tmux ever adds a crate |
| Version contract | `release-versions.contract.test.ts` fails on any unowned non-`0.0.0` version | one `extra-files` entry + a `biome.json` `!` row | RED on first `pnpm test` — correct, loud |
| e2e guard | `e2e/run-guard.ts` reads the shared ledger | scope by `app` | RED wrongly if tmux claims a chromium tier |
| Docs integrity | root README `## Tools` vs the registry | per-app README; root lists apps | RED if tmux tools land in the root table |
| turbo env | `turbo.json` `globalEnv` lists `BROWSER_TAB_*` only | append `TMUX_CONTROL_*` | stale cache replays |
| usage artifacts | `check-usage-freshness.mjs` is generic; mise tasks hard-code the bin | per-app `.usage.kdl` + generated dirs | tmux CLI drift unchecked |
| Release | one line rooted at `"."` | **stay on one line.** A second line silently disables `verify-release.mjs` (it reads `manifest["."]`) | — |

- [ ] One PR, lifts only, browser-tab behaviour unchanged. Each silent row
      gets a test proving it is now loud: register a fake second app in the
      test and assert the guard goes red without its ledger row.

### Phase 2 — skeleton: `list`, `doctor`, `mcp`

- [ ] Re-run the scaffold on a real branch; strip to the four-surface shape.
- [ ] `src/tmux/exec.ts` — the ONLY place that spawns `tmux`. argv array, never
      a shell string; `TMUX_CONTROL_TMUX_BIN` and `TMUX_CONTROL_SOCKET` so every
      test drives a private `-L` server.
- [ ] `src/tmux/snapshot.ts` — `-F` rows, tab-separated, Zod-parsed. Fixtures
      are the §3 outputs verbatim.
- [ ] Platform rule, as browser-tab: no `tmux` on PATH (every Windows leg) →
      degrade explicitly with a sentence naming the fix; never crash, and
      tests skip WITH a reason rather than pass vacuously.
- [ ] New effect tier `tmux-private-server`: the built bin against a real
      throwaway tmux server. Ubuntu needs `apt-get install tmux` in CI.

### Phase 3 — `run` and `release`

- [ ] Integration tests against a private server, one per §3 measurement: exit
      codes 0/7/3; a command containing `{}`, `"`, `#`, `&` and a newline;
      first-line output survives (the scroll bug as a regression test);
      timeout kills the process group; `release` refuses a window it does not
      own (the control) and removes one it does.
- [ ] The focus invariant as a test: a second client attached to the human
      session must report the same `#{window_index}` before and after `run`.
- [ ] Point `use-tmux-terminals` at `tmux-control run` for non-interactive
      commands — a NOTE to dotfiles, who own the skill.

## 7. Assumptions George can overturn

Made so the plan could be written; each is a one-line change.

1. Name `tmux-control` (the architecture doc's word) with the forced `-mcp`
   directory suffix.
2. One release line — tmux-control rides the repo's version.
3. `run` leaves finished windows for inspection by default.
4. No `send-keys` verb in v1.
