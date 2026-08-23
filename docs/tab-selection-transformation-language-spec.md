# Tab Selection and Transformation Language

**Canonical planning specification**  
**Status:** Target architecture, suitable as the source brief for implementation plans  
**Revision:** 1.0 — 22 August 2026

## 1. Purpose

This document specifies a common language and execution model for selecting, inspecting, rearranging, copying, and acting on browser tabs. The same model is intended to serve four surfaces:

- the CLI;
- MCP tools;
- the interactive console;
- the TUI.

The core idea is deliberately small: a command combines a **selection**—the ordered tabs or structural nodes to operate on—with a **transformation**—the operation to apply. This mirrors Vim's separation between motions and operators. A small set of composable primitives should express both simple actions and large browser-layout changes without requiring callers to calculate fragile sequences of tab indexes.

This is a normative target specification, not a claim that every feature already exists. Section 18 records the implementation baseline verified while this document was prepared.

## 2. Goals and non-goals

### 2.1 Goals

The language must:

- select one tab, arbitrary tab lists, native groups, windows, browser instances, and combinations of them;
- support identity, absolute position, relative position, predicates, time, recency, and set algebra;
- preserve deterministic selection order;
- apply queries, tab actions, grouping, permutations, movement, and bulk layout transformations to any valid selection;
- move tabs without reload whenever the source and destination share a live-move domain;
- represent cross-browser transfer honestly as reconstructive `copy` or `cut`, never as a state-preserving `move`;
- accept a declarative end state and compute the safe operation sequence internally;
- expose one canonical structured command representation across MCP, CLI, console, and TUI;
- plan against a stable snapshot and report partial failure and actual resulting state;
- remain capability-aware across Chrome, Chromium, Brave, Edge, Safari, profiles, incognito contexts, and extension/adapter pathways.

### 2.2 Non-goals

The core does not:

- promise preservation of DOM, JavaScript, scroll, media, form, navigation-stack, or authentication state across browser boundaries;
- silently search page bodies as part of ordinary title/URL search;
- embed AI reasoning in the daemon;
- make `cgWindowId` or any other operating-system window identifier the persistent logical identity of a browser window;
- pretend that a multi-step browser API mutation is transactional when the browser offers no transaction primitive;
- require a free-form string parser for the first implementation.

## 3. Normative language and terminology

The terms **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

| Term | Meaning |
|---|---|
| Browser universe | All browser sessions visible to the daemon. |
| Browser instance | One addressable browser context, normally a browser product plus profile/session. |
| Live-move domain | The boundary within which a native tab can be reparented without recreation. This is determined by runtime capability, not product name alone. |
| Window | An ordered branch containing tabs. |
| Native group | Browser-managed group metadata over a contiguous run of tabs. |
| Tab | The principal leaf node. |
| Selection | A resolved, ordered set of stable node identities. |
| Selector | A serializable expression that resolves to a selection. |
| Transformation | A query or mutation applied to a resolved selection. |
| Destination | An insertion gap, structural parent, or declarative target. |
| Snapshot | The versioned browser-tree state against which selectors and plans are resolved. |
| Reconstruction | Creating a new tab from transferable descriptors such as URL and selected metadata. Reconstruction reloads the page and creates a new tab identity. |

## 4. The ordered-tree model

The logical model is an ordered forest:

```text
Browser universe
├── Browser instance / profile
│   ├── Window
│   │   ├── Tab
│   │   ├── Native group
│   │   │   ├── Tab
│   │   │   └── Tab
│   │   └── Tab
│   └── Window
│       └── ...
└── Browser instance / profile
    └── ...
```

Native Chrome-family groups are not independent browser containers; they are metadata attached to a contiguous tab span. The logical model MAY expose them as branches, but the executor MUST enforce the browser's true invariants.

### 4.1 Identity

Every persistent logical object SHOULD expose:

- an opaque runtime/native handle where one exists;
- an internal stable identity;
- an automatically generated human-readable slug;
- zero or more user-assigned aliases.

Opaque handles MUST be treated as opaque and passed back verbatim. Callers MUST NOT parse browser, generation, or numeric meaning from them.

A live move does not change a tab's stable identity. Reconstruction does: `copy` creates a new identity, and successful cross-browser `cut` retires the source identity after creating its replacement. Results MUST return an explicit source-to-created identity map and SHOULD preserve a provenance link.

Window slugs and aliases survive ordinary window movement and resizing. Operating-system identifiers such as `cgWindowId` are transient correlation data, not logical identity.

### 4.2 Group interpretation

A group selector MUST state or inherit one of two interpretations:

- `members`: expand the group to its ordered tabs;
- `node`: treat the group as an indivisible structural unit for metadata or block operations.

`members` is the default for tab transformations. `node` is required when renaming, recolouring, or explicitly moving/swapping a group as one block.

## 5. Signed positional semantics

Signed scalars remove the need for separate primitive vocabulary such as `left`, `right`, `from-start`, and `from-end`.

### 5.1 Absolute element positions

Absolute element positions are **one-based**:

- `1` is the first element;
- `2` is the second element;
- `-1` is the last element;
- `-2` is the second-last element;
- `0` is invalid;
- positive values count from the beginning;
- negative values count from the end.

By default, an out-of-range absolute position clamps to the nearest boundary. In a five-tab window, `100` resolves to position `5`, while `-100` resolves to position `1`. A caller MAY request `bounds: "error"` when clamping would hide a mistake.

Absolute positions never wrap. The earlier phrase “negative numbers wrap around” is normalized here to “negative values count from the end”; this is consistent with `-1` meaning the final element and with boundary clamping.

### 5.2 Relative offsets

Relative offsets are zero-based displacements from an anchor:

- `0` is the anchor;
- `1` is the next element in the applicable order;
- `-1` is the previous element;
- larger magnitudes continue in the same direction.

Out-of-range relative selections clip by default. They do not wrap unless an operation explicitly requests a cyclic transformation such as `rotate`.

### 5.3 Ranges

Ranges are inclusive and preserve direction:

```text
1..5       first through fifth
3..-1      third through last
1..-2      all except the last
-5..-1     fifth-last through last
-1..1      last through first, in reverse order
```

A descending range is not normalized to ascending order; its direction is part of the resulting selection order.

### 5.4 Insertion slots

Destinations address **gaps**, not tabs. A three-tab sequence has four gaps:

```text
  1       2       3      -1
  ↓       ↓       ↓       ↓
|   | A |   | B |   | C |   |
```

- `slot 1` is before the first tab;
- `slot -1` is after the last tab;
- intermediate positive slots count from the beginning;
- intermediate negative slots count back from the final gap.

Out-of-range slots clamp by default, with `bounds: "error"` available.

For same-parent moves, selectors and destinations resolve against the same pre-operation snapshot. The executor then removes selected identities and maps the resolved gap through surviving neighbour identities. This prevents the destination from drifting merely because earlier removals changed numeric indexes.

## 6. Selections are first-class ordered values

A selector is pure. It evaluates against one immutable snapshot and returns an **ordered set** of identities plus resolution metadata. It performs no mutation.

```text
selector + snapshot -> resolved ordered selection
resolved selection + transformation -> plan
plan + executor -> result and actual final state
```

All selectors in one command MUST resolve against the same snapshot. If a request names positions `1`, `4`, and `7`, the meaning of `4` and `7` cannot change after the first tab is moved.

A resolved selection SHOULD include:

- resolved stable identities and current handles;
- source selector and scope;
- source snapshot version;
- deterministic order and the reason for that order;
- capability or constraint warnings;
- optional projection data for display or dry-run output.

Selections are serializable and MAY be inspected, stored temporarily, passed between UI modes, or used as input to a subsequent transformation. A stored resolution is snapshot-bound; a saved selector expression can be re-evaluated later.

## 7. Selector algebra

### 7.1 Identity selectors

Identity selection accepts:

