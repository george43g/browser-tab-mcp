# Selection-DSL workstream — adaptation record and phase map

**Date:** 2026-09-02 (clock-verified)
**Status:** ACTIVE — this is the binding adaptation of the two planning artifacts to this codebase.
**Inputs:** `docs/tab-selection-transformation-language-spec.md` (canonical spec, §1–27) and
`docs/deep-application-control-platform-architecture.md` (architecture companion), both accepted
by George on 2026-09-02 with the instruction that they are **not gospel**: *"they were designed
with limited context as to the existing source code and tool — you need to adapt those plans and
the ultimate spirit of those ideas in the best way to this source code."*
Where this record and those documents disagree, this record is the implementation's authority,
and each disagreement is stated explicitly below with its reason.

## 1. Decisions George accepted (verbatim anchors, 2026-09-02)

These came in his kickoff message and are settled — do not re-litigate:

- "Whole-window and multi-window tab selection is supported explicitly."
- "Any tab-valued selector can combine with any other tab-valued selector. Windows and groups
  require explicit member projection first."
- "A+B → C movement is valid within one live-move domain."
- "Multi-browser selections remain queryable, but live movement is blocked during preflight;
  copy/cut remain available."
- "Interleave, distribute, shuffle, rotate, and similar transforms are deferred. setOrder
  provides the simpler escape hatch."
- "Recommended architecture: one evolving monorepo, separate browser/tmux domain products, and
  initially only one generic package: @george43g/control-language."
- "Recommended MCP surface: select_tabs, plan_tab_change, apply_tab_layout, copy_tabs, and
  cut_tabs."
- "Tmux uses ordered graph projections … it should not be forced into a browser-shaped tree."

This closes BACKLOG **B10**'s user gate: the reduced transform set, the phased five-tool MCP
surface, the `control-language` name, and the browser/tmux product boundary are all accepted.

## 2. Baseline delta verified 2026-09-02 at `b9b1397`

The spec's §18 baseline was verified at `6bbe796`; re-checked today:

| Claim | Status today |
|---|---|
| `move_tab` requires explicit `targetWindowId` for same-window; `targetIndex` 0-based `min(0)` | Still true (`packages/shared-types/src/tools.ts:124-136`) — being fixed now (Phase 0.d below) |
| `Snapshot.version` is contract-schema version `2`, not a state revision | Still true — revision work in flight (Phase 0.a) |
| `TabActionInputSchema` / `GroupTabsInputSchema` are optional-field bags | Still true (`tools.ts:199-207`, `:211`) — the NEW language schemas use discriminated variants; retrofit of the old tools is deliberately out of scope |
| MCP resources exist (health/dev logs) | Confirmed (`packages/mcp-kit/src/resources.ts`, URI templates supported) — extend, don't reinvent |
| mcp-kit `ContentBlock` is `text \| image` | Confirmed (`packages/mcp-kit/src/tool-registry.ts:23`) — `resource_link` widening is a Phase 3 item |
| Registry ~20 tools | Confirmed (tool files under `apps/browser-tab-mcp/src/tools/`) |

`mcp-kit` is a **workspace** package (not one of the published npm kits), so tool-annotation and
content-union work lands here directly — no upstream brief needed for it.

## 3. Adaptation rulings (where implementation diverges from the documents, and why)

**R1 — Browser binding starts in-app, not as `packages/browser-control`.** The architecture doc
proposes extracting `browser-control` as the second package. Ruling: the browser binding
(node kinds, field catalog, live-move domains, effect IR, planner) is implemented under
`apps/browser-tab-mcp/src/select/` first and extracted to a package only when a second consumer
(tmux spike or TUI-as-separate-app) exists. Reason: the doc's own anti-abstraction rules ("do not
create micro-packages merely to make `apps/` small"); extraction later is cheap, un-extraction is
not.

**R2 — `move_tab` gains additive `to` (signed one-based) and `by` (relative) fields;
`targetIndex` keeps its exact current semantics as legacy.** The spec says move_tab "SHOULD gain
signed absolute positions"; repurposing the existing 0-based `targetIndex` would break the wire
contract and violate the spec's own "a field has one meaning and one type" rule. Exactly one of
`targetIndex | to | by` per call, enforced at schema validation.

