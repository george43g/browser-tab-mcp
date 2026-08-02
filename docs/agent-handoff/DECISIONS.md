# Decision log

Append-only. Each entry: date · decision · why. Never rewrite old entries —
if a decision is reversed, append the reversal.

- **2026-07-19 · Daemon + connector-extension architecture.** Research
  conclusion (don't re-derive): AppleScript alone cannot state-preserving-move
  Chromium tabs; Safari has no stable AppleScript tab ids (synthetic
  `t:safari:w<win>:i<idx>` handles instead); Safari Web Extensions can't be
  distributed outside the App Store but personal Xcode builds work fine.
  Hence: osascript polling baseline + extension for live events/true moves.

- **2026-07-19 · No AI in-tool.** browser-tab is a perception/actuation API;
  the consumer AI interprets. `annotate` exists as a cache substrate for a
  consumer's own notes — never generates content itself.

- **2026-07-20 · Merge authority = socket liveness, NOT snapshot age.** The
  extension pushes snapshots only on events (no heartbeat); age-gating made an
  idle-but-connected browser silently revert to AppleScript handles and routed
  `move` down the state-losing path. Never re-gate the merge on snapshot age.
  (`AGENTS.md` § "Extension–daemon merge".)

- **2026-07-21 · Own repo + JSON/socket contract seam** (vs merging into a
  wm-stack monorepo). The stack is polyglot; the language-agnostic contract is
  the feature. Full rationale + revisit condition: `docs/FOLLOWUPS.md` §3.

- **2026-07-22 · Contract v2 rules.** New tab/window fields are
  additive-optional — NO `version` bump for them. Capabilities are
  runtime-probed (extension `hello` / static AppleScript map), never
  hardcoded by browser name. Enrichment fields are single-authored in
  `TabEnrichmentSchema` + copied via `pickEnrichment` (field-parity tests
  go red if a mapper drops one).

- **2026-07-23 · `history` is a separate tool from `journal`.** Durable
  browser URL history vs session focus-memory — different lifetimes, different
  sources; merging them would conflate cache-busting and recall semantics.

- **2026-07-25 · Cleanup pass order C→B→A→D** (user override of the proposed
  A→B→C→D): "I don't want to refactor after deploying… because I'll need to
  deploy again after" — all code work first, deploy exactly once. B before A
  so the risk tests are a safety net under the shared-types split.

- **2026-07-25 · Scope locks for the cleanup pass** (user choices):
  A = shared-types split + lint ONLY (daemon/index.ts, adapters, cli.ts stay —
  they're cohesive modules, not barrels). B = 5 risk targets;
  `COVERAGE_GATE` stays OFF.

- **2026-07-25 · Global bin does NOT ship the native `.node`** (PR-C).
  Accepted degradation: correlation falls to tier-2 yabai, which preserves the
  cgWindowId join; only z-order/display-targeting/screencap-preflight degrade.
  Restoring native on global installs is a parked follow-up (BACKLOG item 4).

- **2026-07-26 · PR-B tests live in `tests/`, not colocated `src/`** so a
  tests-only PR doesn't trip the readme-check CI gate. (General taxonomy in
  `AGENTS.md` still applies to future tests.)

- **Standing workflow (user-set, applies to all future work):** one PR per
  workstream · each independently green · squash-merge with a
  conventional-commit title · **merge only on the user's explicit say-so** ·
  signed commits (1Password SSH).

- **2026-07-29 · launchd daemon stays on the WORKSPACE build** (user choice
  during PR-D; `daemon install` deliberately NOT run). Keeps the native
  correlation tier and the Automation TCC grant already given to that binary
  path — no re-prompt, no `-1743` risk. Cost: `browser-tab daemon restart`
  after every rebuild. The global bin was installed for CLI convenience and,
  because `pnpm add -g <path>` links rather than copies, it loads native too.

- **2026-07-29 · The `cgWindowId` tiling defect gets its own PR, not a hot-fix
  during PR-D.** It changes the correlation core (a pure, unit-tested
  function) and needs fixtures + sabotage checks; bundling it into a deploy
  checklist would have shipped an untested guess. Filed as BACKLOG item 1.

- **2026-07-27 · Handoff docs live in-repo** (`docs/agent-handoff/`), not in
  agent memory — multiple agents (Claude ↔ Codex) rotate on this work and
  cannot read each other's memory.
