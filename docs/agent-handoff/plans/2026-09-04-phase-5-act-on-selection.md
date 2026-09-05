# Phase 5 — act on a selection (closes G1/G2), with close, closed-tab memory and reopen

**Approved by George 2026-09-04**, choosing it over the TUI phase, the eval
description work and the tmux spike. Sibling document: the triaged
`2026-09-04-control-surface-roadmap.md`, which holds every idea from the same
message that is NOT in this phase.

## The gap, in one paragraph

The selection language can already say **which** tabs (`select_tabs`: identity,
signed position, predicate — including `muted`, `audible`, `discarded`,
`pinned`, `grouped`, `incognito` — temporal, and set algebra) and **where they
go** (`plan_tab_change` → `apply_tab_layout`, or `copy_tabs`/`cut_tabs` across a
domain boundary). It cannot say **what to do to them**. `tab_action`,
`close_tab` and `focus_tab` each take one raw `tabId`; `group_tabs` takes an id
list but no `selectionId`. So "mute everything playing audio" — a predicate the
language already resolves — is a client-side loop that produces no plan, no
risk class, no operation-journal row and no undo record. The code already
admits the gap: `ActEffect` exists at `src/select/plan/effects.ts:66` with zero
producers anywhere in `src/`.

## Shape — four PRs, dependency-ordered (letters continue the staged tail's)

### PR-M: the `act` transform — verb-aware risk, and the domain guard it must NOT inherit

Add `{ kind: "act", action: <verb> }` to `TransformSchema`
(`src/daemon/plan-change.ts:53`) and a `case "act"` producer in
`planTransform` (`src/select/plan/planner.ts:83`) emitting one `ActEffect` per
member.

Two design points that are the whole PR:

1. **Risk becomes verb-aware.** `classifyRisk` (`effects.ts`) today derives risk
   from effect *kind* alone: anything that closes is destructive, anything that
   creates is additive, everything else is live-layout — and `ActEffect` falls
   into the last bucket. That is right for `pin`/`unpin`/`mute`/`unmute` and
   **wrong** for `discard`/`reload`/`navigate`, which irreversibly lose in-page
   state (it is exactly why `tab_action` carries `destructiveHint: true`). So
   `ActEffect.action` widens, and `classifyRisk` gains a per-verb table. The
   invariant that must survive unchanged: `apply_tab_layout` accepts **only**
   `live-layout` (`daemon/apply.ts:162`), so a `discard` plan is refused there
   and has to go through the destructive door. Pin the table in a test that
   enumerates every verb — a new verb defaulting to live-layout is the failure
   mode.
2. **The cross-domain guard does not apply to acts.** `planTransform` refuses a
   multi-domain selection outright (`cross_domain_live_move`, `planner.ts:107`)
   because *relocation* needs one live-move domain. Muting a selection spanning
   Chrome and Safari needs nothing of the sort. The guard must be scoped to
   relocating transforms, and a test must prove an `act` plan over a
   deliberately multi-domain selection succeeds — otherwise this phase ships a
   language that can select across browsers and refuses to act across them.

Verbs in scope: `pin`, `unpin`, `mute`, `unmute` (live-layout); `discard`,
`reload` (destructive); `group`, `ungroup` (live-layout — group membership is a
tab attribute in Chrome's model, `chrome.tabs.group`/`ungroup`, and the
browser owns the contiguity repair). `navigate` is deliberately **out**: it
takes a per-tab URL, which makes it a different shape from a uniform verb, and
it is the one act that most wants the URL allowlist argument re-made per member.

### PR-N: the destructive executor — `act` verbs that are not live-layout, and `close`

`apply_tab_layout` stays live-layout-only. This PR adds the other door: a
destructive execution path that takes a `destructive`-classed plan and requires
`confirmDestruction: true`, mirroring `cut_tabs`' existing contract rather than
inventing a second one. `close` joins as a transform verb here, not in PR-M,
because it cannot land before PR-O gives it an undo substrate.