- one or more stable tab IDs or opaque handles;
- tab slugs or aliases;
- a window identity expanded to its tabs;
- a group identity interpreted as `members` or `node`;
- a browser-instance identity expanded through its descendants;
- an explicit list mixing any compatible selector forms.

An arbitrary direct-ID list MAY span windows and browser instances. The selection order is the list order after duplicate removal.

### 7.2 Structural scopes

Selectors operate within an explicit or inherited scope:

```text
browser instance -> window -> group -> tabs
```

For tab positions, the default scope is the focused window. A unique tab identity needs no window qualifier.

Window selection SHOULD support:

- stable ID, handle, slug, and alias;
- focused window;
- previously focused window and Nth focus-history entry;
- containing browser instance/profile;
- state predicates such as focused, minimized, normal, incognito, and display/bounds where available;
- title and metadata predicates.

Group selection SHOULD support:

- stable and native group IDs;
- slug and alias;
- displayed title and colour;
- containing window or browser instance;
- metadata predicates.

When a parent selector returns several branches, branch-relative positions apply to each branch by default:

```text
each(windows where incognito, tab 1)
```

means “the first tab in each matching window.” Flattening must be explicit:

```text
nth(flatten(windows where incognito -> tabs), 1)
```

means “the first tab in the combined ordered sequence.”

### 7.3 Positional selectors

Position selectors include:

- one signed position;
- an inclusive signed range;
- a discrete list mixing positions and ranges;
- `nth(selection, position)` after another selector;
- `slice(selection, range)` after another selector;
- `take`, `drop`, and `limit` as convenience forms compiled to `slice`.

Examples:

```text
tab -2 in win:research
tabs 1..5 in win:focused
tabs 1, 3, 8, -2 in win:research
nth(tabs where audible, -1)
slice(tabs where host = "github.com", 2..-2)
```

### 7.4 Relative selectors

The primitive relative selector is:

```text
offset(anchor, signed-position-or-range)
```

Examples:

```text
offset(tab:docs, -1)       previous tab
offset(tab:docs, 0)        the anchor
offset(tab:docs, 1)        next tab
offset(tab:docs, -3..3)    three neighbours either side plus the anchor
offset(tab:x, -Y..Z)       X plus Y earlier tabs and Z later tabs
```

Additional composable forms are:

- `expand(selection, range)`: include the specified neighbourhood around every selected tab, then deduplicate;
- `between(a, b, inclusive)`: select the range bounded by two anchors in their common ordered parent;
- `siblings(selection)`: tabs sharing the applicable parent;
- `parent(selection)`: containing group/window/instance according to requested level;
- `children(structural-selection)`: descendants at a requested level.

If anchors do not share the parent required by a relative operation, the selector MUST fail or return a clearly marked per-anchor miss. It MUST NOT silently flatten unrelated branches.

### 7.5 Predicate selectors

Predicates are composable boolean expressions over metadata. Core fields SHOULD include:

- title, URL, scheme, origin, host, registrable domain, port, path, query, and fragment;
- browser, profile/instance, window, and native group;
- pinned, active, highlighted, audible, muted, discarded, loaded/loading, grouped/ungrouped, incognito/normal;
- slug and aliases;
- capability-dependent state such as picture-in-picture, attention, unsaved form state, and screen/camera/microphone sharing where observable.

Core operators SHOULD include equality, inequality, containment, prefix, suffix, glob, regular expression, membership, comparison, existence, and boolean `and`/`or`/`not`.

The convenience selector:

```text
tabs matching "github"
```

SHOULD search a configured default projection such as title, current URL, host/domain, slug, and aliases. Page-body search is a separate, explicitly capability-gated selector because it needs page extraction permissions and has different privacy and performance characteristics.

### 7.6 Temporal and history selectors

The daemon is stateful and SHOULD track at least:

```text
created_at
last_focused_at
last_unfocused_at
last_navigated_at
last_url_changed_at
last_moved_at
last_group_changed_at
last_audible_at
```

`last_focused_at`, `last_navigated_at`, and `last_url_changed_at` are distinct:

- focus means the user activated/visited the tab;
- navigation means a committed browser navigation;
- URL change is broader and may include redirects, fragments, and observable SPA history changes.

Example selectors:

```text
visited within 5m
not visited within 3d
navigated within 20m
url-changed within 10m
visited between 10m..2h ago
most-recently visited 5
least-recently navigated 10
```

Recency convenience forms compile to `sort` plus `slice`, for example `sort by last_focused_at desc | take 5`.

### 7.7 Set algebra

Selectors compose recursively through ordered-set operations:

```text
A | B       union
A & B       intersection
A - B       subtraction
!A          complement within an explicit or inherited scope
```

Deterministic rules are:

1. atomic selectors return an ordered sequence;
2. union returns A followed by previously unseen members of B;
3. intersection retains A's ordering;
4. subtraction retains A's ordering;
5. complement uses the order of its declared scope;
6. duplicates are removed by stable identity unless multiplicity is explicitly meaningful to a non-selection operation.

Complement MUST have a finite scope. `!pinned` without a scope inherits the focused window for tab selection; callers SHOULD specify a broader scope when intended.

### 7.8 Ordering

A selection is both a set and a sequence. Its order may come from:

- current tree/document order;
- explicit identity-list order;
- ascending or descending range order;
- focus, navigation, or URL-change recency;
- title, URL, host, domain, group, or another metadata sort;
- an explicit shuffle seed;
- a previously resolved selection.

Transformations preserve resolved selection order unless their definition explicitly permutes it.

## 8. Destinations

Selections answer “what?” Destinations answer “where?” They use the same identity, absolute, and relative addressing families, but resolve to a structural parent and insertion gap.

A destination may identify:

- a slot in the current window or group;
- a slot in another window within the same live-move domain;
- a slot relative to an anchor tab;
- an existing native group;
- a newly created group;
- an existing window;
- a new window in a specified browser instance/profile;
- a browser instance/profile for reconstructive `copy` or `cut`.

Examples:

```text
win:research slot 1
win:research slot -1
group:backend slot 1
anchor(tab:docs, 1)
anchor(tab:docs, -1)
new window in instance:edge-work
```

An anchor-relative destination is expressed with a signed offset; `anchor(tab:docs, 1)` is the immediate following gap and `anchor(tab:docs, -1)` is the immediate preceding gap. Human interfaces MAY label these “after” and “before,” but the canonical representation remains signed.

`0` is invalid for an anchor-relative destination because a tab occupies an element position, not a gap. This is the one deliberate difference from relative element selection, where offset `0` means the anchor itself.

The planner MUST reject ambiguous multi-parent destinations unless the transformation explicitly defines distribution semantics.

## 9. Transformations

### 9.1 Query / inspect

`query` applies a projection to any selection without mutation. It replaces the need for separate information commands for every selection kind.

Useful projections include:

- core tab rows;
- full metadata;
- identities only;
- counts grouped by window, browser, group, domain, or predicate;
- capabilities and constraint warnings;
- history/journal fields;
- a tree view.

### 9.2 Move

`move` removes a selection from its current position and inserts it at a destination as a contiguous block, preserving selection order by default.

It covers:

- relative movement within a window, such as `by: -3` or `by: 5`;
- absolute movement within a window, such as `to: -1`;
- state-preserving movement into another window in the same live-move domain;
- movement into an existing or newly created compatible group;
- movement into a new window in the same live-move domain.

`move` MUST NOT cross a live-move-domain boundary. It must return an actionable error directing the caller to `copy` or `cut`.

When a multi-window selection is moved to one destination, it lands as one contiguous block in resolved selection order. When the intent is branch-preserving movement, the caller uses `each`, `partition`, or a declarative end state.

### 9.3 Copy

`copy` reconstructs selected tabs at the destination and leaves sources untouched. It is valid within or across browser boundaries.

Transferable descriptors SHOULD include:

- URL, after userinfo/credential redaction;
- title as advisory metadata;
- pinned intent where supported;
- group intent and reconstructible group metadata;
- opener/provenance metadata where useful;
- optional navigation/history hints only if explicitly supported.

