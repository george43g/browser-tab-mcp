# Control-surface roadmap — George's 2026-09-04 idea dump, analysed and triaged

**Status:** Phase 5 is APPROVED and has its own plan
(`2026-09-04-phase-5-act-on-selection.md`). Phases 6–10 are recorded, analysed
and sequenced — **not** approved. Each one needs its own go-ahead.

This document exists because George dumped a large, coherent set of ideas in
one message and asked for exactly this: *"for everything else, tidy it up,
analyse it, flesh it out and triage the features to get built at the
appropriate phase (i dont expect you to build every single thing I just
mentioned in one turn now lol, I just wanted to record my ideas)"*.

## Source — George, 2026-09-04, verbatim

> also - fold in these following features where they belong in the plan - one
> of the actions specific to the browser tab mcp - as well as closing tabs (and
> undo close tabs, reopen closed tabs from history is a native chrome feature,
> the mcp should store a history of closed tabs and their state (each closed
> tabs own history etc.. should also stay in memory for a while). bookmark
> selected tabs. when bookmarking, you can select where to save a bookmark, or
> you can bookmark a selection of tabs or bookmark a whole window into a
> bookmarks folder - thsee are tative features already, we just want a
> structured output language to replicate them. general bookmark CRUD and
> bookmark selection logic - you might want to create several bookmarks from a
> URL input rather than an active tab, even a closed tab should be bookmarkable
> if still in memory. you might save or move a number of bookmarks into a
> bookmark dir thats in the bookmarks bar, so it now displays as a drop down
> menu in your bookmarks bar. Make sure the original features i mentioned -
> like browser-tab cli, TUI, mcp, console etc... haveing access to tile,
> description, page content, screenshot, favicon, AI description, is the page
> muted, how much RAM the page takes up - etc... beware the extension may be
> enabled on incognito windows as well - need to account for and test that edge
> case - tabs cant be moved between incognito windows and normal ones - but yoU
> can cut and paste tabs, and yoU can use bookmarks. You can also move tabs
> between and create new incognito windows as long as they're interacting with
> their own kind (incognito). flesh these control surfaces out. I may have
> mentioned a lot of these before - moving, duplicating, in groups, between
> groups, in and out of groups, and crud for bookmarks, and other cross surface
> features.. we can move a set of tabs, but is that different from moving a
> group or set of groups? groups always refers to the native chroe group
> implementation - every move that applies to tabs should apply to native
> groups, plus actions that duplicate, expand, shrink, delete and create, as
> well as move between windows, destructive move to incognito windows? orWould
> an AI figure that out? and finally - teh DSL requires a structure output that
> has a schema and can be validated - we then must apply or supply this
> structured output gate to LLMs/AI in a way thats compatible with them - cloud
> ones and local ones.

## What already exists — measured 2026-09-04, before any of this is built

Triage is worthless without this column. Several of the asks are **already
shipped** and the work is exposure, not construction.

| Ask | State today | Evidence |
|---|---|---|
| title | ✅ shipped | `TabSchema.title` |
| favicon | ✅ shipped | `TabSchema.favicon`, size-bounded, `data:` dropped over the cap |
| description / og:* / canonical / lang | ✅ shipped | `get_page` mode `metadata`, `apps/chrome-extension/src/extract.ts:73-77` |
| page content | ✅ shipped | `get_page` mode `text` (Readability), mode `state` |
| screenshot | ✅ shipped | `screenshot` tool, both tiers |
| muted / audible / discarded / pinned | ✅ shipped, and **selectable** | `browser-domain.ts:70-87` predicate fields |
| incognito | ✅ shipped as a *predicate* and as a *live-move domain* | `domains.ts:26`, `browser-domain.ts:85` |
| bookmark CRUD (single node) | ✅ shipped | `bookmarks` tool: search/list/create/update/remove, folders via "create with no url", `parentId`, `index` |
| create bookmark from a URL, no tab | ✅ shipped (one at a time) | `bookmarks create {url,title,parentId}` |
| open incognito window | ✅ shipped | `OpenWindowInputSchema.incognito` |
| **act on a selection** | ❌ **the gap** | G1/G2 — see the Phase 5 plan |
| bulk/bookmark-a-selection | ❌ | no selection input on `bookmarks` |
| bookmark MOVE | ❌ | `update` takes title/url only — no `parentId`/`index` |
| closed-tab memory / reopen | ❌ | no store; no `sessions` permission |
| groups as a selectable KIND | ❌ | `groupId` is a tab predicate; there is no group selector |
| AI description | ❌ | nothing derives one |
| RAM per tab | ❌, feasibility **unverified** | see Phase 8 |

## The two design questions George actually asked

### "we can move a set of tabs, but is that different from moving a group or set of groups?"

**Yes, and the language already has the machinery to keep them apart.** In
Chrome's model a tab group is not a container — it is an attribute (`groupId`)
on tabs plus a contiguity invariant the browser enforces: every tab sharing a
groupId must be adjacent. So "move these three groups to window 2" *could* be
desugared to "move the union of their member tabs", but that desugaring is
lossy in two ways: it discards atomicity (Chrome's own `tabGroups.move` moves
the block in one operation; a tab-by-tab relocation produces intermediate
interleavings the browser then repairs, and our LIS-minimal relocation planner
would be optimising the wrong sequence), and it discards identity (the group's
title and colour are properties of a thing that no longer appears in the plan).

The control language is a **same-kind ordered-set algebra** — that is the hook.
Groups should be a second *kind* with their own domain, their own selectors and
their own effects, and the algebra's existing refusal to mix kinds is then the
correct answer to "what happens if I union tabs and groups": it is refused, at
schema time, with a stable code.

### "…orWould an AI figure that out?"

**No — do not rely on it, and we now have the number.** The first keyed eval
baseline (2026-09-04) scored **6/10 semantically correct with 1 accidental
destructive** on the surface as it stands. A model that reaches for `cut_tabs`
when asked to *move* a tab is not a model that will infer an undocumented
tab/group desugaring. Make the kind explicit and let the schema refuse the
mixture; that is cheaper than a description that has to teach the distinction.

## Phases

Each phase is one coherent, shippable slice with its own go-ahead. Ordering is
by dependency first, then by how much of the surface it unlocks.

### Phase 5 — act on a selection · **APPROVED**

The G1/G2 fix, plus the close/undo half of George's message. Full plan in
`2026-09-04-phase-5-act-on-selection.md`. Scope in one line: the language can
say WHICH tabs and WHERE they go; this phase makes it able to say WHAT TO DO to
them, through the same planned, risk-classified, journalled, undoable path.

**Boundary decision, flagged for override:** bookmarking a selection is *not*
in Phase 5, even though George listed it in the same breath as closing. The
line is that Phase 5 acts on tabs that already exist and mutates them in place
or ends their lifecycle; bookmarks create an object in a **different
namespace**, with its own tree, its own ids and its own selectors. Dragging the
tree in would double the phase. Once Phase 5 exists, adding `bookmark` as one
more verb is cheap — which is the argument for the order, not against the
feature.

### Phase 6 — bookmarks as a first-class surface

1. **Bookmark a selection** — `selectionId` input; every member becomes a
   bookmark under one destination folder, in selection order.
2. **Bookmark a whole window** — a window selector, into a *new* folder named
   for the window, created in one call (this is George's "bookmark a whole
   window into a bookmarks folder").
3. **Bookmark a closed tab** — depends on Phase 5's closed-tab store; the
   record already carries url + title, so this is an input-source change.
4. **Bulk create from URL input** — `bookmarks create` takes one node today;
   take a list.
5. **MOVE, which does not exist today** — `update` accepts title/url only, so
   there is no way to reorganise. Needs `parentId` + `index`, which is exactly
   George's "save or move a number of bookmarks into a bookmark dir thats in
   the bookmarks bar". *(The bookmarks-bar dropdown is not a feature to build:
   it is what Chrome renders for any folder whose parent is the bookmarks-bar
   node. Worth one line of docs, no code.)*
6. **A selector language over bookmarks** — the second *kind*: same algebra,
   different domain (tree position rather than strip index; `folder`, `depth`,
   `parent`, `url`, `title`, `dateAdded`). This is the piece that makes
   "bookmark CRUD and bookmark selection logic" one language rather than two.

### Phase 7 — groups as a selectable kind

`kind: "group"` in the control language, with: selectors over group properties
(title, colour, collapsed, size, window); every relocation transform that
applies to tabs (`move`, `setOrder`, `reverse`, `sort`, `pack`); and the
group-specific verbs George named — **create, delete, duplicate, expand,
collapse** ("expand, shrink"), and move between windows. Answers the design
question above by construction.

**Open policy question for George, deliberately not decided here:** a group (or
tab) moved into an incognito window cannot move live — it can only be
reconstructed and the source closed, i.e. a `cut`. George wrote "destructive
move to incognito windows?" with the question mark. There is a second,
sharper direction to decide too: a copy *out of* incognito into a normal window
writes a private URL into normal history and normal session storage. That is a
privacy boundary, not a mechanics problem, and it should be refused by default
with an explicit override rather than silently performed.

### Phase 8 — richer per-tab data, on every surface

Most of George's list is already shipped (see the table above); this phase is
the two that are not, plus making sure the CLI/TUI/REPL actually *render* what
the daemon already knows.

1. **AI description** — a derived, cached-per-`navEpoch` one-line summary.
   Design constraints: it costs money and latency, so it must be opt-in per
   call and never on the snapshot path; it is untrusted-content-derived, so it
   is wrapped; and it belongs in the annotation substrate rather than the
   Snapshot contract (no `version` bump).
2. **RAM per tab — feasibility UNVERIFIED, probe before planning.**
   `chrome.processes` exposes `privateMemory` and per-task `tabId`, which is
   exactly the join needed; what is unconfirmed is whether the API is available
   outside Chrome's Dev channel and what permission it needs. The check is one
   line in the connector (`typeof chrome.processes`) on George's own Chrome,
   and it must run before this is planned, not after. If it is Dev-only, the
   honest answer is that per-tab RAM is not available to an extension on stable
   Chrome and the row says so.

### Phase 9 — incognito, tested rather than assumed

George: *"beware the extension may be enabled on incognito windows as well -
need to account for and test that edge case"*. The modelling is already right
(`ext:<browser>:<normal|incognito>` domains); what is missing is **evidence**.
The manifest declares no `incognito` key, so it takes Chrome's default, and
nothing in the e2e suite runs with the extension allowed in incognito. This
phase: declare the mode deliberately, add an e2e leg that launches with
incognito access granted, and pin the three rules George stated — no live move
across the line, cut/copy works, same-kind incognito↔incognito moves work.

### Phase 10 — the structured-output gate for LLMs, cloud and local

George: *"the DSL requires a structure output that has a schema and can be
validated - we then must apply or supply this structured output gate to
LLMs/AI in a way thats compatible with them - cloud ones and local ones"*.

Cloud tool-calling already gets the schema for free (the MCP `inputSchema` is
Zod → JSON Schema today, and the eval drives real Anthropic tool calls with
it). What is missing is everything else:

- **A published, versioned schema artifact** rather than one synthesised per
  process — so a local runner can consume it without importing the app.
- **The strict-subset problem, which is real and will bite.** Constrained
  decoding modes (OpenAI `response_format: json_schema` strict, and most local
  grammar compilers) reject recursion and require closed objects. The selector
  AST is *recursive by design* — set algebra nests. So this phase must produce
  a **depth-bounded, flattened variant** of the schema alongside the canonical
  one, and a conformance test proving a fixture corpus of selectors round-trips
  through both.
- **Local targets:** a GBNF grammar for llama.cpp and an Ollama `format` blob,
  generated from the same source rather than hand-written.
- Consumers stay inside this monorepo (George, 2026-09-02: the
  `control-language` package is not being published).

## Cross-cutting, not a phase

**B30 — tool descriptions do not steer.** Re-measured against the eval baseline
after *every* phase that adds a verb, because each new verb is a new
opportunity for a model to pick the destructive one. The baseline exists now,
so this is a delta rather than an opinion.