**R3 — Live-move domain v1 is derived from what already determines movability.** The contract has
no profile identity today (spec §23.1 gap 3). v1 model: a live-move domain exists per connected
extension session, partitioned by incognito boundary — because `move_tab` is extension-only
already and `chrome.tabs.move` cannot cross the incognito boundary. AppleScript-only browsers
expose no live-move domain (their `moveTab` already refuses). This is runtime-probed truth, not
browser-name inference, and it upgrades transparently when profile identity lands later. The
richer instance/profile model is deferred to Phase 2 design, recorded as open.

**R4 — Temporal fields come from the journal with `unknown: "exclude"` as default.** §7.6's field
catalog is partially present (journal focus/nav events, `lastAccessed` enrichment, `navEpoch`).
Phase 2 materializes per-tab `lastFocusedAt` / `lastNavigatedAt` for the resolver; a predicate
over an unavailable field excludes the member and reports it, per §24.6's rule that
`not visited within 3d` must not include unknowns.

**R5 — Tool rollout order within the accepted five-tool surface:** `select_tabs` (pure read)
ships first and alone in its PR; then `plan_tab_change` (read-only planning); then
`apply_tab_layout` (live-layout plans only); then `copy_tabs`; then `cut_tabs` (explicit
destructive authorization). One internal planner under all of them. Catalog grows 20 → 25;
spec §23.1 item 6 says that is workable.

**R6 — Model-facing schema evaluation (§26.4) is scoped to what we can run.** The deterministic
fake-browser corpus gets built (it reuses `BROWSER_TAB_FAKE_ADAPTER` + test-kit fixtures) and run
against the Claude family before schema freeze. The full cross-provider matrix (OpenAI/Gemini/
local) is George's call — it needs accounts and spend (open question Q3).

**R7 — The step-program authoring profile (§26.1) is NOT built in v1.** Inline recursive
selectors (shallow for common cases) are the only authoring profile until the eval evidence says
otherwise. The semantic IR keeps room for it.

**R8 — Deferred transforms stay deferred exactly as accepted:** no `interleave`, `distribute`,
`shuffle`, `rotate`, general `partition`, or arbitrary pairwise swap schemas in v1. `setOrder`
(§25.3) is the escape hatch. `swap` ships as a compiled convenience (explicitly requested
feature, §25.2). `pack`, stable `sort`, `reverse`, group-by-predicate compile to the effect IR.

## 4. Phase map

Workstreams are PR-sized and dependency-ordered. "In flight" = dispatched 2026-09-02 during the
boosted-limits window, four parallel worktree agents.

| # | Workstream | Status | Notes |
|---|---|---|---|
| 0.a | Snapshot `revision` + opaque `snapshotToken`, additive; `version` stays 2 | **in flight** | spec §23.1 gap 1 |
| 0.b | B21 partition-vs-iterate audit (folded in per standing instruction) | **in flight** | BACKLOG B21 acceptance criteria verbatim |
| 0.c | Edge-policy freeze table (§24.6) | **done — §7 below** | binding on every schema/planner PR |
| 0.d | `move_tab` signed/relative/same-window conveniences (R2) | **in flight** | wire-compatible |
| 1 | `packages/control-language` — pure selection core, property-tested | **in flight** | architecture §13 Phase 1 scope exactly |
| 2 | Browser binding in-app (R1): node kinds, field catalog, temporal fields (R4), live-move domains (R3), materialized selections + revision binding | queued | needs 0.a + 1 merged |
| 3 | Planner + browser effect IR + `setOrder`; risk-coherent tools in R5 order; resources for selections/plans/operations; `resource_link` content widening; fake-browser eval corpus (R6) | queued | needs 2 |
| 4 | TUI/console operator-motion integration | queued | compiles to the same AST; no private semantics |
| 5 | tmux spike (`apps/tmux-control`) | parked | separate George conversation before starting |

Every phase carries the repo's standing gates: tests per surface (George's rule), README,
`.env.example` for new env, effect-coverage ledger rows + contract test, stress cases for new
tools, e2e where the surface has a real-browser pathway.

## 5. Open questions for George

- **Q1 (carried from the 2026-08-21 parking):** he had "one more addressing/selection/movement
  mode he forgot — never identified." The accepted spec covers: identity (ids/slugs/aliases),
  absolute signed positions/ranges/slices, relative offset/expand/between/siblings, predicates
  (metadata + temporal), recency ranks, set algebra, per-branch `withinEach` vs `flatten`,
  whole-window/group member projection, and declarative end-state. He should scan that list for
  the missing mode.
