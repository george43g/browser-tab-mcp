# The control surface — a guided tour, and where it stops

Written 2026-09-04 as the input to George's feature-set completeness review
(BACKLOG **B26**, gated on the selection-DSL workstream finishing — it has:
v1.10.1). Its job is to let one person hold the whole surface in mind at once
and answer a single question: **is this feature set complete?**

**Precedence.** This file is a *map*, and maps go stale. The authorities are
`apps/browser-tab-mcp/src/tools/registry.ts` (what tools exist),
`docs/surfaces/effect-coverage.json` (all 37 surfaces and where each is
effect-proven), and `apps/browser-tab-mcp/.usage.kdl` (the CLI, byte-checked by
`pnpm check:usage`). Where this file and one of those disagree, they are right.
The counts here are pinned by test — `tests/docs-integrity.contract.test.ts`
fails if a registered tool has no README row, and
`tests/surface-coverage.contract.test.ts` fails if a surface has no ledger row.

## Six axes of control

Every surface does one of six things. Reading them as axes rather than as an
alphabetical tool list is what makes a gap visible.

### 1. Perceive — what is open, what is on the page, where you have been

`list_tabs` (windows/tabs/groups across five browsers, `cgWindowId` join key,
`fields` projection down to counts-only) · `select_tabs` (resolve a
control-language selector: identity, signed position, predicate, temporal, set
algebra) · `get_page` (metadata / reader-mode text / live state — dirty forms,
media, scroll, selection) · `screenshot` (tab tier via the extension, window
tier via `screencapture -l`) · `journal` (this session's focus and navigation
memory: `windowMru`/`tabMru`/`journey`/`recent`) · `history` (the browser's own
durable URL history, every result carrying `sources` so silence is
distinguishable from absence) · `bookmarks` (search/list) · `daemon_status` ·
`health_check`.

### 2. Arrange — where a tab sits, without losing what it holds

`plan_tab_change` (one transform — `move`, `pack`, `setOrder`, `reverse`,
`sort` — or a declarative `endState` naming windows and their leading runs) →
`apply_tab_layout` (live-layout effects ONLY; anything that closes is refused
here by construction) · `move_tab` (single tab, signed one-based positions) ·
`group_tabs` (Chrome tab groups: create/add/remove/update/move, title, colour) ·
`open_window` / `set_window` / `close_window` (bounds, display, state,
incognito).

This is the axis the selection DSL completed. Arrangement is planned, risk-
classified, applied non-transactionally with honest per-effect outcomes, and
journalled with an undo record.

### 3. Transport — a tab in a place it cannot be moved to

`copy_tabs` (reconstruct at the destination; every source stays open) ·
`cut_tabs` (reconstruct, verify, THEN close — a source whose replacement did
not verify is never closed; requires `confirmDestruction: true`).

Transport exists because live movement has a hard domain boundary: a tab moves
live only within `ext:<browser>:<normal|incognito>`. Across browsers, across
the incognito line, or without the extension, the only honest options are copy
and cut — and `auto` never chooses cut.

### 4. Act — change one tab's state in place

