# tmux-control — the second application, and the reuse it has to prove

> **STATUS 2026-09-24 — APPROVED by George; Phase 0 may start.** D7 is
> answered: window placement is wm-stack's, and this monorepo stops at the OS
> window boundary (§11). Phase 8 is withdrawn.
>
> *Earlier status, kept for the record —* **2026-09-22 — PROPOSED; all six decisions answered by George.** Two
> corrections so far: the 2026-09-21 revision replaced the first draft's premise
> (the test is structural reuse, not a second scaffold), and George's D5 answer
> replaced the managed command runner with a thin layer that mirrors tmux, with
> window lifecycle left to the agent (§5). Later the same day George added a
> north-star scenario (§1a). It changes what the milestone and the §5 surface
> must support, adds three later phases and raises one decision (D7); it changes
> none of D1–D6. Nothing is built, and this plan approves no implementation, no
> Phase 0 run and no merge.

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

George's earlier choice of **agent-safe driving** as the v1 lead stands, in the
shape §5 gives it. It is part of the tmux application library, not a substitute
for the library consuming the shared core. §6 sequences the two (decided, D2).

## 1a. The north-star scenario (George, 2026-09-22)

A user story, given to test the plan's direction through every layer. George, by
voice to his chief-of-staff agent, on the laptop or over the phone:

> "create a tmux session with all my claude agents as windows with claude on the
> left pane and yazi in that directory in the right pane, and have group of
> windows related to project X shown in a kitty terminal visible on monitor 1,
> and have another group related to some other project Y, visible as a session
> with those windows lined up on monitor 3"

Afterwards he calls the Twilio number, which wakes his executive agent:
*"presentation is done, you can detach now"*. The agent then detaches from the
tmux server and closes every kitty window opened for the presentation. His
framing: *"it might be too soon to start building the kitty integration layer,
but this is a sort of 'user story' that builds a picture."* It sets a direction.
It adds nothing to the build before §6's sequence completes; it changes what
that sequence must support and what comes after it.

Drilled through the layers it touches:

| Layer | What the story needs | What exists or was measured | Where it lives | When |
|---|---|---|---|---|
| Voice, phone, agents | an intent spoken to one agent and finished later by another | the chief-of-staff and executive sessions; Twilio | outside this repo | — |
| Window manager (yabai) | put an OS window on display 1 or 3 | wm-stack is already building agent-facing placement | **wm-stack, not this repo** (D7, §11) | — |
| Terminal emulator (kitty) | open, identify and close kitty OS windows, and control everything inside them (tabs, kitty windows); report each OS window's identity so wm-stack can place it | kitty runs `--single-instance` with remote control off; yabai's title for a kitty window is tmux's `set-titles-string` output | a terminal-emulator library, later | Phase 7 |
| Shell (zsh) | nothing new: the shell lives inside a pane | `send` pastes, because keystrokes fail against autopair (§5) | tmux library | Phase 5 |
| tmux: server and clients | a server that is running; clients created on demand, one kind for programs and one for George to see | a presentation client resizes shared windows unless it attaches with `-f ignore-size` (§5.3) | tmux library | Phase 5 |
| tmux: sessions, windows, panes | a session whose windows are the agents' windows; a claude/yazi split in each | a session of links shows the live agent windows; a split made through it also appears in `claude`; killing that session leaves every agent running (§5.3) | tmux library | M3–M4, Phase 5 |
| Selection | "all my claude agents", "windows related to project X" | on George's server, the 12 agent panes report `claude` as their current command, and each pane's path is its repo (M2) | shared core + tmux binding | M2–M3 |
| CLI tools | claude and yazi running in panes | George already builds claude + yazi layouts by hand (`~/dotfiles/scripts/tmux-claude-layout.sh`; five yazi panes today) | tmux library (`run`, spawn with a command) | Phase 5 |

Three parts of the story cut across layers, and each changes the plan now:

1. **One intent, several applications.** tmux and kitty each get their own
   library here, and placement is wm-stack's (D7), but the story is one
   operation. The session must exist before a kitty window attaches to it, and
   the kitty window must exist — and be reported by identity — before wm-stack
   can place it. Across tmux and kitty that needs one preview, one apply, one
   verify and one teardown; the handoff to wm-stack is an identity, exactly as
   browser-tab hands over `cgWindowId`. §2 says not to extract a shared plan envelope until two domains prove
   the need, and this story is where that proof will come from, so §2 now
   states the trigger.
2. **The operation outlives the agent that started it.** The chief of staff
   builds the presentation and the executive takes it down, in another session
   and possibly days later. What was created must be recorded by the tool,
   durably and by name, not held in one agent's context (§5.2).
3. **Teardown must be exact.** "Detach" undoes what the operation created —
   clients, the presentation session, the kitty windows it opened — and nothing
   else. It never touches an agent's window or a kitty window George opened
   himself.

"Lined up on monitor 3" has two readings: one kitty window showing a session
whose windows are in order, or several kitty windows tiled side by side. It is
recorded rather than guessed, and settled when Phase 9 is specified.

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

**The trigger for extraction, stated 2026-09-22:** the first operation that
spans applications (§1a, Phase 9). A plan that orders steps across tmux and
kitty needs one envelope — plan, preconditions, staleness, apply, verify,
teardown. Otherwise each library invents its own and the cross-application
layer has to reconcile them. Extraction is scheduled there and measured against
the two planners that exist by then. The **operation journal** is the likeliest
first piece. browser-tab already has one: `OperationStore` in
`apps/browser-tab-mcp/src/daemon/operations.ts` records each executed mutation
with its per-effect outcomes and an undo record, persisted as rotated NDJSON.
§5.2 is the second consumer.

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
| 2, later | a terminal-emulator library (kitty first) | open, identify and close kitty OS windows, and control what is inside them: tabs and kitty windows, created, closed, reordered, moved. Reports each OS window's identity; never places it. Not approved (Phase 7). |
| — | ~~a window-manager library (yabai)~~ | **Withdrawn by D7 (2026-09-24).** Placement belongs to wm-stack. |

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

The field catalog is chosen for real selections, measured on George's server on
2026-09-22 (read-only): `command` (`#{pane_current_command}`; his 12 agent
panes report `claude`), `path` (`#{pane_current_path}`; each is the agent's
repo), a derived `project` (the repo that path belongs to), window `name` and
pane `title`. "All my claude agents" is `where command == claude`; "windows
related to project X" is `where project == X`.

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

**The scenario's first sentence is M3's acceptance case.** "A session with all
my claude agents as windows" is a session made of links to windows that already
live in `claude`, and "claude on the left, yazi on the right" is a split applied
within each. Measured 2026-09-22 on a private server: splitting a window reached
through the presentation session added the pane to the same window in `claude`
(`%1 %4` in both). The preview has to say so in plain words: *this also changes
window @N as George sees it in session `claude`*. That is the object-versus-
occurrence question with a consequence George can see, and M3 does not pass
while the preview can hide it.

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

## 5. The API surface — a thin layer that mirrors tmux

George, 2026-09-22, answering D5: *"this software tool is a thin wrapper around
tmux to make it EASIER for agents to move panes, windows, sessions etc...
around and re-arrange them, rename them, resize them, connect them in all kinds
of creative ways, display them on various monitors … with window history etc...
command history, the ability to get snapshots just like the browser mcp … the
API surface should somewhat mirror tmux own api surface."* On what happens to a
window after a command: *"should also be up to the agent in that situation it
will decide for itself."*

That is the third correction to this plan. The 2026-09-20 and 09-21 drafts
built a managed runner that owned each window's lifecycle, with ownership marks,
retention and pruning, and then asked George to choose a lifecycle policy. There
is no policy to choose. The tool exposes tmux's own options and verbs and the
caller decides. **The retention and pruning rules are withdrawn.** Where the
mismatch came from: the analysis George pasted on 2026-09-20 argued for a skill
over the plain CLI, with a program only for four things, and the first draft took
that literally ("this app does not re-wrap the tmux CLI"). The 09-21 revision did
not fix that framing.

