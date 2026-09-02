# DSL staged tail — deploy loop, operation journal, end-state solver, eval corpus, resources

**Date:** 2026-09-03 (clock-verified)
**Status:** ACTIVE plan — executes the Phase 3 plan's "Staged out" list plus George's
2026-09-03 deploy-automation directive. Go-ahead given 2026-09-03 (adaptation record,
"Post-§5 decisions").
**Depends on (merged):** Phase 3 complete at v1.9.0, deployed live 2026-09-03
(`1.9.0+154.f04db06`, checkpoint #19).
**Bound by:** the §7 edge-policy freeze and rulings R1–R8 (adaptation record), spec
§11/§14/§15/§16/§26, and the closed §5 answers: Q2 no npm, Q3 Claude-only eval.
This is the LAST implementation cycle of the DSL workstream — B26 (George's
feature-set completeness review: docs pass + full tool exploration) fires when it ends.

## Shape — five PRs, dependency-ordered (letters continue Phase 3's)

**PR-H — `deploy:local` + auto-on-main (George's directive, ruled shape):**

- `scripts/deploy-local.mjs` (Node wrapper — `cmd.exe`-safe per platform rules):
  refuse off-main (loud `--allow-branch` override) → `pnpm build` → `daemon restart`
  → poll `daemon status` until reachable AND its `build` field carries
  `git rev-parse --short HEAD` (the doctor's-build-line trap, automated) →
  `reload-extension` for each browser listed in `status.extensions` → re-assert
  reconnection → one-line verdict. Idempotent; no daemon installed ⇒ skip with a
  sentence, exit 0.
- Auto-trigger: `.githooks/post-merge` (pre-push's sibling) runs it ONLY when on
  main AND the merge touched build inputs (`git diff-tree ORIG_HEAD HEAD` under
  `apps/|packages/|scripts/` — a docs-only pull must not restart the daemon). The
  hook is ADVISORY: always exits 0; a failed deploy prints loudly but never breaks
  a pull.
- Tests per the build-rust-optional pattern (manufacture worlds via PATH/env):
  branch gate, docs-only skip, build-line mismatch detected, missing-daemon skip.
  Root `deploy:local` script; README documents the loop.

**PR-I — operation journal, undo records, conflict modes:**

- `operationId` minted per apply/copy/cut execution; durable rotated-ndjson record
  under `journalDir()` (§26.3 identifier semantics, §15 content: normalized request,
  planId/selectionId, per-effect outcomes, cancellation point, final observation,
  residual). Additive fields only.
- Undo RECORDS per §15, no undo tool (recorded staging — not in the accepted list):
  pre-state for same-domain moves/permutations, created-ids for copy, an explicit
  `liveStateUnrecoverable: true` marker for cut. The record distinguishes
  restoration from reconstructive compensation; an executor can come later.
- `conflict: "replan" | "best-effort"` on `apply_tab_layout` (default stays
  `"error"`): `replan` re-resolves the ORIGINAL selector + transform against the
  fresh snapshot and applies iff riskClass is unchanged — replan budget 1, then
  error; `best-effort` applies effects whose preconditions still hold, skips + reports
  the rest. Both stamp the operation record with what they did.
- Read surface: CLI `operations` + IPC method only — NO new MCP tool (models already
  get per-operation results inline; the MCP-visible form is PR-L's resources).
  Recorded staging, interface-parity map untouched.

**PR-J — declarative end-state solver (§11):**

- `plan_tab_change` gains `endState` — exactly one of `transform` | `endState`
  (`.strict()` discriminated). Partial default, `strict: true` per §11.1; §11.2
  transport policy verbatim: cross-domain placement MUST declare
  `transport:"copy"|"cut"`; `auto` resolves to move-within-domain or copy-across and
  NEVER cut.
- Solver in-app (`src/select/plan/endstate.ts`, R1 — extract only with a second
  consumer): assignment/group constraints first, then per-window ordering via the
  EXISTING LIS machinery (`order.ts`); §11.4 cost order 1–5 documented in the module
  header; result wording "minimal under declared cost model", never bare "minimal".
- **Mixed-transport ruling (new policy — reviewers challenge here):** the solver
  DECOMPOSES a mixed request into up to three sub-plans — live-layout / additive /
  destructive — each with its own `planId` + risk, ordered and cross-referenced in
  the parent result. `apply_tab_layout` still applies ONLY live-layout plans;
  `copy_tabs`/`cut_tabs` gain an optional `planId` input to execute their halves, so
  authorization stays where it lives (§26.2 risk-coherence intact; cut still demands
  schema-level `confirmDestruction`).
- Dry-run detail per §11.5 (ordered ops, live-vs-reconstructive counts, expected
  identity mapping, applicability). e2e: dual-truth spec — declare a two-window end
  state, apply the live-layout sub-plan, verify browser truth + empty residual;
  run-guard floor bumps.

**PR-K — model-facing eval corpus (Claude-only, Q3 closed):**

- Deterministic fake-adapter scenarios per §26.4's still-live comparisons: inline
  selector vs materialized selection, direct vs plan-first, simple vs complex
  selector forms; adversarial titles as untrusted data, ambiguous scopes, stale
  tokens, unavailable capabilities.
- Runner drives Claude via API when a key is present, skips cleanly otherwise
  (sweep-macos precedent: committed REDACTED baseline report — metrics, never tab
  content). Metrics: first-call schema validity, semantic selection correctness vs
  oracle, repair turns, accidental destructive intent. Not a CI gate.

**PR-L — MCP resources + `resource_link` (EVIDENCE-GATED, upstream-dependent):**

- Gate first, build second: measure real inline payload sizes (the live 100-tab
  select, a 99-effect plan, an operation record) and record them. If inline fits
  comfortably, DEFER the PR and close this row with the numbers — §26.3's own
  condition ("after the tools prove their result payloads are too big inline, not
  before").
- The content-union widening (text | image → + resource_link) lands DIRECTLY in the
  workspace `packages/mcp-kit` — it is not one of the published npm kits
  (adaptation record §2, verified: "no upstream brief needed for it"; the
  Phase-anterior `toContent`/image widening already landed there the same way).
  cli-kit's `ToolCallResult` mirrors the union, so check whether the REPL narrows
  cleanly on the new member — THAT half is upstream if it breaks. App-side:
  `browser-tab://` resources for snapshots/selections/plans/operations(+residual),
  compact inline fallback always retained.

## Standing gates (every PR)

Tests per surface (George's rule), effect-coverage ledger rows + contract test,
stress cases for new dispatch behavior, `.env.example` same-commit for new env,
README where user-visible, §7 freeze binding on every schema change, additive-only
wire changes (Snapshot `version` stays 2).

## Risks named

- The post-merge hook runs on George's real machine on every main pull: it must be
  advisory (exit 0 always) and docs-only-aware, or it breaks the pull UX it serves.
- Replan is a write-path loop: budget 1, stamped in the operation record — an
  unbounded replan against a busy browser is a spin.
- The mixed-transport decomposition is the one place this plan ADDS policy beyond
  the spec's letter; it is flagged for review rather than smuggled.
- Eval-corpus API cost is real money: the runner must print its planned call count
  and refuse over a ceiling env (`BROWSER_TAB_EVAL_MAX_CALLS`).

## Staged out of this cycle (deliberately, recorded)

- Undo EXECUTOR (records only, above).
- `selectorDefinitionId` saved live queries (§26.3) — no consumer yet.
- MCP task/progress for long operations (§26.3) — only after capability negotiation
  exists in a real host we target.
- B23 (cache-file vanish) — separate fix, not DSL work; stays a backlog row.