`tab_action` (mute/unmute · pin/unpin · discard · reload · navigate · back ·
forward · duplicate) · `focus_tab` (activate, and unless `raiseWindow:false`
un-minimize and raise, reporting the window's post-state for a WM to act on) ·
`open_tab` · `close_tab`.

### 5. Remember — state the browser does not keep

`annotate` (URL-keyed note cache; a substrate, never intelligence) ·
`operations` (the daemon's journal of every apply/copy/cut, each with a §15
undo record: `pre-state` | `created` | `unrecoverable`).

### 6. Operate — run the thing

`daemon run|install|uninstall|status|token|stop|restart` · `reload-extension`
(deliberately has NO MCP tool: operator-only, unreachable from a model) ·
`doctor` · `repl` · `tui` · `mcp`.

## The boundary, stated deliberately

These are refusals, not gaps. They were decided, and the decision holds until
George reverses it.

- **No window-manager actuation.** browser-tab reports `cgWindowId`,
  `windowState`, `wasMinimized`, `windowFocused` and stops. Spaces, tiling and
  focus-follows policy are yabai's job.
- **No DOM interaction.** `scripting` is granted and used for extraction only.
  Clicking, typing and form-filling are a different tool's job; adding them
  here would put an actuator behind a read-shaped API.
- **URLs are allowlisted, not sanitized.** `javascript:` and `file:` are
  refused by default at `open_tab`/`open_window`/`tab_action navigate` because
  the caller is usually a model that has just read untrusted web content.
- **No AppleScript parity fiction.** The AppleScript path covers
  navigate/reload (+back/forward on Chromium) and window bounds/state; every
  other verb throws a sentence naming the extension as the fix.

## Gaps this pass found — each one a decision for George

Evidence first; verdict is George's.

| # | Gap | Evidence | Why it might matter |
|---|---|---|---|
| G1 | **A selection can be arranged, copied and cut — but never *acted on*.** | `tab_action`, `close_tab`, `focus_tab` take one raw `tabId`; `group_tabs` takes an id list but no `selectionId`. Only `copy_tabs`/`cut_tabs`/`plan_tab_change` accept a selection. | "Mute everything playing audio", "discard every tab I haven't touched today", "close this selection" are all client-side loops today — outside plan/apply, so no risk class, no operation-journal row, no undo record. |
| G2 | **The Effect IR declares `act` and nothing produces it.** | `ActEffect {kind:"act"; action:"pin"\|"unpin"\|"mute"\|"unmute"}` at `apps/browser-tab-mcp/src/select/plan/effects.ts:66`; zero constructors in `src/` (grep). `classifyRisk` already treats it as live-layout. | The IR promises a verb the planner cannot emit. Either wire it (that IS G1's fix, and the classifier is already correct for it) or delete it — a declared-but-unproduced effect reads as a capability. |
| G3 | **Closing has no route back through the browser's own undo.** | Manifest permissions are `tabs, storage, alarms, tabGroups, webNavigation, scripting, history, bookmarks` — no `sessions`. Undo records are `pre-state \| created \| unrecoverable`. | `chrome.sessions.restore` is the one mechanism that can bring back a closed tab *with its history*. Without it, `cut_tabs`/`close_tab`/`close_window` are recoverable only as far as a re-open from URL. |
| G4 | **Downloads are invisible.** | No `downloads` permission; no surface. | "What is this browser doing" has a whole axis missing: in-flight and completed downloads. |
| G5 | **Reading list is not covered while bookmarks are.** | No `readingList` permission; `bookmarks` tool exists. | Asymmetry in the "saved for later" axis — possibly correct (reading list is Chrome-only and low-traffic), but it is an asymmetry. |
| G6 | **No zoom control**, though it needs no new permission. | `TabActionSchema` (`packages/shared-types/src/tools.ts:250`) has 10 verbs; `chrome.tabs.setZoom` is reachable under the existing `tabs` permission. | The cheapest possible addition to axis 4, if it is wanted at all. |
| G7 | **Cookies / site data / permissions are out of scope and undeclared.** | No `cookies` permission, no site-settings surface. | Almost certainly a deliberate privacy line — but it is nowhere written down as one, so a future session could read it as an oversight and "fix" it. |

## What the baseline eval says about *usability* of this surface

Presence is not comprehension. The first keyed run of the model eval (spec
§26.4) landed 2026-09-04: **6 / 10 semantically correct, 1 accidental
destructive**, 30 API calls, `claude-sonnet-5`
(`apps/browser-tab-mcp/evals/baseline-report.json`).

The destructive one is the finding: given *"Move chrome's Gmail tab into
safari's window"* the model called `list_tabs` three times and then reached
straight for **`cut_tabs`** — the destructive transport — rather than surfacing
copy and cut as the honest alternatives to a refused cross-domain live move.
The refusal machinery worked; the *descriptions* did not steer. That is a
tool-description problem, and it is measurable now that the baseline exists.