What "mirror tmux" means here:

- **Structured reads.** A snapshot of sessions, windows, panes and clients: ids,
  names, sizes, layouts, current commands, with a summary projection. It is the
  tmux counterpart of browser-tab's `list_tabs`. Names read back exactly as set.
- **Verbs, one-to-one with tmux.** Rename a session, window or pane title;
  move, join, break and swap panes; move, link, unlink and swap windows; resize;
  `select-layout`, with the `#{window_layout}` round trip; create and kill
  sessions, windows and panes; respawn. Every verb that would change what a
  client shows takes `-d` by default. That is the one safety default kept,
  because the measured failure was an agent moving George's screen onto its job.
- **A few MCP tools, not one per verb.** The rejected `bnomei/tmux-mcp` shipped
  57 tools, a standing context tax. browser-tab groups its tab verbs under
  `tab_action`, and tmux verbs are grouped the same way, by object
  (`tmux_session`, `tmux_window`, `tmux_pane`) with a verb enum. The CLI can use
  tmux's own command names.
- **History.** Window and command history as a journal that can be queried
  (§5.1).

**Sending input is the one place a literal mirror breaks.** Measured
2026-09-22 against George's real zsh on a private server, sending
`{ echo A; echo B; } | cat`:

| method | what zsh received | result |
|---|---|---|
| `send-keys` (keystrokes) | `{ … } \| cat }`: autopair appended a `}` | parse error, no output |
| `send-keys -l` (literal) | `{ … } \| cat }`: same | parse error, no output |
| `load-buffer` + `paste-buffer -p` (bracketed paste) | exactly what was sent | correct output |

So `send` is a paste, not keystrokes. It uses the same tmux machinery with a
safe default. Raw `send-keys` stays for what keystrokes are for: `C-c`, arrows,
`Enter`, and driving a TUI or REPL.

**One fact the agent needs, which is not a policy.** tmux tracks processes, not
shell commands, so tmux has no exit code to report for a command typed into a
shell. It can tell busy from idle: `#{pane_current_command}` read `sleep` while a
typed `sleep 1.5` ran, and `zsh` afterwards. When an agent needs the exit code
and output as data, it can run the command as the pane's own process instead,
and tmux then reports `#{pane_dead_status}`. `run` is that composition. It is
offered as an option the agent chooses, `remain-on-exit` is a parameter
mirroring tmux's own option, and what happens to the window afterwards is the
agent's call.

**Security.** `send`, `run` and `respawn` execute arbitrary commands. In Claude
Code that grants nothing Bash does not. In another MCP host this is a
command-execution tool, and it is annotated as one. The tool never interpolates
caller text into a shell string of its own.

### 5.1 History through a tmux plugin, with no daemon

George raised a tmux plugin as an alternative to a wrapper. Measured on a
private server: `set-hook -g after-select-window 'run-shell …'` journaled both
focus changes with no daemon running, and a global hook applies to every session
on the server. A plugin is therefore the right home for the **history** half:
hooks append to an NDJSON journal, and the library reads it. That also keeps to
the architecture document's "no daemon first".

A plugin does not replace the wrapper. It gives agents no control channel, so
they still need the library's verbs and reads. The design is plugin plus thin
wrapper, not either/or.

### 5.2 Operations that outlive the agent that started them

