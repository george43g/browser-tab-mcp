# tmux-control — the second application, and the reuse it has to prove

> **STATUS 2026-09-21 — REVISED after George's review, still PROPOSED.** This
> replaces the 2026-09-20 draft, whose central premise George corrected.
> Nothing is built; this revision approves no implementation, no Phase 0 run
> and no merge. Six decisions in §11 are open and are George's.

## 1. The objective, as George corrected it

The 2026-09-20 draft treated "a second app scaffolds here and runs commands
safely" as the test. George, reviewing it 2026-09-21:

> The reason for adding tmux to this monorepo is to develop and test a reusable
> foundation for deeper application control. Browsers and tmux are the first
> applications; terminal emulators and other programs or controllable endpoints
> may follow.

The goal is to make it easier for humans and AI agents to assist each other in
controlling a computer, through consistent ways to **inspect state, select
objects, preview changes, execute operations, and verify their effects**. His
words for the architecture: *"We centralize the core logic."* The layering he
confirmed:

1. **Shared core** — selection, ordering, validation, and whatever planning and
   execution mechanisms can genuinely share a contract. A fix there benefits
   every application.
2. **Application libraries** — browser, tmux, terminal, and later families.
   Each defines its objects, capabilities, operations, constraints and
   semantics.
3. **Endpoint adapters** — translate those operations into browser APIs, tmux
   commands, or another endpoint's mechanism.
4. **User and agent surfaces** — CLI, MCP, any eventual human interface. They
   consume the libraries; none reinvents behaviour.

That browser movement and tmux movement differ is already accounted for by
layers 2 and 3. It is a reason to locate the shared and the specific parts
correctly, not a reason to postpone reuse.

### What the first draft got wrong

- **It deferred the `control-language` binding and said v1 does not use it** —
  which removed the only thing the monorepo is for. A separate repo could have
  hosted everything that draft proposed to build.
- **"Layouts never here"** was inferred from tmuxinator and sesh being
  installed. Installed is not fit (§7).
- **P4 promised a tmux test failure could not block a browser release** while
  keeping one release line and one workspace-wide suite. Incoherent (§9).
- **The runner signalled completion before exiting**, then read the dead pane's
  status. A race; reproduced and fixed by measurement (§8).

George's earlier choice of **agent-safe driving** as the v1 lead stands. It is
one operation of the tmux application library, not a substitute for the library
consuming the shared core. §6 sequences the two; the order is decision D2.

## 2. What exists — rechecked against the tree, 2026-09-21

Every line below was read on `main` (`e6820aa`), not taken from the review.

### Reused UNCHANGED by a tmux binding

`packages/control-language` is genuinely application-free: its only runtime
dependency is `zod`, no file under `packages/*/src` imports an app, and nothing
stands between it and a `workspace:*` consumer. A tmux binding reuses as-is the
17-node selector AST and its Zod schema, signed positions, same-kind set
algebra, typed predicates, complexity limits (`DEFAULT_LIMITS`), semantic
validation (`validateSelector`/`assertValid`), the `E_*` error codes, and
`resolveSelector`. **13 of the 17 node kinds** — `ids scope members positions
where union intersect subtract complement sort slice withinEach flatten` — need
only `scopes`/`relations`/`orderedMembers`/`readField`, all natural for
session → window → pane.

The seam is clean in practice: the browser binding
(`apps/browser-tab-mcp/src/select/browser-domain.ts`) is 425 lines with three
imports and no I/O. A tmux binding of comparable size is a real second
consumer of `SelectionDomain<Ref>` (`packages/control-language/src/domain.ts`).

### Needs a MEASURED core extension — and this is the finding

**The shared core declares an occurrence model and its algorithm contradicts
it.** `ResolvedOccurrence` carries `occurrenceId`, `projectionId` and
`branchPath`, and `domain.ts` names the case they exist for: *"a tmux window
linked into two sessions"*. But:

- The resolver deduplicates by `stableKey`, not by occurrence
  (`resolve.ts:80-89`, `appendUnique`; `branchOf` is keyed by stable key). A
  `withinEach` over two sessions that share a linked window emits that window
  **once**, tagged with the first session, and drops the second provenance.