- **Q2:** `@george43g/control-language` — private workspace package for now, or published to npm
  from day one? (Publishing is a distribution decision this repo has deliberately kept manual.)
- **Q3:** cross-provider model eval (R6) — Claude-only, or fund the full matrix?
- **Q4:** tmux spike timing — Phase 5 exists on the map but does not start without a separate
  go-ahead.

### §5 answers (2026-09-02, George)

- **Q1 CLOSED** — George: *"dsl-forgotten-mode - yes"*. Read as: the accepted
  selector set covers the addressing mode he forgot in August; the carried
  check from the 2026-08-21 parking is satisfied. (If "yes" meant something
  else, this is the line to correct.)
- **Q2 premise corrected, decision still his** — George: *"hmm.... arent we
  already public and published?"* Measured answer: the REPO is public, but
  nothing from this repo is on npm — `npm view @george43g/browser-tab-mcp`
  and `@george43g/control-language` both E404 while `@george43g/robustness`
  resolves (so not a network artifact). Release-please versions without
  publishing by deliberate design (no publish step in release.yml). Note the
  README's install section advertises `npm install -g
  @george43g/browser-tab-mcp` and wears an npm badge — instructions that
  404 today. Publishing vs. correcting the README is one decision, his.
- **Q3/Q4** — still open (model-eval scope; tmux timing).

## 6. Traps carried into this workstream

- Snapshot schema `version` must never be bumped for additive fields; revision ≠ version (0.a
  asserts version===2 in tests).
- The extension pushes post-command snapshots immediately; planners must still verify with
  settled reads (`tabs.move` echo lies — existing discipline, spec §18 confirms).
- Group `create` must pin `windowId` (2026-08-20 mass-move bug) — the planner inherits this rule.
- Capability truth is runtime-probed; never branch on browser name (contract invariant 2).
- `handles are not uniformly stable` (spec §23.1 gap 2): materialized selections are
  snapshot-bound, never durable identity, until an identity layer exists.

## 7. Edge-policy freeze (§24.6) — binding defaults

Frozen 2026-09-02. Every schema and planner PR implements these exactly; changing one is a
recorded decision, not a drive-by.

| Policy | Default | Alternatives (explicit) | Reason |
|---|---|---|---|
| `emptySelection` | queries: valid empty result; mutations: **error** | `"noOp"` | §24.6's own recommendation; an empty mutation is usually a selector mistake |
| Position bounds | **clamp** | `bounds: "error"` | §5.1 verbatim |
| `emptySourceWindows` | **error** | `"close"`, `"keepWithNewTab"` (side effect disclosed) | §24.3; TUI "merge windows" convenience compiles to `close` after preview |
| Destination anchor inside the moved selection | **error** with hint | none in v1 | ambiguous post-move meaning; revisit only with a stable-gap rule |
| Anchor/selection member vanishes between resolve and apply | index-sensitive or destructive ops: **conflict error**; identity-based non-destructive ops: skip + report per item | `conflict: "replan"`, `"best-effort"` per §14.1 | splits along the spec's conflict-policy line; the skip+report half follows the existing `group_tabs` `skippedTabIds` precedent |
| Pin-region crossing | **error** | `pinPolicy: "unpin-first" \| "skip"` | §14.3: silent policy invention forbidden |
| Group preservation on member movement | **tabsOnly** + warning naming the groups left behind | `"preserveGroupsWherePossible"`, or a declarative end state | §24.3 |
| Unknown temporal field value | **exclude** + count reported in resolution metadata | `unknown: "include" \| "error"` | §24.6's `not visited within 3d` rule; ruling R4 |
| `evaluationTime` | frozen once per resolution, echoed in resolution metadata | none | §24.6 |
| Non-reconstructable URLs in copy/cut (chrome://, about: internals, file:, extension pages) | **skip + per-item outcome**; cut never closes a source it could not reconstruct | `"error"` for strict callers | §9.4 already mandates the source-stays-open half; skip+report is the honest bulk default |
| Branch order across instances/windows | directly-listed selectors: caller order; predicate-selected: snapshot tree order as the merge layer emits it, pinned by a contract test | explicit `sort` | §24.2: raw browser API array order must not be assumed — the contract test is what makes our order a fact |