The new tab necessarily loads. Live page state is not preserved. Results MUST return created identities and per-source outcomes.

Within the same browser, `copy` remains reconstructive and is semantically equivalent to duplication plus placement; it is not a live clone.

### 9.4 Cut

`cut` is a reconstructive transfer followed by source closure. It is the cross-browser analogue of movement, but it MUST remain named `cut` because live state is not preserved.

The safe sequence is:

1. resolve the source selection against the pinned snapshot;
2. create destination tabs in requested order;
3. verify each destination tab exists and report its new identity;
4. recreate requested grouping/pinning as capabilities permit;
5. close only the source tabs whose destination creation satisfied the declared success policy;
6. return per-item results and the actual final snapshot.

The default policy is `closeSource: "after-each-success"`. A `requireAllCopiesBeforeClose: true` mode first creates and verifies every destination, then closes sources. This reduces destructive partial transfer but still cannot create a browser-level transaction.

If destination creation fails, the corresponding source MUST remain open. Retrying with an idempotency key SHOULD avoid duplicate destination tabs or expose the duplicates explicitly.

Cross-browser `cut` MUST require explicit destructive authorization in non-interactive structured calls. Interactive CLI/TUI surfaces SHOULD preview reload and closure impact and request confirmation unless the caller supplies their documented non-interactive confirmation flag.

### 9.5 Swap

`swap(A, B)` exchanges two selections within a compatible live-move domain.

- `mode: "block"` swaps two contiguous blocks and permits unequal lengths;
- `mode: "pairwise"` swaps corresponding positions and requires equal cardinality;
- arbitrary non-contiguous selections require pairwise mode or an end-state declaration.

Cross-browser swap is not a live swap. A caller must use a reconstructive end state with explicit `copy`/`cut` transport policy.

### 9.6 In-place permutations

In-place permutations retain the selection's occupied slots while changing which selected tab occupies each slot:

- `reverse` reverses selected identities across their existing slots;
- `rotate by n` cyclically rotates them, with sign encoding direction;
- `sort by keys` orders them by one or more metadata keys;
- `shuffle seed N` performs a reproducible random permutation.

For `A B C D E F` with selection `B D F`, in-place reverse produces `A F C D E B`. This differs from moving `F D B` as a packed block.

Sort keys SHOULD include title, URL, host/domain, creation and journal times, current position, group, audible, pinned, browser, slug, and explicit computed keys. Sort stability MUST be defined; the default is stable.

### 9.7 Pack / gather

`pack` makes selected tabs contiguous without otherwise changing selection order. Its destination can be:

- explicit;
- the gap at the first selected tab;
- the gap at the last selected tab;
- a new window or group;
- a policy-derived anchor.

This is useful after predicates such as “all GitHub tabs” or “all audible tabs.” `gather` is human-facing aliasing for `pack` and need not be a separate primitive.

### 9.8 Partition

`partition` divides a selection into buckets and places each bucket into a destination branch. Bucketing may be based on:

- an explicit list of sub-selections;
- a metadata key such as domain, group, browser, pinned state, or recency band;
- ordered chunk size;
- predicate cases with an optional remainder bucket.

Destinations may be existing/new windows or groups. Bucket order and within-bucket order must be deterministic.

### 9.9 Distribute / scatter

`distribute` spreads an ordered selection across two or more destinations. Required policies are:

- `round-robin`;
- `contiguous-even` chunks;
- explicit counts or ratios;
- capacity-aware distribution where destinations have constraints.

`scatter` may be offered as a human-facing alias. Distribution is distinct from a multi-destination `move`, which would otherwise be ambiguous.

### 9.10 Interleave

`interleave` combines two or more ordered selections using a declared policy:

- round-robin/zip;
- weighted pattern;
- append remainder;
- stop at shortest.

The result may permute existing occupied slots or be packed at a destination. The mode must be explicit.

### 9.11 Group and ungroup

`group` and `ungroup` accept any tab selection.

`group` may:

- create a native group with title/colour metadata;
- add tabs to an existing compatible group;
- group separately per source window;
- first pack/move tabs into one compatible window when explicitly requested.

Because native groups are window-local and contiguous, a request spanning windows MUST either declare a gathering destination or choose `perWindow: true`. It must not silently move tabs.

Moving a group between compatible windows may require moving live tabs and recreating group metadata in the destination; the tabs can remain live even though the group identity changes. Cross-browser grouping is reconstructive because the tabs themselves are reconstructed.

Pinned tabs and native groups may be incompatible. The planner MUST report the constraint and apply only an explicit policy such as unpin-first, skip, or error.

### 9.12 General tab actions

`act` fans a supported single-tab action over any selection. Actions include, subject to capability:

- activate/focus;
- mute/unmute;
- pin/unpin;
- discard/wake;
- reload;
- duplicate;
- navigate, back, and forward;
- close;
- future capability-advertised actions.

Bulk actions MUST return per-tab status. Destructive actions must obey the same preview, confirmation, snapshot, and partial-failure rules as structural transformations.

Window and group metadata actions SHOULD use structural-node selections rather than overloading tab expansion.

## 10. Same-browser movement versus cross-browser transfer

The operation name is determined by the state-preservation boundary, not by visual intent.

| Source and destination | Valid operation | Reload/recreation | Source remains |
|---|---|---:|---:|
| Same live-move domain, change position/window | `move` | No | No; same tab identity moved |
| Same or different domain, duplicate | `copy` | Yes | Yes |
| Different live-move domains, relocate intent | `cut` | Yes | No, after verified reconstruction |
| Different live-move domains, requested `move` | Error | — | Yes |

A browser product name is not sufficient to infer the domain. Different profiles, incognito boundaries, remote sessions, extension authorities, or adapter limitations may make reconstruction necessary even when both endpoints are branded Chrome. Runtime capability and ownership determine the boundary.

The planner MUST surface a transfer-impact summary before apply:

- how many tabs move live;
- how many reload through copy/cut;
- which metadata can and cannot be recreated;
- which source tabs will close;
- any tabs with observable unsaved/form/media state;
- any capability or policy conflicts.

## 11. Declarative end-state applicator

An end-state request describes the desired browser tree; the daemon computes and applies the operations. Callers do not need to calculate index-shifting move sequences.

### 11.1 Partial and strict layouts

The default is a **partial end state**:

- listed tabs/groups/windows are constrained as declared;
- unlisted tabs remain in their existing relative order and location where possible;
- the planner reports any incidental movement needed to satisfy browser invariants.

With `strict: true`, the request must cover the declared scope completely. Missing, duplicated, or out-of-scope identities are validation errors unless an explicit policy handles them.

### 11.2 Transport policy in end states

An existing identity placed elsewhere in the same live-move domain implies `move`.

An identity placed across a live-move-domain boundary MUST declare `transport: "copy"` or `transport: "cut"`. `auto` MAY be offered only if it resolves to live `move` within a domain and to non-destructive `copy` across a boundary; it MUST NOT silently choose destructive `cut`.

### 11.3 Example

```json
{
  "endState": {
    "scope": { "instances": ["instance:chrome-work", "instance:edge-work"] },
    "strict": false,
    "windows": [
      {
        "window": "win:research",
        "tabs": ["tab:paper", "tab:docs", "tab:issue"],
        "groups": [
          {
            "group": "new",
            "title": "Research",
            "color": "blue",
            "tabs": ["tab:paper", "tab:docs"]
          }
        ]
      },
      {
        "window": "new",
        "instance": "instance:edge-work",
        "tabs": [
          { "ref": "tab:dashboard", "transport": "copy" },
          { "ref": "tab:calendar", "transport": "cut" }
        ]
      }
    ]
  },
  "dryRun": true,
  "expectedSnapshotVersion": 418
}
```

### 11.4 Planning and minimization

The solver SHOULD optimize for safety first, then minimize cost. A default cost order is:

1. avoid reconstruction and source closure;
2. avoid moving tabs already in correct relative order;
3. avoid breaking and recreating native groups;
4. minimize browser API calls and window creation;
5. preserve focus, active tabs, pin state, and unaffected relative order.

