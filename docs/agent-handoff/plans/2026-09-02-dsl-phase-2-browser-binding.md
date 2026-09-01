# DSL Phase 2 — browser binding, materialized selections, `select_tabs`

**Date:** 2026-09-02 (clock-verified)
**Status:** ACTIVE plan — executes adaptation-record §4 rows 2 and the first slice of row 3
(`select_tabs` moves from Phase 3 into this phase as the binding's verification surface;
a binding with no consumer cannot be effect-verified, and `select_tabs` is pure read).
**Depends on (merged):** #132 snapshot revision, #136 `@george43g/control-language`.
**Bound by:** adaptation record §3 rulings (R1 in-app, R3 domain model, R4 temporal) and
§7 edge-policy freeze. This plan adds no new policy.

## Shape

Two PRs, dependency-ordered:

**PR-A — the domain binding (pure, no daemon coupling):** `apps/browser-tab-mcp/src/select/`

- `browser-ref.ts` — `BrowserRef`: discriminated union over the four kinds
  (`browser` | `window` | `group` | `tab`), each carrying its snapshot node + the parent
  chain needed for `parentOf`/`siblingsOf` without re-walking. `stableKey` = the existing
  opaque handles verbatim (browser id / `windowId` / `groupId` / `tabId`) — no new id scheme.
- `browser-domain.ts` — `makeBrowserDomain(snapshot, opts)` → `SelectionDomain<BrowserRef>`.
  - Scopes (named, finite): `allBrowsers`, `allWindows`, `allGroups`, `allTabs`,
    `focusedWindow` (via `focusedBrowser` + `window.focused`; empty when unknown — an empty
    scope is legal at resolve level per #136), `tabsInFocusedWindow`.
  - Relations (explicit projection): `windows` (browser→), `groups` (window→),
    `tabs` (window→, visual order), `members` (group→ member tabs, window order filtered by
    `groupId`).
  - Field catalog (typed): `title`, `url`, `scheme`, `host`, `domain` (registrable via the
    simple two-label heuristic — document the limitation, no PSL dep), `path`, `browser`,
    `windowId`, `groupId`, `index`, `pinned`, `active`, `audible`, `muted`, `discarded`,
    `grouped`, `incognito` (window-inherited), `lastAccessed`; window kind: `focused`,
    `state`, `incognito`; group kind: `title`, `color`. URL parts derive from the redacted
    url already in the snapshot.
- `temporal.ts` — R4: optional `TemporalProvider` (`lastFocusedAt`/`lastNavigatedAt` per tab
  handle) sourced from the journal's in-memory session state, injected by the daemon;
  absent provider ⇒ fields read `undefined` ⇒ §7 `unknown: "exclude"` applies in
  control-language. The binding never opens journal files itself.
- `domains.ts` — R3: `liveMoveDomainId(ref)` = `null` unless the tab's browser is
  extension-connected; else `ext:<browser>:<normal|incognito>`. Pure derivation from
  snapshot fields (`extensionConnected`, `window.incognito`) — runtime-probed truth only.
  Exposed as resolution metadata, not a field predicate (Phase 3 preflight consumes it).
- Tests: unit, colocated — domain over `make*` fixtures; contract test pinning branch order
  (§7 policy row: predicate-selected windows follow snapshot tree order) and pinning that
  every declared field name resolves on a fully-populated fixture tab (the selector-not-
  result rule: a typo'd catalog entry must fail here, not read as always-undefined).

**PR-B — materialized selections + the `select_tabs` tool:**

- `daemon/selections.ts` — `SelectionStore`: `materialize(resolved, snapshotToken)` →
  `selectionId` (8-hex random), LRU ≤64, expiry 5 min OR any snapshotToken change
  (whichever first; spec §26.3 — snapshot-bound, never durable identity). `get(id)` returns
  the record + `stale: boolean` (current token ≠ bound token). IPC method `getSelection`.
- `tools/select-tabs.ts` — `select_tabs {selector, projection?}`:
  - `selector`: the control-language `TabSelector` JSON (shallow inline for common cases);
    validated by the package's schemas; its actionable `E_*` errors pass through `wrapToolError`.
  - `projection`: `"core"` (default — tab rows as list_tabs core) | `"ids"` | `"count"`.
  - Result: rows per projection + `resolution` metadata (snapshotToken, order provenance,
    warnings, per-browser live-move-domain ids, `selectionId`).
  - Read-only annotations (`readOnlyHint: true`, `openWorldHint: false`), `timeoutMs: 15_000`.
  - Daemon-only (needs the merged snapshot + journal temporal provider): degraded/no-daemon
    ⇒ actionable "start the daemon" error, like `journal`.
- Surfaces: CLI `browser-tab select --selector <json|@file|->` (lossless JSON in, `--json`
  out) — `.usage.kdl` + regenerated completions/man/docs (check:usage gate); REPL free.
- Ledger: new `select_tabs` row, `chromium-e2e` tier; e2e spec asserts a predicate
  selection and a signed-position selection against BOTH the daemon result and
  `chrome.tabs.query` truth; run-guard `EXPECTED_MIN_TESTS` bumps. Stress: schema-reject +
  fake-adapter clean-error cases join case 12's family. README Tools table + annotations note.

## Non-goals (deferred exactly per the map)

No mutation, no planner, no `plan_tab_change`/`apply_tab_layout` (Phase 3); no
`selectorDefinitionId`; no MCP resources for selections yet (needs the `resource_link`
content widening — Phase 3); no browser-control package extraction (R1).

## Risks named

- The control-language `SelectorEnvelope` recursion limits must hold at the MCP boundary —
  the tool passes input through the package validator BEFORE any snapshot work.
- `domain` (registrable) via two-label heuristic is wrong for co.uk-style suffixes;
  documented as approximate, revisit only with demand (YAGNI, no new dep).
- Selection store is in-daemon memory: restart invalidates ids — correct by design
  (snapshotToken changes too), stated in the tool description.