- `occurrenceId` and `projectionId` are written in exactly one place
  (`resolve.ts:468-469`) and **read nowhere** in `apps/` or `packages/`.
  `projectionId` is the constant `"primary"`.
- `parentOf` and `siblingsOf` are single-valued (`domain.ts`), and four node
  kinds depend on them — `offset`, `expand`, `between`, `siblings`
  (`resolve.ts:218,241,267-279,293`).
- The browser consumer keeps only `.entity` and `.key` and discards the
  occurrence (`apps/browser-tab-mcp/src/daemon/select.ts:92-93`). The fixture
  is a strict forest, so no test exercises the distinction.

Measured from the tmux side the same day (private server, tmux 3.7b): one
linked window is **one** `#{window_id}` and **one** `#{pane_id}` (same pid)
appearing at `human:19`, `human-agent:19` and `other:1`. In a session group
every window is linked. `#{window_index}` and `#{window_active}` belong to the
**slot** (session + index); name, layout and panes belong to the **window**.
So a linked window has two sibling sequences with different indices, and a
binding written against today's interface must silently pick one.

The architecture document commissioned exactly this test — *"Exercise linked
windows and session groups specifically to challenge the selection
abstraction"* — and the identity model is, precisely, **present but unproven,
and in one place refuted**. That is what tmux is here to settle.

**There is also no way to check that a binding is correct.** All three core test
files pin `const d = makeSyntheticDomain()` at module scope; nothing is
parameterised over a `SelectionDomain`, although `fixture.ts` says a second
domain's conformance tests should reuse it. Without that, "tmux reuses the
engine" means only "it compiles".

### Stays application-specific