Within a window, a longest-increasing-subsequence-style analysis can identify tabs whose desired relative order is already correct so they do not move. Across windows, assignment and group constraints are solved before per-window ordering. The planner MUST not call a plan “minimal” unless the cost model and guarantee are documented; `minimal under declared cost model` is preferred wording.

### 11.5 Dry-run result

`dryRun: true` returns, without mutation:

- source snapshot/version;
- resolved selectors and identities;
- final normalized target tree;
- ordered primitive operations;
- live-move versus reconstructive transfer counts;
- expected identity mapping;
- warnings, constraints, and destructive effects;
- estimated focus/group/pin changes;
- whether the plan remains applicable to the current snapshot.

## 12. Canonical structured command model

The source of truth is a recursive, versioned, Zod-validated AST. MCP accepts this AST directly. CLI, console, and TUI conveniences compile to it.

The initial implementation SHOULD avoid making a free-form string DSL the only interface. A shell-friendly syntax can evolve later without changing semantics.

### 12.1 Conceptual selector types

```ts
type Selector =
  | { kind: "ids"; ids: string[] }
  | { kind: "scope"; node: NodeSelector; expand?: "members" | "node" }
  | { kind: "positions"; scope?: Selector; positions: PositionExpr[]; bounds?: "clamp" | "error" }
  | { kind: "offset"; anchor: Selector; offsets: RangeExpr }
  | { kind: "between"; anchors: [Selector, Selector]; inclusive?: boolean }
  | { kind: "expand"; selector: Selector; offsets: RangeExpr }
  | { kind: "where"; scope?: Selector; predicate: Predicate }
  | { kind: "union" | "intersect" | "subtract"; selectors: Selector[] }
  | { kind: "complement"; selector: Selector; within: Selector }
  | { kind: "sort"; selector: Selector; by: SortKey[] }
  | { kind: "slice"; selector: Selector; range: RangeExpr }
  | { kind: "each"; branches: Selector; selector: Selector }
  | { kind: "flatten"; selector: Selector };
```

This is illustrative, not a frozen TypeScript declaration. The implementation plan must finalize discriminators, recursive limits, validation messages, and schema versioning.

### 12.2 Conceptual destination types

```ts
type Destination =
  | { kind: "slot"; parent: NodeSelector; at: number; bounds?: "clamp" | "error" }
  | { kind: "anchor"; tab: Selector; offset: number }
  | { kind: "newWindow"; instance: NodeSelector }
  | { kind: "newGroup"; window: NodeSelector; at?: number; title?: string; color?: string }
  | { kind: "existingGroup"; group: NodeSelector; at?: number };
```

### 12.3 Tool surface

The target MCP surface should remain small:

```text
select_tabs { selector, projection?, snapshotVersion? }
arrange_tabs { selector, transform, dryRun?, expectedSnapshotVersion?, idempotencyKey? }
arrange_tabs { endState, dryRun?, expectedSnapshotVersion?, idempotencyKey? }
```

`select_tabs` is pure read. `arrange_tabs` performs one declared transformation or one end-state application per call. Selection composition stays inside the selector AST, so results remain attributable.

Existing focused single-tab tools remain useful. `move_tab` SHOULD gain:

- same-window reorder without requiring a redundant destination window;
- signed absolute positions;
- relative `by: ±N` movement;
- the same snapshot and actual-result reporting rules.

These are convenience paths into the same planner, not separate semantics.

### 12.4 CLI and console

The CLI SHOULD provide:

- lossless JSON input, including stdin/file forms;
- ergonomic flags/subcommands for common selectors and transformations;
- `--dry-run`, `--json`, expected-snapshot, idempotency, and explicit confirmation options;
- a normalized-AST output/debug mode;
- shell-safe handling that does not require users to quote a complex ad hoc language for ordinary tasks.

Illustrative human syntax in this specification is explanatory. It does not commit the first release to a parser.

## 13. TUI behavior

The TUI should embody the selection/transformation model directly:

- Vim-like motion keys navigate and extend selections;
- operator-pending modes select a transformation, then a motion/selection;
- visual selection and marked-item modes compile to the same selector AST;
- counts are signed/relative at the primitive layer even when keys such as `h`, `l`, `j`, and `k` provide human convenience;
- preview mode shows the resolved tabs, intended destination, reload/closure impact, and constraints;
- undo availability is shown before apply where possible.

The bottom bar MUST show exactly the bindings available in the current context—no unavailable bindings and no hidden valid bindings. Context includes focus level, selection shape, active operator, capability, confirmation state, and terminal width.

TUI conveniences must not create private behavior absent from the shared planner. They compile to canonical selectors and transformations.

## 14. Planning, execution, and concurrency

### 14.1 Snapshot resolution

Every mutation request resolves against one versioned snapshot. The request MAY include `expectedSnapshotVersion` or a stronger snapshot token.

If relevant state changes before apply, the executor follows an explicit policy:

- `conflict: "error"` — default for index-sensitive and destructive operations;
- `conflict: "replan"` — re-resolve the selector and return the changed plan for approval, or apply automatically only when the caller explicitly allows it;
- `conflict: "best-effort"` — valid only for operations whose identity-based semantics remain safe.

The result identifies the snapshot used, any replan, and the final observed snapshot.

### 14.2 Index translation

Browser indexes are mutable and often zero-based, while the public language uses signed one-based element positions and signed insertion slots. Translation occurs only in the executor.

The planner works with stable identities and gaps. Primitive operations are ordered so an earlier removal does not invalidate later intent. Browser-returned move indexes must be verified with a settled read when the API echo is known to be unreliable.

### 14.3 Constraints

The planner MUST account for:

- pinned-tab regions and pin/unpin side effects;
- group contiguity and window-local group identities;
- moving a grouped tab potentially ungrouping it;
- active/focused tab and window side effects;
- incognito/profile boundaries;
- privileged or non-transferable URLs;
- browser rules around the last tab/window;
- stale handles and closed tabs;
- adapter versus extension capabilities;
- observable unsaved forms, media, capture, and sharing state;
- reconstruction metadata loss.

Constraint policies are explicit: `error`, `skip`, or a named corrective action. Silent policy invention is forbidden.

### 14.4 Capability gating

Capability truth is runtime-probed. The planner gates operations on advertised capabilities rather than browser-name conditionals. Plans may contain different pathways per selected tab, but dry-run must disclose them.

If only a reload-based adapter path exists, that is reconstruction or an explicitly reload-permitted fallback; it is not presented as a state-preserving move.

## 15. Results, failure reconciliation, and undo

Browser APIs do not offer a transaction spanning multiple tabs/windows. Every bulk result MUST therefore be structured and honest.

It should include:

- overall status: `success`, `partial`, `failed`, or `conflict`;
- source and final snapshot versions;
- normalized request and plan identifier;
- per-operation and per-tab results;
- skipped/stale identities and reasons;
- created identity mapping;
- source tabs closed by `cut`;
- actual final positions, windows, groups, and pin state;
- residual difference from the requested end state;
- warnings and suggested reconciliation action.

The executor SHOULD re-read actual final state after a partial failure and compute a residual plan. It MUST not report the intended plan as if it were the applied state.

Undo is best-effort and operation-aware:

- same-domain moves and permutations can usually be reversed by a stored pre-state if identities still exist;
- group metadata may be recreated with new native IDs;
- `copy` undo can close created tabs if they still match the operation record;
- `cut` cannot restore lost live page state, even if URLs are reopened;
- close/reload/navigate actions have browser-dependent reversibility.

The UI and result schema must distinguish true state restoration from reconstructive compensation.

## 16. Safety and privacy