Ordering inside the executor is the safety property: for `close`, the
closed-tab record is written **before** the tab is closed and is only committed
once the close is confirmed — the same "verify before you destroy" shape as
`cut_tabs`, which never closes a source whose replacement did not verify.

### PR-O: closed-tab memory — the substrate George asked for

> *"the mcp should store a history of closed tabs and their state (each closed
> tabs own history etc.. should also stay in memory for a while)"*

`src/daemon/closed-tabs.ts`, modelled on `operations.ts` (rotated ndjson + an
in-memory ring, TTL'd). One record per closed tab: browser, url, title,
favicon, index, windowId, groupId (+ the group's title/colour, which die with
the tab), pinned, muted, `closedAt`, the `navEpoch`, and — where the extension
can supply it — the tab's own back/forward entries, which is the part
`open_tab` can never reconstruct.

This is also the answer to gap **G3**: the manifest requests no `sessions`
permission today, so nothing can reach `chrome.sessions.restore` — the one
mechanism that brings a tab back **with its history**. Add the permission and
prefer `sessions.restore` when the tab is still in the browser's own recently-
closed list; fall back to our record (open at the remembered index, re-pin,
re-group) when it has aged out. Report which of the two happened: a restore and
a re-open are not the same thing and the caller should not have to guess.

Retention is a knob with a documented default (`BROWSER_TAB_CLOSED_TAB_TTL_MS`,
and a count cap), because "for a while" is a policy, not a constant.

### PR-P: `reopen`, the ledger, and the surfaces

The `reopen` verb (over closed-tab records, not over live tabs — a different
input kind), the effect-coverage ledger rows for every new surface, the CLI
subcommands + `.usage.kdl` + regenerated artifacts, and an e2e spec per verb
asserting against the browser's own truth (`chrome.tabs.query`), not just the
daemon snapshot.

**Plus zoom (gap G6, George 2026-09-05).** `chrome.tabs.setZoom`/`getZoom`
need no new permission — they are already covered by `tabs`. Zoom is NOT a
uniform verb though: it carries a level, so on the `act` transform it takes a
parameter the way `group` takes a `groupId`, and the level is per-call rather
than per-member. Risk is live-layout (a zoom is trivially reversible and loses
nothing), and `getZoom` makes the BEFORE value recoverable for the
`pre-attributes` undo record — unlike `discard`, this one is genuinely
undoable. It lands as a `tab_action` verb AND an `act` verb, because the single
-tab route is the one a person types.

## Standing gates (every PR)

- `pnpm verify` green; `pnpm stress` on anything touching dispatch/lifecycle.
- A ledger row per new surface, and `surface-coverage.contract.test.ts` will
  fail until it exists.
- `.env.example` updated in the same commit as any new `process.env` read.
- Tool descriptions re-measured against the eval baseline (B30) at the end of
  the phase — every new verb is a fresh chance for a model to pick the
  destructive one, and 6/10 with 1 accidental destructive is the number to beat.

## Risks named

- **The risk table is the safety boundary.** A verb misclassified as
  live-layout becomes reachable through `apply_tab_layout`, which asks for no
  confirmation. The enumerating test is not optional.
- **`chrome.sessions` changes the manifest.** Sideloaded/unpacked installs take
  it silently; a store install would prompt. Note it in the connector README.
- **Group verbs interact with Chrome's contiguity repair.** `chrome.tabs.group`
  moves tabs to make the group contiguous — so a "group these" act can *also*
  reorder the strip. That is the browser's behaviour, not ours; the plan must
  say so and the result must report the actual final arrangement, the way
  `move_tab` already finishes with a `tabs.get` rather than trusting the echo.

## Explicitly NOT in this phase

Bookmarking a selection (Phase 6 — different namespace, own tree, own
selectors), groups as a selectable *kind* (Phase 7 — this phase treats
group membership as a tab attribute, which is what Chrome's model actually
says), AI descriptions and per-tab RAM (Phase 8), incognito e2e coverage
(Phase 9), the constrained-decoding schema artifacts (Phase 10). All recorded
with analysis in the roadmap.