The effect IR, the risk table, preconditions' content, and the executor.
`effects.ts:1-6` says so deliberately (*"tmux/terminal domains get their own
effects when they exist"*); `ACT_VERB_RISK` has no tmux analogue. Is
`break-pane` additive? Is `kill-pane` destructive with no undo? Those are
tmux's to author.

The planner is the honest middle. Of `planner.ts`'s ~420 lines roughly 20 are
already neutral, ~200 are neutral in shape but browser-typed, ~120 are
irreducibly browser (counts derived from line ranges, not tooled). What could
ever be shared is an envelope: a plan store, an equality-only staleness token,
a risk gate, an abort/verify skeleton. **This plan does NOT extract it first.**
The architecture document's rule is *"Effects remain domain-specific until two
domains prove reuse"* and *"use a common plan envelope only after it proves
useful"*; extracting before tmux's risk vocabulary exists would be guessing.
The one hazard of two planners is two divergent staleness contracts, so tmux
writes its token against the SAME written contract — `'<bootId>:<revision>'`,
compared by equality only (`packages/shared-types/src/contract.ts:123-130`) —
pinned by a contract test. Extraction becomes a measured follow-up the moment
both planners exist: that is the second application doing its job.

**Layer 2 does not exist for the browser either.** `packages/browser-control`
was proposed and deferred by ruling R1
(`plans/2026-09-02-selection-dsl-adaptation.md`) *until a second consumer
exists*. tmux is that trigger — but extracting the browser library is a
previously gated choice and is NOT in this plan. It is recorded so the
asymmetry is visible: tmux gets a library from day one; the browser's still
lives inside its app.

## 3. Package boundaries

| Layer | Package | Holds |
|---|---|---|
| 1 shared core | `packages/control-language` (exists) | selection, ordering, validation, resolver. Gains a binding conformance suite (M1) and whatever identity extension M3 measures — nothing speculative. |
| 2 application library | `packages/tmux-control` (new) | the tmux model (server, session, slot, window, pane, client), the `SelectionDomain` binding, capabilities, tmux effects + risk table, the planner, preconditions, the snapshot token, the safe runner, ownership and retention policy. Pure except where it calls layer 3. |
| 3 endpoint adapter | inside `packages/tmux-control` (`adapter/`) | the ONLY code that spawns `tmux`: argv arrays, `-F` rows in, parsed data out. One adapter does not justify its own package; it gets one when a second endpoint (control mode, a remote server) exists. |
| 4 surfaces | `apps/tmux-control-mcp` (new) | CLI + MCP from one bin, consuming layer 2. No tmux knowledge of its own. |

## 4. The reuse milestone — the first proof

This is the architecture acceptance test. It is a vertical slice, not a tool
catalog, and it introduces no daemon.

**M1 — a binding conformance suite, extracted first.** Export
`runDomainConformance(domain, expectations)` from `control-language` and run
the synthetic fixture and the browser binding through it. This needs no tmux,
it is the first justified extraction (measured absence, §2), and it is what
turns reuse into a checkable claim. The browser binding passing unchanged is
the control.

**M2 — read real tmux structure into an application model and bind it.** The
adapter reads sessions, slots, windows, panes and clients with `-F` format
strings; the binding exposes them to the unchanged resolver. The 13 node kinds
that need no sibling view must pass M1's suite with **no change to
`control-language`**. Fixtures are real `-F` output from a throwaway server.

**M3 — the identity experiment, failing tests first.** Build the linked-window
and session-group cases as tests before deciding anything. Two candidate
answers, chosen by result and not by taste:

- *(i) Model the occurrence as the entity.* The tmux library makes the **slot**
  (`$session:@window`) the entity in ordered views, with the window object as a
  separate kind reached by a relation. Slots have distinct stable keys and
  exactly one parent session, so dedupe and `siblingsOf` stay single-valued and
  the core is reused **unchanged**. Cost: every consumer must know which of the
  two kinds it holds, and effects choose whether they target the slot or the
  window.
- *(ii) Make occurrence identity real in the core.* Dedupe by `occurrenceId`,
  carry `branchPath` properly, let sibling views be projection-parameterised.
  Cost: a core change every binding inherits, and the browser must be shown
  unaffected by M1's suite.

Rule: take (i) if the slice passes with no silent choice anywhere; take (ii)
only for a failure (i) demonstrably cannot express. Either way the four
sibling-dependent node kinds get explicit linked-window tests, and
`occurrenceId`/`projectionId` end M3 either **read by something** or
**removed** — a field written and never read does not survive the experiment.

**M4 — preview, apply and verify ONE rearrangement.** The proposed operation
(decision D1): *gather — move the last pane of each selected window into a
target window.* It was chosen because it exercises everything once: a
meaningful selection (`withinEach` + position −1), an application-specific
effect (`join-pane`), a preservation promise, and a non-obvious side effect.
Measured: `join-pane` kept pane id and pid (`%22`, pid 62739, `@22` → `@23`)
**and the emptied source window ceased to exist** — so the preview must
declare `windowRemoved` effects, or it is lying about what it will do.

- *Preview* returns effects as data, each with explicit preconditions: pane
  exists, target window exists, source ≠ target, and the snapshot token.
- *Apply* refuses a stale plan (M5), executes through the adapter with `-d` on
  every verb that would otherwise select, then **re-reads** and verifies: each
  moved pane reports the target `#{window_id}` with an **unchanged**
  `#{pane_pid}`, and each declared `windowRemoved` is really gone. A mismatch
  is a reported failure, never a silent success.
- *Risk* is classified from the effects by a tmux-authored table — the first
  entries of tmux's own risk vocabulary.

**M5 — detect a human change between preview and apply.** With no daemon the
token is `'<bootId>:<revision>'` where `bootId` is the tmux server's
`#{pid}`+`#{start_time}` and `revision` is a hash of the structural snapshot.
Measured: identical across two reads with no change (the control), different
after one `split-window` (the inversion). Equality only, same contract as the
browser's. The test previews, mutates the server as a human would, applies,
and asserts refusal naming the staleness — then asserts a fresh plan applies.

**What the milestone reports, in three lists:** reused unchanged · measured core
extensions (each with the failing test that justified it) · tmux-specific. Those
lists are the deliverable George asked for, and the input to any later
extraction of a shared plan envelope.

## 5. The safe runner — how it fits

`run` is an operation of the tmux application library (layer 2) exposed through
layer 4, sharing the adapter, the drive-session rule and the ownership policy
with the structural operations. It is not a separate tool beside them.

Why it exists is unchanged from the first draft and measured in one session:
`new-window` without `-d` moved George's screen; zsh autopair appended `}` to a
`{ …; }` group sent by `send-keys` (three panes lost); `capture-pane` returned
nothing twice. The earlier fix attempt, `bnomei/tmux-mcp`, was adopted
fleet-wide and removed 2026-08-30 as "not stable"
(`~/dotfiles/TMUX-MCP-EVALUATION.md`); its verified defects are the
requirements: no forbidden characters, completion as a return value, work
visible to the human, a small tool count.

Mechanics, as corrected in §8: derive the drive session from
`#{session_group}` (never from the name — that invents `claude-vos-agent`);
create the window detached, with no way to omit `-d`; mark ownership with a
window option; run the command **as the pane's process** from an argv array or
a script file, so nothing passes through zsh/ZLE; return
`{paneId, windowId, exitCode, timedOut, durationMs, output, logPath}`. Output
is read from a file, sanitised, capped and wrapped as untrusted.

**Security, stated plainly:** `tmux_run` executes arbitrary commands. In Claude
Code that grants nothing Bash does not; in another MCP host it is a
command-execution tool and is annotated as one. It never interpolates caller
text into a shell string of its own.

## 6. Sequencing (decision D2)

M1 needs no tmux and unblocks everything; `run` and the M2–M5 slice are
independent after the skeleton. Proposed: **M1 → scaffold + lifts → skeleton +
M2 → M3 → `run` → M4 → M5.** The alternative puts `run` directly after the
skeleton, delivering the fleet's daily pain relief sooner at the cost of
answering the architecture question later.

## 7. Existing tools and layouts — reopened

Compared against requirements rather than presence (source read for each;
full table in the PR discussion):

| Requirement | tmuxinator / sesh / tmuxp / smug | tmux's own primitives |
|---|---|---|
| R1 rearrange a LIVE session | none — they emit `new-window`/`split-window` only | **yes**: `join`/`break`/`swap`/`move-pane`, `select-layout` |
| R2 preserve running state | binary: skip entirely if the session exists; cannot merge one missing window into a live session | yes — measured, pid survives `join-pane` |
| R3 preview as a diff against live state | none (`tmuxinator debug` prints a script; `sesh preview` shows pane content) | none — the caller's job |
| R4 reconcile drift to a spec | none; `--append` duplicates | none |
| R5 select a computed subset | none — literal names and indices | relative tokens only (`{last}`) |
| R6 verify and report as data | none — `exec` and forget | none |
| R7 describe live layout as data | partial (`tmuxp freeze` is lossy) | **yes**: `#{window_layout}` is documented as `select-layout`'s input |
| R8 agent-safe, structured output | partial; most attach/switch the human's client by default | `-d` exists; no JSON |

**This is a category difference, not a feature gap.** tmuxinator is a
bootstrapper and sesh is a picker; by their own source none of them controls an
already-live session. **They stay adopted, permanently, for exactly the jobs
George uses them for** (`~/dotfiles/tmuxinator/*.yml`, `sesh/sesh.toml`).
Wrapping tmuxinator to get R1/R4 would mean forking its template, since its
create-only primitives are hard-coded and its has-session branch is
all-or-nothing.

Live control — R1, R3, R4, R5, R6 — is a job none of them does, and George
already needed it: `~/dotfiles/scripts/tmux-claude-layout.sh` reads live pane
counts and conditionally reshapes a window by hand. So "layouts never here" is
withdrawn. Layout operations (`select-layout` with a `#{window_layout}`
round-trip, reconcile-to-spec) are **later operations on the same
preview/apply/verify machinery M4 builds**, not a separate engine and not v1.

## 8. Runner defects found in review — measured and fixed

**Completion ordering — reproduced.** With the wrapper signalling then exiting
0.7s later, the caller read `#{pane_dead}/#{pane_dead_status}` = `0/` (not
dead, no status) immediately after the signal and `1/5` a second later.
**Fix:** the wrapper writes the exit code to a status file (write temp, rename)
**before** it signals. The status file is the authoritative result from the
moment the channel fires; measured: file read `5` while `#{pane_dead}` was
still `0`. `#{pane_dead_status}` becomes a cross-check, not the source. The
delayed-exit-after-notification case is a regression test.

**Retention before a fast exit — NOT reproduced, fixed anyway.** Setting
`remain-on-exit` per window after `new-window` lost 0 of 8 windows running
`true`; it is still a race by construction, merely one this machine wins. **Fix:**
the wrapper blocks on a *go* channel; the caller sets window options, then
signals. Measured 8 of 8 retained with the right status. Cost: one extra
`wait-for` per run.

## 9. Release, test and deploy isolation — made coherent

Facts, measured 2026-09-21: `main` has **no branch protection** and no required
checks; release-please PRs carry **no checks at all**; the release workflow
runs on push to `main`; CI and the pre-push hook run the **whole workspace**
suite. So releases are gated by convention, not mechanism.

- **Deployment isolation — promised.** `.githooks/post-merge` is scoped so a
  tmux-only merge does not restart the browser daemon or sideload Safari.
- **Test attribution — promised.** tmux gets its own CI job, so a red run says
  which application broke. It does not make the other merge-able by magic.
- **Release isolation — NOT promised under one release line.** One line means
  accepting, explicitly: a red tmux test blocks every merge by the same
  convention that gates browser-tab today, and a tmux `feat:` bumps
  browser-tab's version. Real independence is a second release line, costed at
  ~40 lines plus two guards that silently self-disable when `"."` is no longer
  the only package (`scripts/verify-release.mjs` reads `manifest["."]`;
  `release.yml`'s outputs are un-prefixed). That is decision D4.

## 10. Staged verdicts — no single phase decides everything

The first draft let Phase 0 stand in for conditions later phases establish.
Four gates, each judged where its evidence exists:

| Gate | Judged after | Passes when |
|---|---|---|
| A — scaffold feasibility | Phase 0 | `mcp-scaffold add-mcp-app` yields a buildable app, or its failures are fixable upstream in the starter template rather than by forking generated code |
| B — the repo admits a second app | Phase 1 | every guard that would go SILENT is proven loud by a test registering a fake second app; deploy isolation holds; zero edits under `apps/browser-tab-mcp/src/` |
| **C — structural reuse** | **M1–M5** | **the architecture acceptance.** tmux consumes `control-language` without copying it; M1's suite passes for both bindings; the identity question ends with a recorded answer; preview/apply/verify and stale-refusal work on real tmux |
| D — operational | after `run` | the focus invariant holds with a second client attached; retention rules hold |

**Lift versus redesign, made assessable.** A *lift* is a config entry, a test
parameterised by app, or a path scoped in a hook. A *redesign* is any change
under `apps/browser-tab-mcp/src/`, or to a shared contract's meaning. Eleven
lifts are already measured (Phase 1). **Allowance: up to five more** discovered
during Phases 0–1. A sixth, or any redesign, fails Gate B — and the honest
outcome is then a separate repository, which costs Gate C its cheap iteration
on `control-language`: the price George's premise is really about.

## 11. Open decisions — George's, none settled

Reviewer recommendations are labelled as such and are not his approval.

| # | Decision | In plain terms | Provisional recommendation |
|---|---|---|---|
| D1 | The first operation for M4 | which one rearrangement proves preview → apply → verify | *gather last panes* — it forces a declared side effect |
| D2 | Order of `run` vs the reuse slice | daily pain relief first, or the architecture answer first | reuse slice through M3, then `run`, then M4–M5 |
| D3 | Name and directory suffix | what people type, versus what the scaffolder and CI filters require | `tmux-control`; keep the forced `-mcp` suffix on the directory and package |
| D4 | One release line | both apps share version numbers and a release cycle | acceptable at first **only if** the shared gating in §9 is accepted explicitly |
| D5 | Keep finished windows | a completed command's pane stays for inspection | keep, under the rules below |
| D6 | No `send-keys` in v1 | the tool cannot type into an already-running interactive program | reasonable for the first safe runner; rules out nothing structural |

**Retention rules proposed for D5.** A window is prunable only if ALL hold: it
carries this tool's owner option; its pane is dead (`#{pane_dead}` = 1 —
running work is never touched); **no client is looking at it**
(`#{window_active_clients}` = 0, verified present in 3.7b); it is older than a
minimum age; and the owner's kept count is exceeded, oldest first. Explicit
`release` follows the same ownership rule and refuses anything it did not
create.

## 12. Phases

Each is its own PR. None starts without George's go-ahead.

- **Phase 0 — scaffold experiment (Gate A).** Throwaway worktree, because
  `add-mcp-app` has no dry-run, runs with `force: true`, and appends to
  `.mcp.json`, which `mcpsync` owns. Record every created and modified file;
  run `pnpm verify`; classify each failure as a predicted lift or a new one.
  Nothing from it merges.
- **Phase 1 — admit a second app (Gate B).** The measured single-app
  assumptions, silent ones first: the surface ledger has no `app` field and six
  contract tests enumerate browser-tab's registry only; parity, annotation and
  log-branding tests are single-app; the post-merge hook fires a browser deploy
  on any `apps|packages|scripts` change; readme-check accepts any README
  (BACKLOG B27). Loud ones: the version contract, the e2e guard, docs
  integrity, `turbo.json` `globalEnv`, usage artifacts.
- **Phase 2 — M1.** The conformance suite, in `control-language`, no tmux.
- **Phase 3 — skeleton + M2.** `packages/tmux-control` (model, adapter,
  binding) and `apps/tmux-control-mcp` (`list`, `doctor`, `mcp`). No `tmux` on
  PATH — every Windows leg — degrades with a sentence naming the fix, and tests
  skip WITH a reason. New effect tier: the built bin against a real throwaway
  tmux server.
- **Phase 4 — M3**, the identity experiment.
- **Phase 5 — `run` and `release`**, with §8's fixes and §11's retention rules.
- **Phase 6 — M4 and M5**, then the three-list report.

## 13. Existing solutions — the record

Searched 2026-09-20 across npm, GitHub, Homebrew, PyPI, skills.sh and this
fleet.

| Candidate | Finding |
|---|---|
| `bnomei/tmux-mcp` (`tmux-mcp-rs`) | adopted fleet-wide, removed 2026-08-30 as "not stable" (`76fb159`). Verified defects: forbids unquoted `#`, `&`, newlines; completion is a side channel; isolated socket hides work; 57 tools |
| `tmux-python/libtmux-mcp` | the right shape (one-call `run_command`); alpha, no tagged release, adds Python |
| `libtmux/libtmux-ts` + `@libtmux/mcp` | MIT, 0 stars, alpha, 45 tools |
| `k8ika0s/mcp-tmux` | the only one with confirm-gated destructive ops — AGPL-3.0-only |
| `nickgnd/tmux-mcp` | stale since 2026-02; detects completion by prompt-scraping |
| tmuxinator, sesh, tmuxp, smug, teamocil | bootstrappers and pickers — §7 |
| Node `tmux -C` control-mode parsers | none maintained (believed); a later, small write |
| pane → CGWindowID join | nothing exists; in-house prior art only (`correlate.ts`). Measured feasible: yabai's AX title for the kitty window equals tmux's `set-titles-string` output; kitty is `--single-instance`, so pid alone cannot pick a window. Later phase |

None of these addresses the shared-core objective at all — they are tmux
tools, not a second binding of a selection language.

## 14. Measurements, all on a private throwaway server

tmux 3.7b, `tmux -L probe-<pid> -f /dev/null`, never George's server.

2026-09-20: a command run as the pane's process needs no `send-keys` and
carried `{}`, `"`, `#`, `&` untouched · exit codes exact via
`#{pane_dead_status}` (0, 7, 3) · `wait-for` returned 1.03s after a 1s command
· visible `capture-pane` lost the first output line every time because "Pane is
dead" scrolls the screen (`#{history_size}` = 1); `-S -` and file capture kept
everything, the latter with exit codes 9 and 6.

2026-09-21: completion race reproduced, status-file fix verified (§8) ·
retention race not reproduced in 8 trials, go-channel fix 8 of 8 (§8) · linked
window = one `@id`, one `%id`, one pid across three sessions (§2) · `join-pane`
preserved pid and removed the emptied source window (§4) · structural
fingerprint stable across idle reads, changed after `split-window` (§4) ·
`#{window_active_clients}`, `#{window_activity}`, `#{pid}`, `#{start_time}` and
`#{window_layout}` all present · `main` has no branch protection (§9).