- Dry-run is mandatory for declarative planning and available for every structural mutation.
- MCP callers must explicitly authorize destructive source closure for `cut`, `close`, and strict end states that remove tabs.
- URL userinfo and credentials must be redacted before persistence or transfer.
- Selector/result logs should record identities and normalized metadata without page content unless page-body selection was explicitly requested.
- Incognito data must obey a separate retention policy and browser permissions.
- Temporal journal retention must be configurable and documented.
- Page-body search and unsaved-form inspection require explicit capabilities and must not be silently enabled.
- An unexpectedly unavailable extension/adapter produces an actionable error; the executor must not silently downgrade a live move to reload-based reconstruction.

## 17. Acceptance criteria and test matrix

### 17.1 Core semantic acceptance

1. Signed positions are one-based; `0` is rejected; negatives count from the end; boundary behavior matches `clamp` or `error` policy.
2. Relative offsets use `0` for the anchor, signs for direction, and do not wrap.
3. Descending ranges preserve reverse selection order.
4. Mixed selector modes resolve once against one snapshot and deduplicate deterministically.
5. `each` and `flatten` produce observably different, documented results.
6. Set algebra preserves the specified left-biased ordering.
7. Multi-tab live moves preserve resolved order and tab identity.
8. A cross-domain `move` is rejected before mutation.
9. Cross-browser `copy` reloads/recreates, leaves sources, and returns new identities.
10. Cross-browser `cut` closes only successfully reconstructed sources and reports partial outcomes.
11. Group selectors support both member expansion and node/block interpretation.
12. In-place permutations differ correctly from pack/move semantics.
13. End-state dry-run returns a deterministic normalized target and operation plan.
14. End-state apply either satisfies the target or reports the exact residual difference from actual final state.
15. All structured surfaces use the same schema and planner.

### 17.2 Required matrix dimensions

Tests SHOULD cover combinations of:

- Chrome, Chromium, Brave, Edge, and Safari where supported;
- same window, different window, different profile/instance, and different browser product;
- extension-connected and adapter-only pathways;
- focused/unfocused and normal/minimized windows;
- pinned/unpinned, grouped/ungrouped, active/inactive, audible/muted, discarded/loaded tabs;
- one tab, contiguous range, non-contiguous selection, multi-window selection, and empty selection;
- positive, negative, boundary, out-of-range, and invalid zero positions;
- stale IDs, tab closure during planning, snapshot conflicts, mid-batch browser errors, and reconnects;
- partial versus strict end states;
- dry-run determinism and idempotent retry;
- selection sizes large enough to expose O(n²) planning or index-shift defects.

Property-based tests are especially suitable for ordered-set algebra, signed index normalization, same-parent gap mapping, permutation correctness, and end-state plan simulation.

## 18. Verified implementation baseline — 22 August 2026

This section is non-normative and will age. It records the live repository state examined while producing this specification: clean `main` at commit `6bbe796`.

| Area | Verified baseline |
|---|---|
| Absolute cross-window single-tab move | Exists through `move_tab { targetWindowId, targetIndex }`; `targetIndex` is currently zero-based and non-negative. |
| New-window and target-group move | Exists for compatible pathways. |
| Same-window reorder convenience | Still requires a redundant explicit `targetWindowId`; omission errors. |
| Signed absolute or relative move | Not present in the current `move_tab` schema. |
| Arbitrary selector algebra | No `select_tabs` or `arrange_tabs` implementation found. Group operations accept explicit tab ID lists, but that is not a general selector system. |
| Swap, bulk action, end-state solver | Not present as the generalized features specified here. |
| Edge first-class support | Shipped in current main. Browser identity, detection, macOS adapter metadata, and real branded Edge CI are present. This is no longer an outstanding workstream. |
| TUI primitives port and polish | Shipped in current main, including the tui-kit primitive port. The future selector/operator UX remains a separate feature. |
| `cgWindowId` oscillation | Still documented as an open macOS product bug. The accepted direction is instrumentation-first; prior event-path asymmetry speculation was contradicted by code exploration. It is adjacent operational work, not part of selector semantics. |

The current implementation also already verifies actual post-move position with a final tab read because an intermediate browser move echo has proven unreliable. The generalized executor should preserve that discipline.

## 19. Implementation planning boundaries

This specification should be implemented as independently reviewable workstreams, in dependency order:

1. **Shared language contracts:** versioned selector, predicate, destination, transformation, plan, and result schemas; documented normalization rules; schema fixtures.
2. **Pure resolver and planner:** snapshot-bound selector evaluation, ordered-set algebra, signed indexing, gap mapping, constraint analysis, and dry-run output.
3. **Single-domain executor:** same-window reorder, relative/signed movement, block movement, permutations, group operations, bulk actions, settled-state verification, and reconciliation.
4. **Reconstructive transfer:** descriptors, cross-browser/profile `copy` and `cut`, explicit destructive authorization, identity mapping, partial-failure policy, and idempotency.
5. **End-state solver:** normalization, assignment, group/pin constraints, cost model, LIS-style per-window minimization, residual diff, and undo records.
6. **MCP and CLI surfaces:** `select_tabs`, `arrange_tabs`, JSON/file/stdin input, common convenience commands, dry-run and conflict policy.
7. **TUI/console integration:** operator/motion modes, contextual footer, previews, confirmation, and shared result rendering.
8. **Operational hardening:** capability matrix, performance limits, journal retention, observability, fuzz/property tests, real-browser E2E, and documentation.

The open `cgWindowId` investigation remains a separate instrumentation/fix workstream. It should not be bundled into the semantic core merely because window targeting consumes the resulting correlation field.

## 20. Canonical examples

The following are semantic examples. Their human-readable spelling may be implemented as CLI convenience syntax or compiled directly by the TUI.

```text
# Inspect the first and last tabs in the focused window
query tabs 1, -1

# Inspect the first audible tab across the current browser instance
query nth(flatten(tabs where audible in instance:focused), 1)

# Select an audible tab and its immediate neighbours
query expand(tabs where audible, -1..1)

# Move the active tab three places earlier in the same window
move tab:active by -3

# Move an arbitrary ordered list to the end of a research window
move [tab:issue, tab:docs, tab:paper] -> win:research slot -1

# Exchange two contiguous ranges
swap tabs 2..4 <-> tabs -3..-1 mode block

# Reverse only the selected occupied positions
reverse tabs 2, 5, 8 in-place

# Gather matching tabs without changing their resolved order
pack tabs where domain = "github.com" -> anchor(tab:work, 1)

# Put domain buckets into one new group per domain
partition tabs where !pinned by domain -> new groups in win:research

# Spread tabs across three windows in round-robin order
distribute tabs where audible -> [win:media-a, win:media-b, win:media-c] round-robin

# Copy selected tabs into Edge; source tabs remain
copy tabs where group = "Research" -> new window in instance:edge-work

# Reconstruct in Edge, then close only successfully copied Chrome sources
cut tabs visited within 30m -> win:edge-handoff slot -1

# Apply an action to a composed selection
act mute on ((tabs where audible | group:music) - tabs where muted)

# Preview a declarative final layout
arrange --end-state layout.json --dry-run --expected-snapshot 418
```

## 21. Final design rules

The following rules resolve the major ambiguities in the source material:

1. The canonical language is a structured recursive AST; human syntax and keybindings are compiled conveniences.
2. Positions are signed and one-based; offsets are signed with zero as the anchor; neither wraps by default.
3. Selections are ordered, deduplicated, pure, and resolved once per snapshot.
4. Structural movement within a live-move domain is `move` and preserves tab identity/state.
5. Crossing a live-move-domain boundary is never `move`; it is reconstructive `copy` or explicitly destructive `cut`.
6. Group selection distinguishes member expansion from group-node/block intent.
7. In-place permutation, packed movement, partition, distribution, and interleave are distinct operations.
8. Declarative end states use explicit transport semantics, default to partial coverage, and expose a complete dry-run plan.
9. Runtime capabilities—not browser-name assumptions—govern available pathways.
10. Results report actual final state and residual differences; no multi-step mutation is misrepresented as transactional.

These rules form the stable semantic contract from which implementation plans, schemas, CLI affordances, MCP tools, and TUI interactions should be derived.

## 22. AI authoring profile

