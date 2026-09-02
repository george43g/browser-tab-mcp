# DSL Phase 3 — planner, effect IR, and the four mutation tools

**Date:** 2026-09-02 (clock-verified)
**Status:** ACTIVE plan — executes adaptation-record §4 row 3.
**Depends on (merged):** Phase 2 complete at v1.7.0 (#141 binding, #143 select_tabs).
**Bound by:** the §7 edge-policy freeze and rulings R1–R8 (adaptation record), plus spec
§9/§14/§15/§25/§26. This plan adds no policy; where it stages the spec, the staging is stated.

## Shape — five PRs, dependency-ordered

**PR-C — effect IR + pure planner (`src/select/plan/`):**

- Effect IR per spec §25.1, browser-specific and bounded: `relocate` (live identities →
  destination gap), `setOrder` (within one ordered parent), `createReconstructed`,
  `closeVerified`, `setMetadata` (group title/color; pin), `act` (bounded capability-declared
  tab action). No universal transformation hierarchy (anti-abstraction rules).
- Plan model: `planId`, bound `snapshotToken`, resolved selection (keys + kinds), ordered
  effects, preconditions, warnings, `riskClass: "live-layout" | "additive" | "destructive"`,
  `requiredExecutor` (§26.2) — the classifier is what keeps `apply_tab_layout` unable to
  smuggle destructive work.
- Transform planning: block `move` (destination slot/anchor per §5.4 — selectors and
  destinations resolve against the same pre-op snapshot, gap mapped through surviving
  neighbours), `setOrder` with LIS-based minimal moves per window (§25.3), and the §25.2
  compiled conveniences: `swap` (block mode), `pack`, stable `sort`, `reverse`,
  group-by-predicate. Deferred transforms stay deferred (R8).
- §7 policy table enforced AT PLAN TIME with stable codes: emptySelection error,
  pin-region error default (`pinPolicy` opt-outs), group-preservation `tabsOnly` + warning,
  destination-overlap error, cross-domain live movement blocked via the §24.5 uniformity
  summary (`cross_domain_live_move`).
- `PlanStore` — same shape as SelectionStore (LRU/TTL/token-bound; stale plans refuse apply).
- **B24 fix**: `focusedWindowHint` option on `makeBrowserDomain`, daemon-injected from
  journal `windowMru(1)`, used only when no window is OS-focused, disclosed as a warning.

**PR-D — `plan_tab_change` (read-only planning tool):** accepts inline selector OR
`selectionId` (stale ⇒ error naming re-select) plus ONE transform; returns the full plan +
`planId` + dry-run detail (§11.5 subset). Read-only annotations; daemon-only like select_tabs.
CLI `plan` subcommand; ledger row (unit tier at first — the plan is pure output), stress
schema/clean-error checks, parity map, registry pin, annotations.

**PR-E — `apply_tab_layout` (live-layout executor):** accepts ONLY a `planId` whose
`riskClass === "live-layout"` — never copy/cut/close (§26.2). Executor translates effects to
live indices in non-invalidating order, drives the EXISTING proven daemon pathways
(`move_tab` absolute form, `group_tabs`, `tab_action`) so the wire and extension stay
unchanged, verifies with settled reads, returns per-effect results + actual final state +
residual (§15 — the intended plan is never reported as the applied state). Conflict:
`expectedSnapshotToken` with `conflict:"error"` default (§14.1); `replan`/`best-effort`
deferred until a caller needs them (recorded staging). Annotations: NOT read-only, NOT
destructive, openWorld false. e2e: dual-truth spec (plan a reorder, apply, verify browser
truth + residual empty); run-guard floor bumps; ledger chromium-e2e evidence.

**PR-F — `copy_tabs` (additive reconstructive):** inline selector or selectionId →
destination (existing window / new window / browser instance); creation through the
url-policy-guarded open pathway; pin/group recreation best-effort with per-item outcomes;
non-reconstructable URLs skip + report (§7 freeze); `idempotencyKey` stored beside the
operation record so a retry names duplicates instead of minting them. Sources untouched by
construction. Annotations: not destructive, openWorld TRUE (it loads URLs).

**PR-G — `cut_tabs` (explicitly destructive):** §9.4 sequence verbatim — create in order,
verify each, recreate metadata as capabilities permit, close ONLY verified sources;
`closeSource:"after-each-success"` default, `requireAllCopiesBeforeClose` option; a required
`confirmDestruction: true` parameter (schema-level, not prose) per §16's explicit
authorization rule. Annotations: destructive TRUE, openWorld TRUE. e2e proves the
source-stays-open-on-failure half with an unreachable destination URL.

## Staged out of Phase 3 (deliberately, recorded)

- **Declarative end-state solver** (§11, §19 item 5): `plan_tab_change` v1 takes selector +
  transform only; the end-state input lands as its own later plan once the transform planner
  has soaked. The spec's assignment/group-constraint solving is real work and the five tools
  are useful without it.
- MCP resources for plans/operations + `resource_link` widening (§26.3): after the tools
  prove their result payloads are too big inline, not before.
- `conflict:"replan"`/`"best-effort"`, undo records (§15), operation journal beyond the
  idempotency record: with the end-state PR.
- Model-facing eval corpus (R6): runs against the frozen PR-C/D schemas before PR-F/G ship,
  Claude-only per R6.

## Risks named

- The executor composes existing single-command pathways, so a multi-effect apply is not
  atomic — §15 already owns this honestly (per-effect results + residual); do not let the
  tool description imply a transaction.
- Same-parent multi-tab moves shift live indices between effects: the §5.4 gap mapping must
  be against SNAPSHOT order with effects emitted in a non-invalidating sequence, and the
  settled verification is what catches drift (the tabs.move echo lies — standing discipline).
- `cut_tabs` + `copy_tabs` traverse the url-policy allowlist for every reconstructed URL —
  a privileged URL in a selection must degrade per-item, never abort the batch after sources
  closed.