In the scenario one agent builds the presentation and another, woken later by a
phone call, takes it down. So every multi-step operation gets a name and a
durable record of what it **created** (sessions, links, clients, and later OS
windows), what it only **borrowed** (the agents' windows), and when. The tool
keeps that record on disk. It can be listed ("open presentations") and read by
any agent session. Teardown by name reverses exactly what was created and
refuses to touch what was borrowed. Measured: killing a session made of links
unlinked the windows and left every agent process running in `claude`. This is
the same shape as browser-tab's operation journal (§2), which makes tmux its
second consumer.

### 5.3 Servers and clients

- **The server.** The library can make sure a tmux server is running, rather
  than assume one is.
- **Two kinds of client.** A *control client* (`tmux -C`) needs no terminal; it
  is how a program attaches. A *presentation client* is what George sees, and it
  needs a terminal to live in, which is the terminal-emulator layer's job
  (§1a). Spawning a client for a program is Phase 5; spawning one for George is
  Phase 7.
- **A shared window has one size.** Measured on a private server with a
  full-size client attached to `claude`, standing in for George, and a smaller
  presentation client attached to a session of links to the same window.
  Without a flag the shared window shrank from 200×50 to 80×20. In an earlier
  run with no other client present it stayed 80×20 after the presentation client
  left. George's server uses `window-size latest`, the default, so this is what
  would happen to his agent windows. With `-f ignore-size` on the presentation
  client, the window stayed 200×50. So presentation clients attach with
  `-f ignore-size` by default: an agent's presentation never resizes the windows
  George is working in, the same principle as `-d` for focus. The cost is that
  the presentation shows those windows at George's size. The agent can override
  the default, and the preview says whose size will win.

## 6. Sequencing (decided, D2)

George, 2026-09-21: the reuse proof comes first, as far as the identity answer.
Order: **M1 → scaffold + lifts → skeleton + M2 → M3 → the §5 surface (verbs,
reads, `send`, `run`, the history plugin) → M4 → M5.** The identity experiment
is the step that could change the shared core itself. Everything after it sits
on its answer, including how the §5 surface models sessions and windows.

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

## 8. Two races in the `run` composition — measured and fixed

Both races apply only to `run` (§5), the optional composition in which the
command is the pane's own process. They do not apply to `send`.

**Completion ordering — reproduced.** With the wrapper signalling then exiting
0.7s later, the caller read `#{pane_dead}/#{pane_dead_status}` = `0/` (not
dead, no status) immediately after the signal and `1/5` a second later.
**Fix:** the wrapper writes the exit code to a status file (write temp, rename)
**before** it signals. The status file is the authoritative result from the
moment the channel fires; measured: file read `5` while `#{pane_dead}` was
still `0`. `#{pane_dead_status}` becomes a cross-check, not the source. The
delayed-exit-after-notification case is a regression test.

**Keeping a fast command's pane — NOT reproduced, fixed anyway.** When the
agent asks for `remain-on-exit`, the option must be in place before the command
can exit. Setting it per window after `new-window` lost 0 of 8 windows running
`true`. It is still a race by construction; this machine simply wins it.
**Fix:** the wrapper blocks on a *go* channel; the caller sets the window
options, then signals. Measured 8 of 8 retained with the right status. Cost: one extra
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
- **Release isolation — decided: separate release lines (D4, George,
  2026-09-22), against the provisional recommendation.** Phase 1 has to make the
  release tooling safe for more than one package before the second line exists.
  Two guards silently stop checking once `"."` is no longer the only package:
  `scripts/verify-release.mjs` reads `manifest["."]`, and `release.yml`'s outputs
  are un-prefixed. Both are rewritten first, with a test that goes red when a
  package's release is not verified. The browser line is rooted at `"."`, so it
  needs `exclude-paths` for the tmux app and library, or every tmux commit bumps
  browser-tab. **Unknown, and measured in Phase 1 rather than assumed:** how a
  commit to the shared core (`packages/control-language`) bumps both lines.

## 10. Staged verdicts — no single phase decides everything

The first draft let Phase 0 stand in for conditions later phases establish.
Four gates, each judged where its evidence exists:

| Gate | Judged after | Passes when |
|---|---|---|
| A — scaffold feasibility | Phase 0 | `mcp-scaffold add-mcp-app` yields a buildable app, or its failures are fixable upstream in the starter template rather than by forking generated code |
| B — the repo admits a second app | Phase 1 | every guard that would go SILENT is proven loud by a test registering a fake second app; deploy isolation holds; zero edits under `apps/browser-tab-mcp/src/` |
| **C — structural reuse** | **M1–M5** | **the architecture acceptance.** tmux consumes `control-language` without copying it; M1's suite passes for both bindings; the identity question ends with a recorded answer; preview/apply/verify and stale-refusal work on real tmux |
| D — operational | after the §5 surface | the focus invariant holds with a second client attached; `send` survives George's real shell config |

**Lift versus redesign, made assessable.** A *lift* is a config entry, a test
parameterised by app, or a path scoped in a hook. A *redesign* is any change
under `apps/browser-tab-mcp/src/`, or to a shared contract's meaning. Eleven
lifts are already measured (Phase 1). **Allowance: up to five more** discovered
during Phases 0–1. A sixth, or any redesign, fails Gate B — and the honest
outcome is then a separate repository, which costs Gate C its cheap iteration
on `control-language`: the price George's premise is really about.

## 11. Decisions — all seven answered by George

| # | Decision | George's answer |
|---|---|---|
| D1 | The first operation for M4 | **Gather last panes** (2026-09-21). It is the only candidate whose preview must declare a side effect nobody asked for: the emptied source window disappears. |
| D2 | Order of the runner and the reuse slice | **Reuse proof first, as far as the identity answer** (2026-09-21). See §6. |
| D3 | Name | **`tmux-control`**, with the directory and package keeping `-mcp` for now (2026-09-21). He asked whether the suffix still has to be forced. The starter-template session answered that it is enforced in the scaffolder, in the generated app's name derivation and in CI selection, and recommended making it optional. It will not change the suffix without George. **Recorded as likely to be lifted, not permanent.** If it is lifted, this app is renamed after that release rather than forking generated code. |
| D4 | Release lines | **Separate lines now** (2026-09-22), against the provisional recommendation. The work it requires is in §9 and Phase 1. |
| D5 | What happens to a window after a command | **The agent decides** (2026-09-22). No lifecycle policy, and the retention and pruning rules are withdrawn. This reframed the whole surface (§5). |
| D6 | `send-keys` in v1 | **Answered by D5: sending input is in.** `send` defaults to bracketed paste, because both keystroke modes failed against George's shell (§5). Raw keys are also available. |
| D8 | Gate B (Phase 1) | **Pass, 5 lifts** (2026-09-24). Only lifts to this repo's shared infrastructure count: `withCoverageFloor`, per-app turbo test order, a root `check:usage`, two release-please settings, and a verify-release first-release hole. Defects in the scaffolder's generated app (Windows temp dir, annotation titles, README Tools table) are Gate A's, upstream's to fix or ours by convention. No redesign: nothing under `apps/browser-tab-mcp/src/` changed. |
| D9 | How a shared-core fix reaches tmux-control's version | **Measure a linked fix, then apply** (2026-09-24). Measured in Phase 1: a `control-language` commit bumps browser-tab but not tmux-control. Each shared package gets its own release-please entry so `node-workspace` propagates bumps. It is applied only if measured to work, and must close before tmux-control's first release (`docs/RELEASE.md`). **Re-decided 2026-09-27 (George): wait for upstream.** The gate measured false for every candidate because tmux-control does not use `control-language` yet; the link arrives in Phase 3 through `packages/tmux-control`. #200 stays held (it would release an empty scaffold). Revisit when Phase 3+ gives tmux-control something to release: `additional-paths` (release-please PR #2534) if it has shipped, else choose between own release lines and a CI guard (`docs/RELEASE.md`). |

None of D1–D6 is open. The milestone's next decision comes from M3, as a
measured result: which of the two identity answers the slice needs.

**D7 — ANSWERED 2026-09-24: all of it in wm-stack.** George: *"we want to
control everything \*inside\* the kitty window"*. The seam is the one browser-tab
already keeps: *"once a new browser window is created, our software only cares
about what tabs it moved into it and in what order, at a different layer
(wm-stack and yabai) those apps worry about where the browser window is
visible, what monitor its on"* — *"the same seam / separation of concerns
applies to kitty windows."* wm-stack is already building agent-facing placement
and may later use the selection library; that is not this plan's concern. This
monorepo never calls yabai. It may create and close kitty OS windows, and it
reports their identity so wm-stack can place them.

*The proposal it replaced, kept for the record:*
*Where window-manager actuation lives.* browser-tab's contract says it
deliberately does no yabai actuation ("spaces and visibility are the window
manager's job"), and wm-stack owns yabai's configuration. The scenario needs a
window placed on a monitor. Proposal: the **mechanism** — reading displays,
spaces and windows, and moving a window to a display — becomes a window-manager
application library in this monorepo, reusing `rust-accel`'s display and window
enumeration. The **policy** — rules, keybindings, standing layouts — stays in
wm-stack. browser-tab itself still does no actuation. Cost if this is wrong: a
second yabai control path beside wm-stack's. Before Phase 8 starts, this goes to
the wm-stack session, which owns that boundary.

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
  integrity, `turbo.json` `globalEnv`, usage artifacts. **Two more found
  2026-09-22.** (1) `ci.yml:138,142,145` select apps with
  `pnpm --filter "@george43g/*-mcp"`. The starter-template session measured that
  a filter matching nothing exits 0, so a gate that selects no app passes. It
  shipped a fix upstream (`mcp-cli-starter-template` `52a5386`:
  `scripts/for-each-mcp-app.mjs`, which selects apps by their `mcp-kit`
  dependency and exits 1 on an empty set), and Phase 1 adopts that rather than
  writing one. Its known residue, an app not on `mcp-kit` staying unselected, is
  that repo's DEFERRED #52. (2) The release tooling must handle more than one
  package, for D4 (§9).
- **Phase 2 — M1.** The conformance suite, in `control-language`, no tmux.
- **Phase 3 — skeleton + M2.** `packages/tmux-control` (model, adapter,
  binding) and `apps/tmux-control-mcp` (`list`, `doctor`, `mcp`). No `tmux` on
  PATH — every Windows leg — degrades with a sentence naming the fix, and tests
  skip WITH a reason. New effect tier: the built bin against a real throwaway
  tmux server.
- **Phase 4 — M3**, the identity experiment.
- **Phase 5 — the §5 surface:** structured reads, the tmux-mirroring verbs
  grouped by object, `send` (bracketed paste), raw keys, `run` with §8's fixes,
  and the hook-based history plugin (§5.1).
- **Phase 6 — M4 and M5**, then the three-list report.
- **Phases 7–9 — the scenario's lower layers. Not approved.** Each needs
  George's go-ahead, and none starts before Phase 6 reports.
  - **Phase 7 — terminal emulator (kitty).** Measure first: can a window be
    opened with `kitty --single-instance` running `tmux attach`, identified by a
    title token, and closed by detaching its client so the child exits, all
    without kitty remote control? Turning remote control on is a change to
    George's kitty config, which dotfiles owns.
  - ~~**Phase 8 — window manager (yabai).**~~ **Withdrawn by D7.** Placement
    is wm-stack's; the kitty library's output to it is an OS window identity.
  - **Phase 9 — the scenario end to end,** as one named operation across tmux
    and kitty, with placement requested from wm-stack, torn down by a different agent session from the one that
    built it. The shared plan envelope is extracted here (§2).

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
| tmux hooks (`set-hook` + `run-shell`) | built into tmux. Measured journaling focus changes with no daemon; the basis for history (§5.1) |
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

2026-09-22, against George's real zsh config on a private server: `send-keys`
and `send-keys -l` both came out as `{ … } | cat }` with a parse error, while
bracketed paste (`load-buffer` + `paste-buffer -p`) arrived exact and ran ·
`#{pane_current_command}` read `sleep` during and `zsh` after a typed command ·
`set-hook -g after-select-window` + `run-shell` journaled two focus changes with
no daemon.

2026-09-22, for the scenario: on George's server (read-only), 12 panes report
`claude` as their current command with paths at their repo roots, and the server
uses `window-size latest` · on a private server, a session made of links shows
the live windows, a split made through it appears in the original session, and
killing it unlinks the windows and leaves every process alive · with a
full-size client present, a smaller presentation client shrank the shared
window to 80×20; the same client attached with `-f ignore-size` left it at
200×50.