The canonical AI-facing representation SHOULD remain JSON rather than YAML, XML, KDL, an S-expression, or a custom textual DSL. This is not because JSON is intrinsically the most readable notation; it is because MCP tool arguments are JSON objects described by JSON Schema, and major model tool-calling interfaces use the same object-and-schema model. Staying inside that native contract allows the host or model provider to constrain generation, validate arguments before execution, and return field-specific errors.

An alternative notation encoded inside a string-valued tool argument would require the model to satisfy two grammars—the outer JSON call and the inner notation—while bypassing most MCP-level structural validation. It MUST NOT be the primary MCP interface.

### 22.1 Model-friendly schema rules

AI-facing schemas MUST optimize for semantic validity as well as syntactic validity:

- Every union uses one required literal discriminator such as `kind`, `action`, or `mode`.
- Each discriminator variant defines its own required fields and rejects fields belonging only to other variants.
- Object schemas are closed with `additionalProperties: false` unless an explicitly documented extensibility field is required.
- Enumerations are preferred over free-form strings for finite choices.
- A field has one meaning and one type. Overloaded scalar fields and sentinel strings such as `"new"` SHOULD be replaced by explicit discriminated variants where practical.
- Defaults are safe, visible in the schema, and never imply destructive behavior. In particular, no omitted value may silently select cross-browser `cut`.
- Recursive selector schemas have documented maximum depth, total-node, list-length, and serialized-size limits.
- Common operations remain shallow. A caller should not need to construct a deeply recursive tree to express a direct identity, predicate, range, or simple movement.
- Tool and field descriptions explain intent and important constraints, not merely repeat their names.
- High-risk or structurally unusual variants SHOULD have at least one minimal valid example in model-visible documentation, subject to verification that the target MCP host exposes it.

The target schemas MUST NOT repeat the “flat bag of optional fields” pattern in which an action discriminator is valid even though the fields required by that action are absent. For example, a `move` variant must require a valid destination, and a `navigate` variant must require a URL at initial schema validation rather than failing later in the executor.

### 22.2 Simple and complex call profiles

The same semantics SHOULD support two AI call profiles:

1. **Direct:** `arrange_tabs` accepts an inline selector for ordinary one-call operations.
2. **Resolved:** `select_tabs` resolves a complex selector first and returns a short-lived `selectionId` that `arrange_tabs` may consume.

A resolved selection reference MUST be bound to:

- the snapshot version against which it was resolved;
- its ordered stable identities;
- its scope and capability assumptions;
- an expiry or invalidation rule.

This two-stage path lets an AI inspect the exact resolved tabs and warnings before mutation, reduces repeated nested markup, and makes destructive confirmation attributable to a concrete selection. It does not replace inline selectors for simple calls.

### 22.3 Validation and correction

Validation failures returned to an AI MUST be actionable. They SHOULD include:

- the exact JSON path;
- a stable error code;
- the violated constraint;
- the expected type, enum, or required companion field;
- a concise correction hint;
- whether the request is safe to retry unchanged, safe to correct and retry, or requires a fresh snapshot.

Where JSON Schema can express a semantic constraint, the schema SHOULD express it. Runtime validation remains necessary for snapshot state, cross-field facts that depend on live browser data, capabilities, and concurrency.

### 22.4 CLI authoring formats

The CLI MAY later accept YAML, JSONC/JSON5, or KDL as optional human-authored plan files if there is demonstrated demand. Any such adapter must:

- parse locally before execution;
- compile to the canonical versioned JSON AST;
- expose the normalized JSON form for inspection and dry-run;
- preserve identical validation and execution semantics;
- never become a second independent command language.

For AI automation, MCP tool calls are preferred. When an AI must drive the CLI, it SHOULD pass canonical JSON through a file or standard input rather than generate a heavily shell-quoted command string. The human CLI syntax and TUI keybindings remain convenience compilers into the same AST.

### 22.5 Cross-engine compatibility gate

Before freezing the schemas, representative calls SHOULD be evaluated through every supported MCP host/model family. The fixture set must include:

- one valid example of every selector, destination, and transformation variant;
- invalid discriminator/field combinations;
- maximum supported recursive depth and size;
- direct versus resolved-selection forms;
- destructive confirmation and snapshot-conflict cases;
- round-trip comparison between model-produced arguments and the normalized AST.

The compatibility target is the intersection of JSON Schema features reliably exposed by supported MCP hosts, not the largest feature set accepted by one provider. If a schema construct is valid in JSON Schema but materially reduces cross-engine generation reliability, the public AI-facing shape SHOULD use a simpler equivalent while the internal planner retains the richer typed representation.

## 23. Append-only design review — 22 August 2026

This section records a later codebase, MCP, and cross-domain architecture review. It intentionally does not delete or silently rewrite the preceding specification. Where it recommends a smaller public surface than sections 9, 12.3, 19, or 21, implementation planners SHOULD treat the recommendation as a proposed refinement and record the final choice explicitly.

The review used the current repository, its local MCP tool-authoring rules, the current Model Context Protocol specification, current Claude connector/MCP guidance, and current tmux documentation. Three independent reviews—selection semantics, platform architecture, and model-facing MCP design—were then cross-critiqued.

The direct answers are:

- **Yes, whole-window and multi-window tab selection are intended.** A window selection can be projected to all of its tab members; any finite set of windows can be projected the same way.
- **Yes, all tabs from windows A and B can be moved into window C**, provided every selected tab and C share one live-move domain and the caller declares what may happen to emptied source windows.
- **Yes, all tabs from A can be moved into B** as an intentional window merge. This moves tab members; it is not an operating-system window move.
- **Yes, independently scoped selectors can be combined recursively**, but only after they produce the same result kind. A group or window is not silently coerced into tabs.
- **A selection spanning browser products remains valid for inspection and reconstruction**, but live `move`, live swap, movement-producing sort, and similar operations are blocked before mutation.

### 23.1 Important distinctions found in the current repository

The implementation plan MUST account for these concrete gaps rather than treating the conceptual schema as already present:

1. `Snapshot.version` is currently a contract-schema version fixed at `2`; it is **not** a monotonic state revision. The examples using `expectedSnapshotVersion: 418` therefore need a new field such as `snapshotRevision` or an opaque `snapshotToken`. Schema version and concurrency revision MUST remain separate concepts.
2. Current handles are not uniformly stable across reorder, reconnect, and authority changes. Safari handles are explicitly synthetic, and extension/AppleScript generations differ. Until a durable identity layer exists, materialized selections and plans MUST be snapshot-bound and MUST NOT imply cross-snapshot identity stability.
3. The current contract has neither profile/instance identity nor a first-class `liveMoveDomainId`. Browser product equality is an insufficient replacement. The TUI's present same-browser filtering is a useful safety guard, not the final domain model.
4. Current `TabActionInputSchema` and `GroupTabsInputSchema` are optional-field bags whose required companion fields are checked late. The new language schemas SHOULD use action-specific discriminated variants, as section 22 requires.
5. MCP Resources already exist in the repository, but currently expose health and development logs rather than snapshots, selections, or plans. The mechanism can be extended rather than invented again.
6. The tool registry currently contains 20 tools, 19 normally model-visible. That remains workable; schema ambiguity and safety coherence matter more than raw tool count.

## 24. Typed selection closure and multi-window semantics

### 24.1 Same-kind closure and explicit projection

Every selector has a result kind. The initial browser kinds are:

```text
Selection<BrowserInstance>
Selection<Window>
Selection<Group>
Selection<Tab>
```

Set algebra is closed over one result kind:

```text
Selection<Tab> | Selection<Tab>       valid
Selection<Window> - Selection<Window> valid
Selection<Group> | Selection<Tab>     invalid
```

Any tab-valued selector may combine with any other tab-valued selector regardless of how either was produced: identities, group/window member projection, predicates, time, positions, relative expansion, or another set expression.

Structural selections become tab selections only through an explicit projection such as `members` or `descendants(kind: "tab")`. The resolver MUST NOT infer a projection merely to make a mixed expression type-check. This preserves the difference between acting on a window node and acting on the tabs contained by that window.

For AI-facing schemas, separate `TabSelector`, `WindowSelector`, and `GroupSelector` unions are likely easier to generate correctly than one completely generic recursive selector. They may still share an internal generic implementation.

### 24.2 Ordered views, branches, and `withinEach`

The browser snapshot is naturally viewed as an ordered forest. A reusable selection library, however, should evaluate an **ordered view** rather than assume that every future domain is a strict ownership tree. This matters because a tmux window can be linked into more than one session.

A resolved member therefore has three relevant identities when the domain needs them:

- the underlying entity identity;
- its occurrence or path in an ordered view;
- the projection/view in which parent, sibling, range, and position are interpreted.

Browsers normally have one occurrence per tab, so the distinction can stay invisible in ordinary results.

Resolution MUST retain both:

- one deterministic total order of resolved tabs; and
- branch/provenance partitions such as source window and source group.

Hidden partitions MUST NOT silently alter transformation behavior. An operation that acts separately per branch must request that behavior.

The earlier `each` concept should be finalized as an explicit lexical operator such as `withinEach`. Its inner selector is evaluated once per resolved branch:

```json
{
  "kind": "withinEach",
  "branches": {
    "kind": "windows",
    "ids": ["win:A", "win:B"]
  },
  "select": {
    "kind": "positions",
    "positions": [-1]
  }
}
```

This means the last tab of A and the last tab of B. It is distinct from the last tab of their combined sequence:

```json
{
  "kind": "positions",
  "scope": {
    "kind": "flatten",
    "selector": {
      "kind": "members",
      "nodes": {
        "kind": "windows",
        "ids": ["win:A", "win:B"]
      },
      "descendantKind": "tab"
    }
  },
  "positions": [-1]
}
```

Directly listed windows preserve caller order, and each contributes tabs in visual order. Predicate-selected windows use a documented snapshot branch order; raw browser API array order MUST NOT be assumed stable without verification. An explicit tree-order sort can replace the left-biased order of a composed union.

### 24.3 Entire-window and multi-window examples

All tabs in two windows are selected by projecting the two structural nodes:

```json
{
  "kind": "members",
  "nodes": {
    "kind": "windows",
    "ids": ["win:A", "win:B"]
  },
  "descendantKind": "tab"
}
```

Moving A and B into C as one ordered block can be expressed conceptually as:

```json
{
  "selector": {
    "kind": "members",
    "nodes": {
      "kind": "windows",
      "ids": ["win:A", "win:B"]
    },
    "descendantKind": "tab"
  },
  "transform": {
    "kind": "move",
    "destination": {
      "kind": "slot",
      "parent": { "kind": "window", "id": "win:C" },
      "at": -1
    },
    "emptySourceWindows": "close"
  }
}
```

The resulting block order is A's tabs followed by B's tabs. The operation is valid only when all sources and C share one live-move domain.

Moving every tab from A into B intentionally drains A. Browsers generally cannot retain a zero-tab window, so the operation needs an explicit policy:

```text
emptySourceWindows: "error" | "close" | "keepWithNewTab"
```

`error` is the recommended default for structured bulk calls. `close` permits the source browser window to disappear. `keepWithNewTab` introduces a reconstructed placeholder tab and must disclose that side effect. A TUI convenience named “merge windows” can compile to member movement plus `close` after showing the preview.

Member projection selects tabs, not native group or window metadata. If a whole-window merge should recreate group structure, the plan must declare a structure policy such as `tabsOnly`, `preserveGroupsWherePossible`, or an explicit end state.

### 24.4 Combining scoped inclusions and exclusions

The following illustrates all red native Chrome-group members across Chrome, muted tabs in the focused window, tabs navigated in the last three hours, the last tab of every window, and the first four tabs of the focused window:

```json
{
  "kind": "union",
  "selectors": [
    {
      "kind": "members",
      "nodes": {
        "kind": "groups",
        "scope": { "kind": "allWindows", "browser": "chrome" },
        "where": { "field": "color", "op": "eq", "value": "red" }
      },
      "descendantKind": "tab"
    },
    {
      "kind": "where",
      "scope": { "kind": "tabsInFocusedWindow" },
      "predicate": { "field": "muted", "op": "eq", "value": true }
    },
    {
      "kind": "where",
      "scope": { "kind": "allTabs" },
      "predicate": {
        "field": "lastNavigatedAt",
        "op": "within",
        "value": "3h"
      }
    },
    {
      "kind": "withinEach",
      "branches": { "kind": "allWindows" },
      "select": { "kind": "positions", "positions": [-1] }
    },
    {
      "kind": "positions",
      "scope": { "kind": "tabsInFocusedWindow" },
      "positions": [{ "from": 1, "to": 4 }]
    }
  ]
}
```

Duplicates are removed by stable identity within the materialized snapshot. Union remains left-biased, so the order of the clauses matters if the result is later moved. A subtraction can wrap this union, or any of its operands, to exclude an arbitrary tab-valued selector:

```json
{
  "kind": "subtract",
  "selectors": [
    { "kind": "ref", "selection": "includedTabs" },
    {
      "kind": "union",
      "selectors": [
        {
          "kind": "where",
          "scope": { "kind": "tabsInSelectedWindows" },
          "predicate": { "field": "pinned", "op": "eq", "value": true }
        },
        {
          "kind": "withinEach",
          "branches": { "kind": "selectedWindows" },
          "select": { "kind": "positions", "positions": [1] }
        }
      ]
    }
  ]
}
```

The final schema should make subtraction's operand roles explicit—`from` and `remove`, or documented left associativity—rather than rely on an ambiguous unordered array.

### 24.5 Capability-derived operator availability

A selection is not invalid merely because it spans browsers, profiles, windows, or capability domains. Resolution SHOULD return:

- browser and instance/profile IDs;
- live-move-domain IDs;
- capability intersection;
- capability gaps by member;
- allowed and blocked transformations with stable reason codes;
- transfer/reload/destructive impact warnings.

If more than one browser product or live-move domain is present, all live relocation operations are blocked for that whole materialized selection in the initial implementation. This includes move, reorder, live swap, movement-producing sort, and pack-by-movement. The executor MUST reject the request before the first mutation and suggest `copy` or `cut` where applicable.

MCP has no protocol-level per-call “enabled” field for a tool. Therefore “disable move” means:

1. return `blockedOperations` from selection and planning;
2. visually disable the operation in the TUI;
3. retain a stable MCP tool catalog;
4. repeat the capability and snapshot preflight immediately before apply; and
5. return a structured `cross_domain_live_move` error if a caller attempts it anyway.

Pure query ordering remains valid across domains. Reconstructive `copy` may remain available. `cut` requires destination-create capability, source-close capability, explicit destructive authorization, and per-item verification.

### 24.6 Edge policies that must be frozen with the schema

The implementation plan must make the following explicit:

- `emptySelection: "error" | "noOp"`; queries naturally return empty, while mutations should default to `error`;
- destination windows or anchors that overlap the source selection;
- selected anchors that disappear during movement, preferably rejected unless a stable-gap rule is defined;
- pin policy when selected tabs cross pinned/unpinned regions;
- group preservation or loss when moving group members;
- how an unavailable temporal field is handled: `unknown: "exclude" | "include" | "error"`;
- one frozen `evaluationTime` for relative-time predicates;
- privileged, internal, file, or extension URLs that cannot be reconstructed;
- identity and occurrence invalidation after tab/window closure or source-authority change;
- deterministic branch order across browser instances and windows.

In particular, `not visited within 3d` MUST NOT accidentally include tabs whose visit time is unknown merely because the predicate could not be evaluated.

## 25. Recommended simplification profile

The language can remain expressive while the public transformation vocabulary and executor stay small. The key is to distinguish a convenient intent from a primitive effect.

### 25.1 Small browser effect IR

Friendly operations SHOULD normalize into a bounded browser-specific intermediate representation resembling:

- relocate existing live identities;
- create reconstructed identities from transferable descriptors;
- close verified sources;
- set order within an ordered parent;
- set tab/group/window metadata;
- invoke a bounded, capability-declared tab action.

This effect IR is browser-specific. It is not evidence that tmux linking, pane joining, terminal splitting, or Finder behavior should share the same effect enum.

### 25.2 Core, compiled conveniences, and deferred features

| Status | Operations | Recommendation |
|---|---|---|
| Core | select/query, block move, copy, cut, group/ungroup, bounded tab actions, partial declarative end state, dry-run/plan, conflict checking, reconciliation | Implement and test directly. |
| Shallow convenience | swap, pack/gather, stable sort, reverse, group-by-predicate | Compile to `setOrder`, block movement, group effects, or an end-state plan. Keep swap as a user-facing convenience because it was explicitly requested. |
| Defer pending evidence | arbitrary pairwise non-contiguous swap, rotate, seeded shuffle, general partition, distribute/scatter, interleave/zip/weighted weave | Do not require first-release schemas, executors, undo paths, or test matrices. |

Section 21.7 remains semantically true: occupied-slot permutation, packed movement, distribution, and interleave describe different outcomes. They do **not** all need to be public first-class transformations. Rare outcomes can be stated as a desired order.

### 25.3 Explicit order as the escape hatch

The compact escape hatch is a partial end-state order:

```json
{
  "kind": "setOrder",
  "scope": { "kind": "window", "id": "win:A" },
  "tabs": ["tab:4", "tab:2", "tab:9"],
  "unlisted": "stable"
}
```

This expresses the result of a rare zip, reverse, rotation, or hand-built permutation without permanently growing the execution language. The planner computes safe moves and reports the actual residual state.

Interleave, if later justified, should first be implemented as a pure order-producing helper whose output feeds `setOrder`; it should not own a separate mutation engine.

## 26. Recommended AI and MCP exposure refinement

### 26.1 Canonical representation and optional selection programs

The versioned typed selector remains the canonical semantic representation. Simple model calls SHOULD use shallow inline discriminated selectors.

Before freezing the complex AI-facing schema, evaluate a bounded acyclic step program as an alternative authoring profile:

```json
{
  "steps": [
    {
      "id": "redGroups",
      "op": "selectGroups",
      "scope": { "kind": "allWindows", "browser": "chrome" },
      "where": { "field": "color", "op": "eq", "value": "red" }
    },
    {
      "id": "redTabs",
      "op": "members",
      "from": "redGroups",
      "resultKind": "tab"
    },
    {
      "id": "muted",
      "op": "filterTabs",
      "scope": { "kind": "focusedWindow" },
      "where": { "field": "muted", "op": "eq", "value": true }
    },
    {
      "id": "result",
      "op": "union",
      "inputs": ["redTabs", "muted"]
    }
  ],
  "output": "result"
}
```

The program is pure dataflow, not a mutation script. Step IDs are unique, references point only backward, operators remain discriminated and typed, and one output is declared. It can preserve internal references as a DAG rather than exponentially expanding repeated expressions.

This form may be easier for models to validate, repair, cache, and explain than deeply nested recursive JSON Schema. It also adds another authoring profile, so it SHOULD be adopted only if the cross-engine evaluation in section 22.5 demonstrates a material improvement. Both forms must normalize to the same semantic selector IR.

### 26.2 Risk-coherent public tools

The two-tool proposal in section 12.3 is elegant internally but problematic as a public MCP contract. A single `arrange_tabs` tool can dry-run, reorder live tabs, reconstruct copies, close sources, or apply a mixed end state. MCP annotations are static per tool, so one definition cannot accurately characterize all those risk classes.

Recommended phased public surface:

```text
select_tabs       read-only selection and compact inspection
plan_tab_change   read-only normalization, dry-run, risk and impact analysis
apply_tab_layout  same-domain live layout plans only; never copy, cut, or close
copy_tabs         additive reconstructive transfer; sources remain
cut_tabs          explicitly destructive reconstructive transfer
```

Existing focused tools remain useful. A bulk `close_tabs` should remain explicitly destructive and separate from general actions if added.

Internally, all mutation paths may use one planner, operation journal, and `applyPlan()` implementation. The split is a public safety and discoverability boundary, not duplicated business logic.

`plan_tab_change` accepts an inline selector, a materialized `selectionId`, or a declarative partial end state. It returns an immutable `planId`, `riskClass`, `requiredExecutor`, capability assumptions, expected effects, and warnings. `apply_tab_layout` accepts only a plan classified as live layout. Mixed live/reconstructive end states remain possible internally but SHOULD require explicit executor lanes rather than smuggling destructive work through a safe-looking tool.

Exact annotation values must be checked against the target MCP host's current interpretation, but every tool must have a title and truthful `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`. Conservative annotations are preferable to understating risk.

### 26.3 Materialized records and resources

Do not overload one identifier with several meanings:

- `selectionId` is an immutable, short-lived materialized set bound to one snapshot revision;
- a future saved live query is a `selectorDefinitionId` and re-evaluates by design;
- `planId` binds selection, destination/intent, revision, risk, preconditions, capability assumptions, and expiry;
- `operationId` identifies attempted execution, per-effect outcomes, cancellation point, final observation, and residual plan.

Large details can be exposed through resources such as:

```text
browser-tab://snapshots/{snapshotRevision}
browser-tab://selections/{selectionId}
browser-tab://plans/{planId}
browser-tab://operations/{operationId}
browser-tab://operations/{operationId}/residual
```

Tool results should still include a compact structured and text fallback because resource-link handling differs across hosts. Supporting `resource_link` blocks will require widening the current `mcp-kit` content union beyond text and image.

Most selections and moves should remain synchronous. MCP task/progress support is appropriate only for operations predicted to exceed the normal call budget, such as large reconstructive transfers or end-state application, and only after capability negotiation. Cancellation does not mean rollback: operation results must distinguish cancellation before mutation from cancellation after partial mutation.

Before bulk execution, the handler context should grow beyond `(input, signal)` to carry the snapshot token, client capabilities, progress, operation journal, and cooperative cancellation. A timeout while underlying mutation continues is unacceptable without durable reconciliation.

### 26.4 Model-facing evaluation, not schema intuition

The final tool split and complex-selector form are hypotheses. Build a deterministic fake-browser corpus comparing:

- the original two-tool surface versus risk-coherent tools;
- recursive selectors versus bounded step programs;
- inline selectors versus materialized selections;
- direct execution versus plan-first execution.

Measure first-tool correctness, syntactic validity, semantic selection correctness, repair turns, schema-token cost, accidental destructive intent, stale-snapshot handling, completion, residual correctness, and latency across supported model families. Include adversarial tab titles as untrusted data, ambiguous scopes, multi-browser selections, unavailable capabilities, retries, and partial transfer.

MCP Inspector verifies protocol behavior; it does not prove that a model understands the language.

## 27. Extraction boundary and wider platform direction

The reusable seam should be extracted, but this browser specification should not become a universal application-control specification.

The first shared package SHOULD be one cohesive package with a working name such as:

```text
@george43g/control-language
```

It owns selector types, ordered-view evaluation, signed positions/ranges, same-kind algebra, explicit projections, branch provenance, normalization, limits, validation, synthetic fixtures, and property tests. It does not initially own daemons, persistence, MCP tools, browser live-move policy, tmux effects, or a universal transformation hierarchy.

The first domain package can remain cohesive:

```text
@george43g/browser-control
```

It binds browser predicates, destinations, live-move domains, the browser effect IR, empty-window/group/pin policy, planning, and reconciliation. A future tmux product should challenge the selection abstraction before generic runtime or adapter packages are extracted.

The wider monorepo/product/package analysis, tmux correction and opportunity, terminal-adapter boundaries, process-versus-tool-surface distinction, security model, phased extraction, and research plan live in [Deep Application Control Platform Architecture](./deep-application-control-platform-architecture.md).
