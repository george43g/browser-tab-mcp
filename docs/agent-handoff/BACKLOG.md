# Backlog — deferred tasks, parked ideas, open questions

Ordered roughly by priority. Strike items (with a date) when they land; move
genuine decisions into DECISIONS.md.

## ACTIVE — bug-sweep remediation (2026-08-09)

Source of truth for scope/evidence: **`BUGSWEEP-2026-08-07.md`** (14 findings).
Execution plan: **`~/.claude/plans/gleaming-tumbling-koala.md`**.

- ~~**PR-A** cross-browser handles + set_window bounds/state~~ — **DONE, #22 (`5af7f15`)**
- ~~**PR-B** TUI viewport + subscription supervision~~ — **DONE, #23 (`d340acf`)**
- ~~**PR-E** build identity stamp~~ — **DONE, #24 (`ed99f7a`)**
- ~~**PR-C** human-readable CLI output + curated env flags~~ — **DONE, #26 (`b1cb999`)**
- ~~**PR-D** `focus_tab` contract + `history.sources` + doc fixes~~ — **DONE
  2026-08-09, branch `refactor/focus-tab-contract`** (PR open, awaiting the merge
  word). `raiseWindow` defaults true; both pathways now un-minimize before
  raising; `CommandResult` gained `cgWindowId`/`windowState`/`wasMinimized`/
  `windowFocused` (additive-optional — `version` did NOT move, and no
  `MIRRORED_SCHEMAS` type was touched, so no Rust mirror was needed).
  `history` gained `sources`. Doc claims corrected in AGENTS.md.
  **One plan premise was wrong:** `.env.example` was *not* missing — it exists at
  `apps/browser-tab-mcp/.env.example` and already covered 58 of the recognized
  vars. It was audited against a fresh grep instead of regenerated: 10 genuinely
  missing knobs added (`MCP_DISABLE_RESOURCES`, `MCP_DEV_CMD`,
  `MCP_DEV_WATCH_DIR`, `MCP_TEST_NOOP_DELAY_MS`, `COVERAGE`, `COVERAGE_GATE`,
  `STRESS_*`, `WORKLOAD_DURATION_S`) plus an "ambient conventions" block for the
  16 vars the tool honors but does not own (`CI`/`NO_COLOR`/`NODE_ENV`/…).

- ~~**PR-F** release automation via release-please~~ — **DONE, #28 (`f8e9261`)**

**With PR-D merged, the bug-sweep remediation plan is complete.** What is left
below is not part of it.

**Remaining:**

- ~~**Kit migration (blocked on upstream).**~~ — **DONE 2026-08-09** (the
  kit-migration PR). Upstream published robustness `0.6.0` / cli-kit `0.3.1` /
  tui-kit `0.3.3` / secret-store `0.2.2`; browser-tab now depends on those
  ranges and `packages/{cli-kit,tui-kit,robustness,secrets}` are deleted
  (`secrets` had zero consumers here, so no `secret-store` dep was added).
  Rode along for free: **the REPL is repaired** (cli-kit 0.3.1's real
  `<tool> <json>` dispatch + quote-preserving tokenizer — smoke-tested against
  the built bin), and the app-local `useTerminalSize`/`viewport` copies were
  replaced by the upstreamed tui-kit exports (`viewport.test.ts` stays as the
  guard that the kit's `CHROME_ROWS` keeps fitting this app's chrome).
  **One gap surfaced:** published robustness has no `TokenBucket.tryAcquire`
  (this repo had added it locally for the screenshot fail-fast limiter) — an
  app-local `ShotBucket` in `daemon/screenshot.ts` carries the exact semantics
  until a `tryAcquire` ships upstream (**flagged for the next upstream brief**,
  along with widening cli-kit's `ToolCallResult.content` to image blocks —
  the REPL adapter in `cli.ts` currently summarizes image blocks into text).
  **Upstream ACCEPTED both asks same-day** (direct cross-session message,
  2026-08-09, recorded in the template's DEFERRED.md): `tryAcquire` will be
  implemented from our spec + the v1.0.0 `packages/robustness/src/rate-limit.ts`
  docblock; `ToolCallResult` will be fixed *properly* — a breaking
  discriminated union (text/image/audio/resource) shipped as a **minor** with
  a migration note (a second consumer hit the same narrowness the same day).
  **When those ship:** delete `ShotBucket` (screenshot.ts) and the REPL image
  adapter (cli.ts). Also in 0.3.1 but unadopted here: `runRepl`'s
  `formatResult` / `showMeta` (reads mcp-kit's `dur_ms` — works unmodified) /
  `json` / `last-error` built-ins — `showMeta: true` is a one-line follow-up
  nicety. Piped multi-command REPL input is a 0.3.1 fix, not something this
  repo ever worked around — nothing to remove.

- ~~**Small test debts, declared during review (2026-08-09):**~~ — **DONE
  2026-08-09** (same-day, the test-debts PR):
  - `stateClobbers` is now load-bearing: `commands.test.ts` asserts the END
    STATE of `set_window` under a modelled clobber (the restore absorbs it) —
    the pre-#27 implementation fails it. Sabotage-checked.
  - `apps/browser-tab-mcp/src/cli.test.ts` is the CLI-action harness: mocks
    the dispatcher, drives the real commander program with argv, asserts exact
    tool payloads (`--no-raise`, `--bounds` parsing, csv trim, number
    coercion, the env↔flag preAction hook). Three sabotage checks, each
    killing exactly its own guard.

- **Release PR shows no CI checks** — GitHub doesn't trigger workflows for
  events created with `GITHUB_TOKEN`, so #31 (and every future release PR)
  merges without status checks. Documented PAT escape hatch in
  `docs/RELEASE.md` if that ever matters.

## Stress-test findings (2026-08-16) — ALL FIXED (last 5 on 2026-08-18)

Two adversarial agents drove the TUI and the CLI/REPL in isolated tmux windows
against the live daemon. Full evidence in PROGRESS-LOG 2026-08-16. **Fixed:**
CLI exit codes (#42), TUI width safety (#45), and — for free via the kit
upgrade (#43) — the REPL discarding a screenshot's structured result.

**All four of the user's priorities are FIXED and open as a stacked PR chain
(2026-08-17): S1 → #47, S2 → #48, S3a → #49, S3b → #50, S4 → #51. Merge in that
order; each is based on the previous.** Detail below is kept as the record of
what each one was, and the PROGRESS-LOG entry for 2026-08-17 has the evidence.

~~Still open from the "also open, lower" list at the bottom~~ — **ALL FIXED
2026-08-18 (PR #63)**: `doctor` now names warnings in its headline (and the
extension checks are report items, so they count toward it); `clockOf` shows
`MM-DD` on any row that is not from today; `chromium` joined `DEFAULT_BROWSERS`;
and empty option values are rejected instead of silently WIDENING the query.
Each was verified still-real in the code before being touched, and each has a
sabotage-checked guard.

- **S1. Colour is dead in the shipped binary.** VERIFIED: `vite.config.ts` has
  no `resolve` block, Vite's default `mainFields` leads with `browser`, and
  `picocolors/package.json` maps a browser build whose every colour function is
  the identity. Proof under a pty: the kit emits 11 ANSI sequences, our built
  bin emits **0**. So `color.green/bold/dim/red` are all no-ops — the human
  renderers lost their entire visual hierarchy and nobody noticed.
  *Fix:* `resolve: { mainFields: ["module","jsnext:main","jsnext"], conditions:
  ["node","import","module","default"] }` **plus a build-output guard** asserting
  no `dist/*.js` contains `picocolors_browser` — the guard is the point, since
  this class silently swaps any dep for its browser build.
- **S2. Human renderers discard the field they exist for.** `journal --view
  windowMru` prints **no window handle** (`render.ts:190-196`; `JournalRecordLike`
  declares `tabId?`/`windowId?` at :165-166 and the renderer never reads them),
  so its output cannot be fed to `focus`/`window set` — which is the entire point
  of an MRU view. `history` drops `sources` (`render.ts:209-225`), reintroducing
  exactly the "was it Chrome-only or did Safari have nothing?" ambiguity that
  field was added to kill. Also: narrow-width overflow — `Math.max(12, width -
  fixed)` **floors** the title budget, guaranteeing a 2-column overflow at 60
  cols; needs a real clamp that drops a column instead.
- **S3. Flag and schema honesty.** `-q`/`-v`/`--no-color` are documented on every
  command and **never read** (`cli.ts:95-97`); `--no-color` is a two-line fix
  since cli-kit ships `disableColors()`. `--fields` silently accepts anything
  (`cli.ts:198` is a ternary, not `.choices()`). `journal --view tabMru|journey`
  ignores its own "required" argument and returns an empty result
  indistinguishable from "no history". `open`/`window open` accept **any** string
  as a URL (`z.string()`), so `file:`/`javascript:` reach a real browser.
  `get_logs` is callable with `MCP_DEV` unset — `devOnly` is honoured only by
  `toMcpTools()`, not by the dispatcher or the REPL's tool list.
- **S4. `stress:tui` is a placeholder.** `scripts/stress-tui-workload.ts` is the
  untouched starter-template file: it loops the `noop` tool and never touches
  `App`, `buildRows`, `useSnapshot` or the viewport helpers. It passes and means
  nothing.

**Also open, lower:** `doctor` prints "all clear" *before* its warnings and exits
0; `clockOf` prints no date so cross-day journal rows look mis-sorted; `chromium`
is a first-class value everywhere except `DEFAULT_BROWSERS`; empty-string option
values are silently dropped (`--browser ""` widens the query instead of failing).

**Upstream (kit) — do NOT fix locally:** `StatusBar` is content-sized so a long
message butts against the hint with no gap (`width="100%"`); REPL `Ctrl-C` kills
the session instead of cancelling the line.

## Capability audit vs. the 2026-08-16 scope request

The user asked for tab-group colour, browser theme control, cross-extension data
access, SurfingKeys integration, mute/sleep, bookmark CRUD — each exposed through
TUI + MCP + console + **HTTP streaming** + a **static scriptable** interface —
and explicitly said: *check what exists, then triage, park, defer, prioritise.*
**This is that audit. Nothing below is built.**

| Capability | State | Evidence |
|---|---|---|
| Mute / unmute | **EXISTS** | `tab_action` kinds `mute`/`unmute` (`tools.ts:183-184`) |
| Sleep / wake | **EXISTS** | `discard` (`tools.ts:187`); wake = `reload`/focus |
| Tab groups CRUD | **EXISTS** | `group_tabs` create/add/remove/update/move |
| Tab-group **colour** | ~~READ+WRITE, NEVER DISPLAYED~~ **SHIPPED 2026-08-18 (PR #63)** — `list` paints `⊞<title>` in the group's colour; the TUI badge uses a coloured disc. | `color` is in `TabGroupSchema` (`contract.ts:43-45`), settable via `group_tabs` (`tools.ts:225-228`), mapped from Chrome (`extension-core/snapshot.ts:128`) — but **no renderer shows it**; the TUI prints only the group title (`⊞✅Claude`). Cheapest win on this list. |
| Bookmark CRUD | ~~ABSENT~~ **SHIPPED 2026-08-18 (PR #66)** | `bookmarks` tool + `browser-tab bookmark` + extension command + runtime-probed capability. Extension-only and never merged across browsers — see the PR for why a merged write is the wrong default. |
| Browser theme (dark/light) | **PARKED 2026-08-18 with evidence** (DECISIONS.md) — there is no `chrome.theme` namespace at all and no color-scheme API; the only route is `management.setEnabled` on an installed theme extension, which costs the broad `management` permission and is Chrome-only. | MV3 exposes no API to set Chrome's own theme. Needs research before promising anything. |
| Read another extension's data | **DROPPED 2026-08-18 by George** ("dont worry about cross-extension data access"). Was: IMPOSSIBLE from our extension. | `chrome.storage` is per-extension; our manifest has no `externally_connectable` and neither, in general, does a target. The user's own instinct is right: this belongs to the **daemon**, reading Chrome's on-disk `Local Extension Settings/<id>/` LevelDB. Risk: writing under a live Chrome. |
| SurfingKeys integration | **RESEARCHED 2026-08-16 — feasible, but via neither obvious route.** See the dedicated section below. | Source-verified against `brookhong/Surfingkeys@660d990` = v1.18.0 = the build installed here |
| TUI interface | **EXISTS** | `browser-tab tui` |
| MCP interface | **EXISTS** | `browser-tab mcp` |
| Interactive console | **EXISTS** | `browser-tab repl` (alias `console`) |
| **HTTP streaming interface** | ~~ABSENT~~ **SHIPPED 2026-08-18 (PR #67)** — opt-in loopback server: `/snapshot`, `/events` (SSE), `POST /tools/:name`, token-gated. Decision recorded in DECISIONS.md. | transports today are a **unix socket** (`ipc-server.ts`, NDJSON + `subscribe`) and a localhost **WebSocket** for the extension only. No HTTP server anywhere. |
| Static scriptable interface | **DEFINED AND MET 2026-08-18.** George: "the cli will accept commands and its api surface is similar to that of the mcp and TUI — most features should be available to all types of interfaces". Enforced by `tests/interface-parity.contract.test.ts` (PR #65), which walks the real commander tree. Was: PARTIAL. | `browser-tab <cmd> --json` + the `snapshot.json`/`heartbeat.json` files cover scripting; there is no declarative script/config format. Needs a definition before it can be built — **ask the user what "static scriptable" means to them.** |

**Suggested triage** (mine, not the user's — confirm before acting):

1. **Do now, cheap:** tab-group colour rendering (data already flows end to end,
   this is a renderer change) — pairs naturally with **S1**, since colour output
   is broken anyway and both touch the same rendering path.
2. **Do next, unblocks a category:** bookmark CRUD. Additive, well-understood
   (`bookmarks` permission + extension commands + a tool), and it is the template
   for "add a new capability across all interfaces".
3. **Research before committing:** SurfingKeys, cross-extension data, browser
   theme. All three hinge on the same question — what can be reached from outside
   an extension's sandbox — and the answer likely routes them to the daemon.
   **Do not promise these until the research lands.**
4. **Design decision first:** the HTTP streaming interface. Real work (a server,
   auth, backpressure, an event stream that mirrors `subscribe`) and it widens
   the attack surface of a tool that is currently loopback-and-filesystem only.
   Worth an explicit decision in DECISIONS.md, not a drive-by.
5. **Park until asked:** "static scriptable interface" — underspecified.

## SurfingKeys integration — research complete (2026-08-16)

Source-verified against `brookhong/Surfingkeys@660d990` (v1.18.0), which is
byte-for-byte the build installed here
(`…/Extensions/gfbliohnnapiefjpjlpjnehglfpaknnc/1.18.0_0/`). **Both goals the
user asked for are achievable. Neither works the way you would assume.**

### Two doors are CLOSED — do not spend time on them

1. **Cross-extension messaging: impossible.** SK declares no
   `externally_connectable` and registers no `onMessageExternal`/`onConnectExternal`
   — verified by grep in BOTH upstream `src/` and the installed
   `background.js`/`content.js`/`api.js`. `chrome.runtime.sendMessage("gfbli…", …)`
   cannot work. Impersonating a content script is also incoherent:
   `chrome.runtime.onMessage` only accepts same-extension senders.
2. **Writing its LevelDB while Chrome runs: impossible, not merely risky.**
   Chrome holds an exclusive `fcntl` lock on
   `Local Extension Settings/gfbli…/LOCK` for the whole session — confirmed by
   `lsof` on this machine. LevelDB takes that lock even on a read-only open.
   And *even if forced*: Chrome caches storage in the SW heap, SK registers **no**
   `storage.onChanged` listener anywhere, and a `savedAt` reconciler
   (`background/chrome.js:13-40`) compares local vs sync on every load and
   overwrites the loser wholesale — so a successful write would be unnoticed,
   then silently reverted, possibly across machines. **Reading a COPY is fine**
   (that is how the facts below were established); writing is not. Kill any
   design that proposes it.

### Two doors are OPEN, and SK opened them on purpose

**A. `localPath` → a config file our daemon serves over HTTP.** SK supports
loading `snippets` from a URL, and re-fetches it **on every content-script init,
i.e. every page load in every frame** (`content_scripts/content.js:160` →
`background/start.js:145-175`), with `?nonce=<epoch-ms>` cache-busting applied to
`http(s)` but **not** `file://` (`start.js:527-534`). It diffs before
re-registering (`start.js:1131-1183`), so writing the file is enough — no
restart, no options page, no storage write. `host_permissions: <all_urls>` means
`http://127.0.0.1:<port>/…` works; SK already fetches `localhost:11434` for
Ollama, so the loopback path is proven in practice.

**B. SK's entire public API is a DOM CustomEvent bus on `document`.**
`dispatchSKEvent` (`content_scripts/common/runtime.js:1-7`) fires
`surfingkeys:<type>` with an array `detail`; `initSKFunctionListener`
(`common/utils.js:309-333`) receives it. Registered buses: `surfingkeys:api`
(map/mapkey/unmap/hints/normal/visual/clipboard/front), `surfingkeys:front`
(showPopup/showDialog/addCommand/applySettingsFromSnippets),
`surfingkeys:hints`, `surfingkeys:user`. **This crosses isolated worlds by
design** — SK's own MV3 snippets run in the USER_SCRIPT world while the listener
runs in the ISOLATED world, so every `api.map(...)` in the user's config already
makes that hop. Our content script is simply a third world on the same
`document`.

### Facts about THIS machine (read from a copy, original untouched)

- `showAdvanced = true`, **`localPath = "" (empty)`**, `snippets` = a ~9.5KB JS
  string.
- **`~/dotfiles/surfingkeys/config.js` is a DEAD COPY.** Because `localPath` is
  empty, SK is running the `snippets` string pasted into its options page — which
  happens to match the dotfile's opening bytes, but the two are unsynchronised
  and will drift. Mechanism A fixes exactly this, and that is the strongest
  single argument for doing it.

### Hard prerequisite, worth a `doctor` check

MV3 gates `showAdvanced` on `chrome.userScripts` availability
(`start.js:1189-1191`), which requires Chrome's **Developer Mode / "Allow user
scripts"** to stay on; the error is explicit at `start.js:1276`. If a Chrome
update or policy flips it off, the config silently stops executing and mechanisms
A and C die. It presents to a user as "my mappings vanished", so it needs an
actionable doctor hint rather than an assumption.

### One thing NOT verified — check before building on it

Whether `CustomEvent.detail` structured-clones between **two different
extensions'** isolated worlds (USER_SCRIPT→ISOLATED is proven, since SK works).
Ten-second check from any page's DevTools console:
`document.dispatchEvent(new CustomEvent('surfingkeys:front', {detail:['showPopup','bridge works']}))`
— if an SK popup appears, the channel is confirmed. Designed fallback if not:
inject a MAIN-world shim via `chrome.scripting.executeScript({world:"MAIN"})` and
relay over `window.postMessage`.

### Recommended shape (do NOT start without the user's word)

1. **Settings management** = daemon serves one `text/javascript` route on
   `127.0.0.1`; canonical source becomes `~/dotfiles/surfingkeys/config.js`;
   tools `sk_config get|set|edit`; **validate by parsing as JS before serving** —
   SK's own error path (`start.js:168`) only covers fetch failure, not a syntax
   error, so a bad write silently kills every mapping. One unavoidable manual
   setup step: the user sets "Load settings from" in SK's options once (it needs
   SK's internal bus, which we cannot reach) — ship it as a doctor instruction.
2. **Driving the running instance** = new `ExtCommand.kind` values dispatching
   CustomEvents from our content script, routed through the existing
   extension-core → daemon → MCP/CLI path. **Fire-and-forget**: the bus ignores
   return values, so model these as commands, not queries. Probe for SK at
   runtime and set a `surfingkeys` capability key — **never branch on browser
   name** (existing invariant).
3. **Optional, most capable:** a managed region appended to the served config
   that opens a channel back to the daemon, giving the full `api` surface
   including `RUNTIME` (which the CustomEvent bus does not expose). **UNKNOWN:**
   whether `ws://127.0.0.1` clears mixed-content from an `https://` page in the
   USER_SCRIPT world — verify empirically. Lower-risk variant: the managed region
   only dispatches/listens for CustomEvents and our content script does transport.
4. **Rejected:** registering ourselves as the `surfingkeys` native-messaging host
   — it would hijack SK's neovim integration wholesale for a one-shot
   `serverStarted` handshake we cannot even initiate.

### Bonus: SK as a reference implementation, not an integration target

Our write-side API is a strict superset **except bookmarks**. SK has fairly
complete bookmark CRUD (`start.js:127-143` create with recursive folder
creation, `.search`/`.getTree`/`.getSubTree`/`.remove`) — read `createBookmark`
and `getFolders` (`start.js:112-123`) before writing ours. SK's mute is
**toggle-only** (`start.js:898-903`), which our explicit `mute`/`unmute` already
supersedes; SK has **no** discard/sleep at all; and SK's `settings.theme` styles
**its own overlays**, not the browser — so it is no help for browser theme
control.

## Queue

0. ~~**PR-D — deploy + real-world smoke.**~~ **DONE 2026-07-29** — all steps
   pass; results + three findings recorded in `PRD-DEPLOY-RUNBOOK.md`. No code
   change was needed to deploy.

1. ~~**`cgWindowId` tiebreaker for tiled windows**~~ — **DONE 2026-08-03,
   PR #18 (awaiting merge word).** Shipped exactly as sketched below: yabai
   titles break ties on the ambiguous subset only, tiered matching
   (exact → prefix/suffix → containment), null on tie/no-titles, duplicate
   claims dropped, native tier borrows yabai titles lazily behind
   `hasAmbiguousBoundsMatch`, `correlateSnapshot` stayed pure. Live-verified:
   all three tiled Chrome windows resolve. One caveat below was WRONG —
   yabai did list Safari this session (see GOTCHAS). Original item:
   Found during PR-D smoke: `correlateSnapshot`
   (`src/detect/correlate.ts`) matches CG windows on `(ownerPid, bounds±2px)`
   and returns `null` on ambiguity. Under yabai every same-space Chrome window
   shares one frame, so **all three Chrome windows resolved to `null`** — the
   wm-stack join silently dies in exactly the setup it exists for. Safari only
   worked because it had one window. This blocks BACKLOG item 2 (wm-stack
   rewire) from being useful for Chrome.
   - Fix direction: yabai's `query --windows` already returns a **unique
     `title` per window** for the same ids it reports frames for. Apply a
     title tiebreaker *only to the ambiguous subset*, so the fast bounds path
     is unchanged when it's already unique. Snapshot titles are a prefix of
     yabai titles (yabai appends `" - Google Chrome - <profile>"`) → match by
     prefix/normalized-contains, and still return `null` if titles tie too.
   - Prefer yabai over `kCGWindowName`: window names via CGWindowList need
     **Screen Recording** TCC, yabai needs none extra (it's already tier 2).
   - Caveat found: yabai did **not** list the Safari window at all, so the
     tiebreaker must degrade to today's behaviour when yabai has no row.
   - Keep `correlateSnapshot` a pure function (it's unit-tested) — pass the
     titled rows in as an argument; add fixtures for: unique-bounds (unchanged),
     ambiguous-bounds + unique titles (resolves), ambiguous + tied titles
     (stays null), no-yabai (stays null). Sabotage-check each.

2. ~~**Extension staleness is undetectable — add a version/protocol check to
   `hello`.**~~ — **DONE 2026-08-06, PR #20 (merged, `main@78ea436`).** The
   `hello` now carries `protocolVersion`, single-sourced as
   `WIRE_PROTOCOL_VERSION` in shared-types; the daemon computes `extIsStale`,
   logs a loud `ext_stale` warning, surfaces `⚠ <browser> extension is stale …`
   in `doctor`, and reports `stale` + `extensionInfo` via `daemon_status`. A
   connected-but-legacy extension that reports no `capabilities` is defaulted to
   a conservative all-false map (`conservativeCaps`) so consumers gracefully
   refuse v2 ops (with a hint) instead of hitting a raw "unknown command kind"
   error. Live-verified: both browsers reloaded → `protocolVersion 2, stale:
   false`. Original item:
   PR-D burned real time on this: both browsers ran a connector
   build from before the v2 commands while reporting `extensionConnected:
   true`. Newer command kinds failed with a raw pass-through error (`unknown
   command kind "extract_content"`), `capabilities` came back `undefined`, and
   **journaling stopped entirely** (the AppleScript event fallback is correctly
   suppressed for extension-connected browsers, but the stale extension emitted
   no events either). Suggested: extension sends its build version/protocol
   revision in `hello`; the daemon warns loudly (and `doctor` surfaces it) when
   it's older than the daemon's own; default `capabilities` to a conservative
   map instead of leaving it `undefined`, since consumers gate on that map.

2. **wm-stack rewire** (separate repo `~/dotfiles/wm-stack`) — the highest-payoff
   remaining task, out of scope for this repo but next in line after PR-D.
   Consume `browser-tab list --json` or the unix socket; join on `cgWindowId`,
   never window titles; `move` requires the daemon + a connected extension.
   Call-site inventory: `docs/HANDOFF.md` § "Immediate next steps"
   (sketchybar plugins, select-window.lua, modal_modes.lua, spaces_modal +
   dashboard adapters, collect_stats.sh, storage.lua, deferred reorg.lua).
   Migration crib: bottom of `docs/WM_STACK_CONTRACT.md`.

3. **`COVERAGE_GATE=1` flip** — the dormant half of the two-flag coverage
   design. Measured failing 2026-07-24: cli-kit 26% / robustness 58% /
   secrets 73% vs the shared 80/70/70/70 bar → needed test-writing first.
   **Unblocked 2026-08-09:** the three worst offenders left the repo with the
   kit migration, so the ratchet now only has in-tree packages to arm
   (re-measure before flipping). Best done as a ratchet (arm per-package as
   suites mature), not a big-bang flip. Context: `docs/FOLLOWUPS.md` §1 (P2).

4. **Native module on the global install** — **ANSWERED 2026-07-29, no longer
   urgent.** The user chose to keep launchd on the workspace build, and
   `pnpm add -g <path>` turned out to **link** rather than copy, so the global
   bin resolves the workspace and loads the native `.node` anyway (`doctor`
   from outside the repo reports the accelerator loaded). Still worth doing if
   the bin is ever installed from a tarball/registry: ship the arch `.node` in
   package `files` + add an installed-location resolution candidate in
   `apps/browser-tab-mcp/src/native-bridge.ts`.

5. ~~**Safari extension packaging**~~ — **UNBLOCKED/DONE 2026-07-29.** The user
   **has full Xcode** (the "CLT only" assumption was wrong).
   `pnpm --filter @george43g/safari-extension sideload` → `BUILD SUCCEEDED`,
   and Safari now runs the real extension (`extensionConnected: true`, full
   capabilities) rather than the AppleScript path. Remaining manual step after
   each sideload: Safari → Settings → Extensions → toggle OFF then ON.
   ~~Open sub-item: yabai does **not** list the Safari window in
   `query --windows`, so Safari can't correlate under tier 2 (native only).~~
   **WRONG, and fixed 2026-08-10.** yabai *does* list it (id `392`). The real
   cause was that **Safari's WebExtension API reports `top` display-local while
   `left` stays global**, so on any non-primary monitor bounds matched *zero*
   CG candidates and `pickCgWindow` returned null before the title tiebreaker
   (which only ran on the ≥2-match subset) could rescue it. Proven two ways:
   the AppleScript path resolved the same window to `392` while the extension
   path said `null`; and the same window moved to the **main** display (origin
   `y:0`) correlated fine, because there display-local == global. Fixed in
   `detect/correlate.ts` with a display-origin offset tier + a title-only last
   resort, plus adopting the CG frame so `bounds` stop lying. The extension is
   **not** patched — it has no display API to consult, and the inverse
   transform is ambiguous when two displays share an x-range (this machine:
   displays 2 and 5), so the repair belongs in the daemon where the display
   list lives.

6. **npm publish enablement** — deliberately OFF, and no longer coupled to
   versioning. ~~Release automation~~ **landed (PR-F)**: release-please
   (manifest mode + `node-workspace`) now produces tags + GitHub Releases +
   `CHANGELOG.md` on merge of a rolling release PR; the orphaned
   `.releaserc.json` was deleted. What's still deferred is **distribution
   only** — `docs/FOLLOWUPS.md` §2 (publish only the bin package; `NPM_TOKEN`
   secret; add a separate `publish` job gated on `release_created`).

7. **Optional polish** (from `docs/HANDOFF.md`) — **still open 2026-08-18; needs
   a real browser and wall-clock time, so it cannot be automated here.** See
   § Closed 2026-08-18 for why the risk is low.
   - Safari background-*page* 30-min idle soak — confirm it stays connected or
     reconnects (AppleScript fallback exists regardless).
   - Chrome SW-kill reconnect check (`chrome://serviceworker-internals`) —
     should reconnect <30s via the alarms watchdog.

8. ~~**Doc fix:** `AGENTS.md` § "MCP best practices" item 2 cites a
   `TOOL_TIMEOUTS_MS` constant that does not exist.~~ — **DONE 2026-08-09 in
   PR-D.** Item 2 now describes what actually happens: `timeoutMs` on the tool's
   own `ToolDefinition`, falling back to `MCP_TOOL_TIMEOUT_DEFAULT_MS`, with
   `MCP_TOOL_TIMEOUT_FORCE_MS` overriding both. Same pass fixed the e2e
   "deferred/stub" claims and the env↔flag rule.

## Parked ideas (deliberate "no for now")

- TUI `o` open-URL prompt — skipped; `browser-tab open <url>` covers it and
  ink text input wasn't worth the complexity.
- Safari-only manifest to silence Chrome's harmless "requires MV2" warning
  about `background.scripts` — not worth a convert + re-sign cycle.
- Mobile Safari — deferred by explicit user decision.
- Merging this repo with wm-stack into one monorepo — decided against for now
  (`docs/FOLLOWUPS.md` §3): the JSON/socket contract is the deliberate seam.
  Revisit only if 3+ interdependent tools need atomic cross-cutting changes;
  then prefer mise-as-orchestrator over Nx/Bazel.

## Closed 2026-08-18 — the backlog sweep

George set one goal: *"clear the backlog/deffered"*, with coverage ratchet and
npm publish explicitly deferred and cross-extension data access dropped.

| Item | Outcome |
|---|---|
| 5 stress-test bugs (doctor / clockOf / chromium / empty options / group colour) | **fixed** — PR #63 |
| Windows build target for the daemon | **shipped** — PR #64 |
| "static scriptable interface" (defined as CLI↔MCP↔TUI parity) | **shipped + enforced** — PR #65 |
| Bookmark CRUD | **shipped** — PR #66 |
| HTTP streaming interface | **shipped, opt-in** — PR #67 |
| Browser theme control | **parked with evidence** — DECISIONS.md |
| SurfingKeys | **decided, not started** — mechanism A unblocked by #67; B needs one 10-second check first |
| Cross-extension data access | **dropped by George** |
| `COVERAGE_GATE` ratchet · npm publish | **deferred by George** |
| Extension self-reload (#54) | **merged**, `7a15cf8` |

**Still genuinely open, and honestly small** (state re-verified 2026-08-18 at
checkpoint — see PROGRESS-LOG § "sweep complete"):

- **Two soak checks that need a real browser and wall-clock time**, so they
  cannot be automated here and have never been run: a 30-minute Safari
  background-*page* idle soak (does it stay connected, or reconnect?), and a
  Chrome service-worker kill via `chrome://serviceworker-internals` (should
  reconnect within 30s via the alarms watchdog). The daemon half of both is
  already covered by `tests/ws-heartbeat.test.ts`; what is untested is the
  BROWSER half. Failure mode if they are wrong is visible and non-silent (the
  browser shows as `extensionConnected:false` and reads degrade to AppleScript),
  which is why this has stayed low.
- **Native module resolution for a tarball install** (queue item 4) — only
  matters the day the bin is installed from a registry rather than linked, which
  npm publish being deferred means is not today.
- **Live deploy drift, not caused by any open PR.** The daemon is running a
  DIRTY workspace build (`1.2.1+59.e93d17e.dirty`) picked up during the release
  deploy, while both extensions are on the clean `1.2.0+57.5b686ee`. launchd
  re-execs whatever `dist/cli.js` holds, so any `pnpm build` on a feature branch
  can drift it again. Fix: `git switch main && pnpm build && browser-tab daemon
  restart`, then reload the extensions — **user-gated**, so left undone.
  **WIDENED 2026-08-18 (merge train).** `main` has since taken #63–#68, so the
  gap is no longer a stamp mismatch but six merged features the running daemon
  and both extensions do not have — including the Windows platform gate, the
  bookmarks command, and the parity work. The many `pnpm build` runs used to
  verify those rebases each rewrote `dist/`, so the live daemon is now a build
  from an arbitrary feature branch. Same fix, same user gate; it just matters
  more than it did this morning.

## Open questions for the user

- ~~Native-on-global~~ — **answered 2026-07-29**: daemon stays on the workspace
  build; the global bin is linked, so native loads anyway (queue item 4).
- ~~Install full Xcode for Safari packaging~~ — **answered 2026-07-29**: Xcode
  is installed, Safari extension is live (queue item 5).
- ~~When to start the COVERAGE_GATE ratchet (queue item 3)?~~ — **DEFERRED by
  George, 2026-08-18** ("coverage ratchet - defer").
- ~~Release automation~~ — **answered / shipped (PR-F)**: release-please, tags
  + releases + changelog, no npm publish. Remaining question is narrower: when
  (if ever soon) to enable **npm publish** (queue item 6)? — **DEFERRED by
  George, 2026-08-18** ("npm publish - defer").
- ~~First release: accept `1.0.0`, or pin `"release-as": "0.1.0"` for one
  cycle?~~ — **RESOLVED BY EVENTS, closed 2026-08-22.** 1.0.0 was accepted
  implicitly and the project has since shipped through **v1.4.0**. There is no
  decision left to make; recorded here rather than deleted so the question's
  history stays visible.
- Does the `cgWindowId` tiebreaker (queue item 1) need to preserve *stable*
  ids across a re-tile, or is per-snapshot correctness enough? (Titles change
  as the user navigates; ids must stay right, not stay constant.)


## 2026-08-20 — dogfood findings: a real 103-tab cleanup run (agent session 5a15fe80 fork)

A full live cleanup (5→2 windows, 103→96 tabs, 11 groups created, 7 dupes
closed, ~43 tool calls) using ONLY this tool. Everything below was hit in
anger, not constructed.

**ALL FIXED 2026-08-21 (PR #71 — fix(tabs): the dogfood five).** Every bug and
friction item below shipped in one sweep: own-window grouping, per-id
validation with `payload.skippedTabIds` (as handles) + daemon error
translation of raw numeric ids, honest `move_tab` final index via a closing
`tabs.get`, `redactUrlUserinfo` at every mapper (+`BROWSER_TAB_KEEP_URL_USERINFO`
escape), `fields:"summary"` on MCP+CLI, immediate post-command snapshots (the
staleness fix), and a Chrome-accurate `close_tab` description. Each guard was
sabotage-checked — including one decorative first attempt caught by its own
sabotage failing to fail (see PROGRESS-LOG 2026-08-21).

**Bugs, in severity order (historical record):**

1. **`group_tabs create` groups into the FOCUSED window, not the tabs' own
   window.** Creating groups from window-1 tabs silently relocated ~40 tabs
   into window 2 — a grouping op became a mass cross-window move. Suspect:
   `tabs.group`'s `createProperties.windowId` defaulting in extension-core
   `commands.ts`; it should inherit the first tab's window. Workaround that
   recovered it: `group_tabs move` back. THE serious one.
2. **`group_tabs create` is all-or-nothing with an unmapped error.** One stale
   id out of 12 failed the whole call with Chrome's raw
   `No tab with id: 523242703` — numeric, not the `t:chrome:x…` handle
   grammar, and no indication which input died. Wants per-id validation,
   partial success + a `skipped` list, and handle-mapped errors (violates our
   own "errors get an actionable hint" rule).
3. **`move_tab` result `index` is wrong on append** — moving into a ~41-tab
   window reported `index: 80–85`. Misleads any caller doing follow-up
   `targetIndex` math. Cosmetic until someone chains on it.

**Security (do before wider use):** tab URLs can carry basic-auth userinfo
(`http://admin:<password>@192.168.1.225/net` — two live examples found) and
`list_tabs` returns them VERBATIM into agent context and logs. Redact URL
userinfo in snapshots by default, env-escape if someone truly needs it.

**Friction:**

- `list_tabs` at 103 tabs blows the MCP token cap (~52KB) even at
  `fields:"core"` — every listing became save-to-file + jq. Wants a
  `fields:"summary"` projection (windows + groups + counts, zero tab rows)
  and/or pagination.
- **Write→read staleness:** an immediate `list_tabs` after group moves showed
  pre-move state; needed a settle pause. Write ops returning the fresh
  affected sub-snapshot would remove the guesswork.
- `close_tab`'s "re-run list_tabs, indices shift" warning is Safari-specific;
  x-handles are stable, so it invites needless re-listing on Chrome.

**Worked flawlessly, for the record:** `move_tab` + `targetGroupId`
(move+group cross-window in one call), state preservation (discarded tabs
stayed discarded through every move), cg-id stability across the whole
reshuffle, `group_tabs update` rename/recolour, and parallel batched ops.


## 2026-08-21 — TUI soak at 3×120 scale: overflow verdicts are a measurement artifact (probably)

`stress:tui` at `BROWSER_TAB_FAKE_SCALE=3 BROWSER_TAB_FAKE_TABS=120` goes red
two ways; neither is a product bug so far as could be established, and neither
reproduces in isolation:

1. **`workload exited 143`** — phase B renders until a deadline BEYOND the
   driver's SIGTERM, so the kill always lands mid-work; at default scale the
   robustness shutdown trap converts it to exit 0, at heavy scale (p99 lag
   >500ms) the signal handling loses the race and the raw 143 surfaces. A
   budget verdict conflated with a hang verdict.
2. **Frame-height "violations" whose line counts fit NO geometry** (105 and
   120 lines against a 60-row max). The same scale, geometry cycle, key
   sequence and fold pattern was replayed in a controlled repro: **0 of 418
   frames overflowed**, including 400 consecutive cycles. Steady-state frames
   at 120 tabs/window are exactly clamped (verified 30/30 lines at 100x30).
   Best hypothesis: ink-testing-library coalesces two erase/redraw writes into
   one captured "frame" when the event loop is saturated for minutes — a
   capture artifact, not an overprint a real terminal would show. NOT PROVEN.

Standing guidance: the soak's designed configuration (default scale) is the
contract and passes end-to-end. Scaled-up runs need `STRESS_DURATION_S` raised
AND the two artifacts above understood before a red run is believed. Repro
harness: see PROGRESS-LOG 2026-08-21.

## 2026-08-21 (late) — from the TUI feature drive + Windows deployment (session 5a15fe80)

### OPEN BUG — cgWindowId oscillates on extension-fed Chrome windows

Reproduced live during the key-by-key TUI drive (real daemon, v1.3.1+73):
at TUI launch both Chrome windows showed `cg=279` / `cg=118154`; after two
`window open` calls + `r` refresh, EVERY window read `cg:none` (Safari too);
minutes later Safari re-resolved (`cg=392`) and later still Chrome window 1
was back to `cg=279` — with no correlation-related code changing underneath.
So the wm-stack join is LOST on refresh/window-churn and REPAIRED by later
polls. This matches the pre-compaction systematic-debugging investigation
("Chrome windows report cgWindowId: null while Safari resolves; tier native")
that was never closed. Working hypothesis, unverified: the event-driven merge
path runs `correlateSnapshot` before the yabai title borrow
(`needsTitleTiebreak` gating), so churn windows resolve nothing and drop
sibling claims; the next full poll repairs. Next session: instrument
`correlate.ts` inputs on the event path vs the poll path. Consumer impact:
any wm-stack read taken in the wrong window sees `null` joins exactly when
windows are being rearranged — the tool's core use case.

### TUI polish (small, found by the drive)

- Stale status message re-surfaces when a mode exits: enter confirm-close
  while "no other window…" is showing, cancel, and the old message is back.
  Clear `message` on every setMode transition.
- `^d`/`^u` don't retire the status message — `onMove`/`onTop`/`onBottom`
  clear it, the half-page handlers don't, despite the comment claiming "any
  motion retires".

### BLOCKED on tui-kit — tab list detail pane + screenshot preview

Per George's no-duplication ruling (routed via the mcp-cli-toolkit session,
2026-08-21): the shared multi-column/tree navigator lands in
`@george43g/tui-kit` FIRST; browser-tab then builds on it. Queued here, do
NOT hand-roll: (1) scroll/position indicator on the tab list; (2) sticky
right-hand detail column for the selected tab; (3) inline screenshot preview
in that column (kitty/iTerm2/ghostty graphics, degrade elsewhere) — capture
already ships as navEpoch-cached JPEGs (`daemon/shots.ts`), so this is
rendering-only; (4) mouse-scroll zoom bounded by the column. Requirements
input sent to the toolkit session (position: small core — selection reducer,
windowing, scrollbar, width-budgeted rows, fully-controlled keys; Miller
columns argued against for this consumer).

### Windows follow-ups

- Extension on the box: user steps only (load `apps\chrome-extension\dist`
  unpacked, paste `daemon token` output into options, reload) — then
  read/write goes live end-to-end on Windows.
- ONLOGON install: deliberately NOT done (headless-goal conflict raised by
  the box's `elevated` agent; George chose console-scoped `daemon run`).
  Revisit only when George resolves the headless question for that machine.
- After #78 merges: watch the FIRST honest windows-latest stress run — it has
  plausibly never executed a case, so new Windows-only reds are possible and
  expected to be case-assumption bugs first.
- WSL interop relays on the box die progressively (mechanism undiagnosed,
  worked-around twice by the resident agents). If a future session's
  interop PowerShell goes dead mid-run: not our load; repoint WSL_INTEROP at
  a live socket after checking its token elevation.

### Extension identity is a filesystem path — add a manifest `key`

Found during the Windows extension refresh (pc-server's catch, 2026-08-21):
an unpacked extension with no `key` in its manifest derives its extension ID
from the LOAD PATH. George's Windows copy lives at `D:\browser-tab-mcp\dist`
→ id `djkldcilcdiibfgonhpgephihpfglfbk`; loading the identical files from the
repo's dist dir would mint a DIFFERENT id and orphan the options-page state
(token) and anything else keyed to the id. Fix: generate a keypair once,
embed the public `key` in `public/manifest.json` so identity survives moves
across machines and paths. Small deliberate PR — the manifest is
release-please-rewritten and Biome-excluded, and a `key` also fixes the
Chrome Web Store id story if the connector is ever published. Until then:
always refresh the EXISTING directory in place, never repoint.

## 2026-08-21 — BRIEF for the next work cycle (written pre-compaction, full context; session 5a15fe80)

Purpose, per George's instruction verbatim: "not a detailed implementation
plan, but ... a brief that includes everything, all your ideas and motives and
reasons and gotchas that you'd take into account when writing a plan, so the
fresh agent can benefit from all the context you have at the moment, and the
plan can benefit from the higher quality work of a focused fresh agent." The
fresh agent writes the plan; this section is what I know that it won't.

### 1. SurfingKeys mechanism A — serve the config from the daemon

**Motive:** `~/dotfiles/surfingkeys/config.js` is a DEAD COPY drifting from
the snippets string actually running in SK (verified; § SurfingKeys above).
Serving it makes dotfiles the live source of truth with zero-restart reload
(SK re-fetches on every content-script init).

**Design reasoning already settled** (DECISIONS 2026-08-18): one
`text/javascript` route on the #67 HTTP interface; parse-as-JS before serving
(SK's error path covers fetch failure, NOT syntax errors — a bad write
silently kills every mapping); `sk_config get|set|edit` tools; the one manual
step (set "Load settings from" in SK options once) ships as a doctor
instruction; doctor also probes the `chrome.userScripts` / Developer-mode
gate (its silent failure presents as "my mappings vanished").

**Gotcha the plan MUST solve, not in the docs yet:** the HTTP interface is
token-auth, and SK's `localPath` fetch is a plain GET — SK cannot send an
Authorization header. The route needs either a capability URL (token as a
query param, e.g. `/sk/config?key=…` — the URL George pastes into SK options
IS the secret) or an explicit auth exemption for that one read-only route.
Capability-URL is my recommendation: same trust model, no interface-wide
weakening. Also: SK appends `?nonce=<ms>` to http(s) URLs — the route must
tolerate extra query params.

### 2. SurfingKeys mechanism B — drive SK / SK as the keyboard frontend

**Blocked on the 10-second check** (DECISIONS has the exact console line);
the result PICKS THE DESIGN (CustomEvent bus direct vs MAIN-world shim +
postMessage). Do not write code before it.

**George's insight (my reading, UNCONFIRMED — the plan should confirm it
with him):** the deep win is the reverse direction — SK keybindings
dispatching browser-tab commands, i.e. SK as the keyboard frontend for tab
management. Two transports exist once A ships: (a) mapkey handlers `fetch()`
the daemon's HTTP interface directly from page context — Chrome treats
`http://127.0.0.1` as potentially-trustworthy, so mixed-content from https
pages is NOT blocked (verify once, but this is documented Chrome behaviour);
the managed config region would embed the capability token, which is
localhost-secret-in-a-dotfile — same exposure class as the token file, but
now it syncs wherever dotfiles go: flag to George. (b) via our extension's
CustomEvent listener (mechanism B proper), which keeps the token out of the
page world entirely — safer, more moving parts. Fire-and-forget semantics
either way (the bus ignores return values): commands, not queries.

### 3. Edge as a first-class browser

**SHIPPED 2026-08-22** on feat/edge-first-class — see the dated close-out note at the end of this file.

**Motive:** George wants Edge in the mix on the Windows box; interim
pin-to-chromium works today (documented in the Windows follow-ups above) but
mislabels. **Surface list for the enum change** (each is small, the list is
the work): `BrowserName`/`BROWSERS` in shared-types (Zod) + `types.rs` serde
mirror + drift test; `specFor` needs a bundleId (macOS Edge =
`com.microsoft.edgemac`; Windows doesn't use it); `detectBrowserName()` gains
a `edg/` UA check BEFORE the chrome fallback (Edge UA contains both);
AppleScript adapter map (Edge is Chromium-scriptable on macOS — same adapter
as chrome/brave, worth enabling while there); capabilities map;
`BROWSER_TAB_BROWSERS` env parsing + CLI `--browser` choices; options-page
dropdown; `.usage.kdl` + regenerate completions/man/docs (never hand-edit);
`.env.example` if any default browser list is spelled there. Contract note:
adding an enum member is ADDITIVE — v2 stays, no version bump (same rule as
the enrichment fields).

### 4. cgWindowId oscillation (macOS) — the open product bug

Evidence in the entry above this one. **Hypothesis, unverified:** the
event-driven merge path (`extFeedTtl`/`onSnapshot` → `merge()` →
`enrichWithCgWindowIds`) runs correlation without the yabai title borrow
(`needsTitleTiebreak` gate), so during window churn every same-bounds window
is ambiguous → ids DROPPED; the next full poll repairs. **Plan shape:**
instrument `correlateSnapshot` inputs (candidate count, title availability,
which tier resolved) on BOTH paths for one churn cycle before changing
anything — measurement over hypothesis is the session's proven lesson. Do
NOT widen `BOUNDS_TOLERANCE_PX` (documented anti-fix). Consumer impact is
real: the join nulls out exactly while windows are being rearranged, which
is the wm-stack's moment of need.

### 5. TUI — polish now, primitives soon

Polish (small, unblocked): clear `message` on every setMode transition
(stale-message re-surface, found in the drive); half-page motions don't
retire the message (`onHalfPageDown/Up` lack the clear the comment claims);
`list --fields summary` CLI header prints "0 tabs" — it counts tab ROWS
(summary empties them by design) instead of summing `tabCount` (found in the
Windows round-trip).

Primitives (blocked on tui-kit, agreed 2026-08-21): Miller columns are DEAD
(argued down jointly with EQStack); the kit ships `fitToWidth` (exact-width
postcondition `=== n`), `lineWindow`, `scrollbarThumb`, `navReduce`,
`allocateWidths` with `collapseTo: number | "drop"` — the drop/collapse
discriminator is CONTEXT collapses, ELABORATION drops (my detail pane
drops). Keys stay app-side (unanimous). browser-tab is FIRST CONSUMER when
they land: port renderRow/viewport, add the scrollbar, then the sticky
detail pane; screenshot-in-terminal stays a research spike behind that.

### 6. Extension identity + pairing

Manifest `key` (§ above): do it as its own small PR; the manifest is
release-please-rewritten and Biome-excluded, so touch carefully. THEN the
pairing flow: an options-page "fetch token from local daemon" button hitting
a localhost route — kills the per-machine paste forever (tonight's Windows
hookup needed clipboard gymnastics through RustDesk's clipboard sync, which
OVERRIDES the remote clipboard from the local one — gotcha for anyone
repeating it). Same capability-URL/auth question as SK mechanism A — solve
them together with one pattern.

### 7. Windows box — standing state and ops gotchas

State: repo `C:\Users\georg\repos\browser-tab-mcp`, branch `win-test` (reset
to main + open fixes as needed — REBUILD IT with `git checkout -B win-test
origin/main` + merge, never merge post-squash main into the old integration
branch: that conflicts by construction). Daemon console-scoped in tmux
`bt-windows:win-daemon` (dies with the SSH; ONLOGON deliberately NOT
registered — George's headless-goal decision pending). Extension loads from
`D:\browser-tab-mcp\dist` (path IS its identity until the manifest key
lands; refresh IN PLACE). Unpacked-extension records live in Chrome's
`Secure Preferences`, NOT `Preferences`. Two resident agents (`elevated`,
`pc-server`) — brief them before machine-state changes; never
`wsl --shutdown` unwarned; WSL interop relay sockets die progressively
(cause unknown) — repoint `WSL_INTEROP` at a live socket AFTER checking its
token elevation (both directions of the hazard are silent).

### 8. Cross-cutting gotchas any plan should inherit

- "CI cannot falsify an assumption it also satisfies." Three bugs tonight
  (#76 rustc preinstalled, #78 backslash+phantom, #81 poll-supplied
  `running`) were all invisible because the CI environment supplied what the
  target lacks. When a plan claims CI coverage, ask what the runner provides
  for free.
- Harnesses must be unable to exit 0 without reaching their own verdict
  (exitCode preset + child-exit rejection, #78). Audit other harnesses for
  the unref'd-timer drain shape before trusting their green.
- Sabotage checks: unique anchors; rebuild built packages between sabotage
  and run; `git checkout <file>` can't restore an UNTRACKED file and on a
  branch restores the BRANCH version (wipes uncommitted fixes) — verify
  file state after every restore.
- tmux/shell: completion markers match their own command echo (grep `^X=` is
  not enough on wrapped lines — use unique values, verify in-pane);
  `cmd | tail; echo $?` reports tail's; zsh globs bare `==`/`:a`; PowerShell
  `$LASTEXITCODE` only after NATIVE commands.
- readme-check evaluates the PR title from the FROZEN event payload —
  retitling needs a new synchronize event (empty commit) to take effect.
- release-please force-updates the release branch on every main push; merge
  fix PRs BEFORE the release PR so the release carries them.

### Deferred, standing, unchanged
Safari 30-min idle soak + Chrome SW-kill soak (need a human-adjacent
browser); coverage ratchet + npm publish (George-deferred); ~45 stale remote
branches (offer before deleting); mechanism-B console check (10s, George's
Mac). Daemon/extension deployment on the MAC is now one release behind
(v1.3.1 deployed, v1.3.2 cutting) — redeploy is user-gated as always.

## 2026-08-21 — PARKED: tab selection & arrange DSL (its own project, George's call)

George, verbatim: "all the ideas you had regarding the selection features -
park and defer them - because that's a project in and of itself". Designed in
session 5a15fe80 (post-compact), presented, then parked BEFORE planning. What
follows is the full design so unparking restarts from here, not from zero.

**Origin request (George, condensed from his message):** confirm/build tab
swapping, group tab targeting, window targeting; move relative (±N) and
absolute (negative = offset from far end); selections relative ("X and Y tabs
left, Z right"), absolute ("first X of window Y"), arbitrary id lists across
windows, and combinations of prior selections; transformations and
info-requests applicable to any selection; and an end-state mode where an AI
declares the final arrangement and the tool computes+applies the moves itself.
**He had one more addressing/selection/movement mode he forgot** — never
identified. When unparking, re-present the set below and let him check it
again ("scatter/distribute across N windows" was offered and not confirmed).

**What exists today (verified 2026-08-21):** cross-window absolute move only
(`move_tab {targetWindowId, targetIndex}`); same-window reorder throws without
an explicit targetWindowId (`extension-core/src/commands.ts:475`); no relative
move, no negative index (`MoveTabInputSchema` targetIndex `min(0)`,
`shared-types/src/tools.ts:130`), no swap, no multi-tab actions (`tab_action`
is single-tab), no selections beyond explicit id lists in `group_tabs`.

**Design spine:** selections and destinations share the same addressing
families — identity, absolute position, relative position — as recursive
Zod-validated JSON (no string parser). Selector families (6): identity
(handle lists / window / group), absolute (window slices, Python semantics,
negatives from end), relative (anchor ±left/right, `between`, `@active`
sugar), predicate (url/domain/title glob, pinned/audible/muted/discarded/
grouped, browser), time (lastAccessed bounds, journal MRU rank), set algebra
(union/intersect/subtract/complement-within; selections ORDERED, document
order default, `orderBy: mru|domain|title`). Transformations (7): move
(destination `{by:±N}` | `{to:i}` | `{window,at}` | `{newWindow}` |
relational `{beside: tab, side}`; multi-tab lands as contiguous block in
selection order), swap (pairwise/block), sort-in-place (domain/title/
recency/pinned-first), group/ungroup (lifts group_tabs), act (fan any
TabAction with per-id skip reporting), query (selection → list_tabs rows),
arrange (end-state: `windows: [{window: w|"new", tabs: [final order],
groups}]`, LIS-based minimal-move solver, unlisted tabs stay put,
`strict:true` for full coverage, `dryRun:true` returns the op list unapplied).

**Tool surface:** two new tools — `select_tabs {selector}` (read) and
`arrange_tabs {selector, transform} | {endState}` (one transform per call;
composition lives in the selector algebra). Single-tab tools untouched except
`move_tab` gaining same-window / negative-index / `by:±N`.

**Executor gotchas (why it's daemon work):** ops computed against a pinned
resolve-snapshot then translated to live indices in a non-invalidating order;
`tabs.move` index echo lies (final `tabs.get` is the honest answer,
`commands.ts:482-491`); pinned tabs are a separate index space that clamps;
moving a grouped tab silently ungroups; group spans contiguous; no
transactions — report per-op results + actual final state; extension-only
(x-handles), AppleScript errors actionably, capabilities-gated; per-id
validation + immediate post-command snapshot, per group_tabs precedent.

## 2026-08-21 — corrections to the BRIEF (found while planning; session 5a15fe80 post-compact)

Code exploration for the implementation plans (docs/agent-handoff/plans/) falsified
two BRIEF claims — recorded here so nobody re-inherits them:

- **BRIEF §3 (Edge), `types.rs` mirror:** WRONG. `apps/rust-accel/src/types.rs`
  holds only four `#[napi(object)]` structs, no browser enum, and the drift test
  regexes `pub struct` only. Adding `"edge"` to `BrowserIdSchema` needs zero
  Rust work. Also `makeAdapter` (dispatch is `!== "safari"`) and
  `applescriptCaps` (derived fn) need zero edits.
- **BRIEF §4 (cg oscillation), the working hypothesis:** CONTRADICTED as
  worded. There is no borrow asymmetry between paths — `correlateSnapshot` has
  ONE caller (`correlate.ts:379`, inside `enrichWithCgWindowIds`) and both the
  poll tick and the extension-event remerge reach it via `merge.ts:80` with the
  title-borrow gate intact; the poll's extra correlation (`engine.ts:115`) is
  discarded for extension-fed browsers. Surviving mechanisms (M1 stale
  lastPolled bounds vs fresh CG read on remerge — strongest, explains Safari
  nulling on Chrome events; M2 silent yabai failure — bare catch at
  `correlate.ts:111-113`, zero logs; M3 sibling-claim cascade at
  `correlate.ts:344`; M4 empty display origins) are encoded as the decision
  table in `plans/2026-08-21-cg-oscillation-instrumentation.md`.

## 2026-08-22 — BRIEF §3 (Edge) SHIPPED on feat/edge-first-class

The brief's claim that `types.rs` held a browser enum was incorrect — `apps/rust-accel/src/types.rs` contains only four `#[napi(object)]` structs; the drift test regexes `pub struct` only. Adding edge to `BrowserIdSchema` required zero Rust work. Also, `makeAdapter` (dispatch is `!== "safari"`) and `applescriptCaps` (derived function) needed zero edits — Edge inherited the correct capability path from its enum membership without code.

## 2026-08-22 — post-sweep backlog (George: "add all these to the backlog/parked items/todo list" — one register, this file)

### B1. CI: `e2e-branded` reintroduced install+build duplication
The core `build-test` matrix IS de-duplicated (verified `ci.yml:66-141`: lint, shellcheck, typecheck, TS-fallback test, coverage, usage-artifact check, npm-tarball check are Linux-only; every OS leg runs only install → build → native-path test → stress; macOS ~1.5 min, ubuntu ~3 min, windows ~5 min). The `e2e-branded` job (#92) is a two-row matrix and each row does its own install + build, so Windows now installs+builds **three times per PR** (core leg + two e2e rows), ubuntu twice — ~3–4 min of redundant runner time, $0 on the public repo, no wall-clock cost because rows run in parallel. Cheap fix if minutes ever matter: collapse the two rows into one job with sequential test steps (saves two install+builds, costs ~2 min serialization); richer fix: share the built `dist/` via upload/download-artifact across all e2e jobs. **Decision pending George: minutes vs wall-clock.** Also: the stress step label says "10 cases" — it is 14; relabel.

### B2. Testing gap: the real-browser-effect layer
Coverage is strong for the daemon/MCP/dispatch core (648 unit+integration+contract tests, 14-case stress harness with honest verdicts, TUI render + soak, e2e in three real-browser environments). The gap: the e2e suite has 3 tests, while the 2026-08-22 manual sweep exercised ~25 command surfaces — everything outside load/list/move is verified only against the fake adapter, which asserts *dispatch*, not *effect*. Evidence from the sweep: `discard` swaps the tab id (invisible to a fake); `back`/`forward` no-op on tool-built history because Chromium's history-manipulation intervention marks gestureless entries skippable — they work on human history (verified on George's real Edge tab: two hops landed exactly where he predicted), but **no test builds gestured history, so neither behaviour is pinned**. Two further classes surfaced this cycle: defects only a second daemon or a real deployment can expose (the global-pipe e2e isolation hole, the Windows phantom stress pass) — "the harness is more provisioned/cleaner than the target"; and `e2e/**` sits outside `apps/chrome-extension/tsconfig.json`'s include, so CI never typechecks it. Safari stays manual-only by necessity; coverage is collected but not gated (`COVERAGE_GATE` dormant).

### B3. Proposed e2e structure: the command-sweep suite (next-cycle candidate, spec = PROGRESS-LOG 2026-08-22 "later still" entry)
The fixtures are the right foundation already (channel-parameterized, IPC-isolated throwaway daemon, seeded config). Turn the manual sweep into a Playwright suite with **dual-truth assertions**: every command is driven through the real daemon path, then verified against BOTH the daemon snapshot AND Playwright's direct view of the browser (`sw.evaluate(() => chrome.tabs.get(id))`, `page.url()`, scroll position) — the second truth is what catches the back/discard class. Shape:
- `apps/chrome-extension/e2e/sweep/` — one file per family: tabs (open/close/move/duplicate/discard), actions (mute/pin/navigate/reload), groups, focus + window-state (minimize→focus→`wasMinimized` contract), perception (page ×3 modes, screenshot, annotate), data (history/journal/bookmarks), transport (MCP stdio + HTTP — the two probe scripts from the sweep become tests).
- `back`/`forward` tested with a **Playwright-clicked link** (a real gesture) — pins both "works on gestured history" and "skips tool-built entries".
- Runs unchanged across ubuntu-chromium, windows-chromium, windows-msedge via the existing matrix; runnable on the box on demand (`E2E_BROWSER_CHANNEL=msedge`) — the 90-minute manual sweep becomes a ~3-minute command.
- Add `e2e/**` to the chrome-extension tsconfig include so the suite is typechecked.
- Sweep small-finds to fold in as they are touched: `tab_action discard` result should carry the replacement id (or document the swap); tier-2 disabled-error wording is macOS-flavoured on Windows; Windows snapshots echo the macOS `bundleId`; doctor's stamp-drift hint always blames the extension side even when the daemon is stale; `bookmark update` needs an unambiguous test (the sweep's evidence was masked by folder-remove cascade).
Execution: plan doc in `docs/agent-handoff/plans/`, subagent-driven like the 2026-08-22 plans. **Pending George's pick for the next cycle.**

### B4. De-vendor `packages/mcp-kit` → published `@george43g/mcp-kit` (GEORGE-GATED)
Peer session `mcp-cli-toolkit` published mcp-kit and stopped vendoring it (their PR #100). **Not actioned** — de-vendoring is a dependency change on a shipped bin and needs George's word.

Verified against the published tarball (0.1.0, `npm pack`, 2026-08-22 — do NOT pin this number, re-read `npm view` at migration time):
- **Public-surface diff is exactly two items, by enumeration** (`packages/mcp-kit/src/index.ts` vs `package/dist/index.d.ts`): ours adds `sanitizeContent`, theirs adds `startHttpServer` + http types (dead weight for us, we stripped that transport).
- **`toContent` / the `text|image` `ContentBlock` union are ALREADY upstream** (`dist/tool-registry.d.ts:26,68`) — the `screenshot` image-block unlock is not a blocker. Verified, not assumed.
- **The dev gate default is INVERTED.** Published `dist/dispatch.js:37` — `def?.devOnly === true && opts.devOnlyEnabled !== undefined ? !opts.devOnlyEnabled() : false` — a `devOnly` tool with no predicate is **callable** (fails OPEN). Ours (`src/dispatch.ts:87`) fails CLOSED.

**Why this is safe for us anyway, and what to keep true:** we have exactly ONE construction site — `apps/browser-tab-mcp/src/dispatcher.ts:28-38`, memoised — and it already passes `devOnlyEnabled: devModeEnabled`. So migration is zero call-site changes. The guarantee is held at OUR boundary by `scripts/stress-mcp.ts:596-597` (`get_logs` unreachable without `MCP_DEV`, over the real stdio transport, all three CI legs) — that assertion survives de-vendoring and goes red if anyone ever drops the predicate. **Add a colocated dispatch-level unit test pinning the same thing** so it isn't only in the stress harness; that is the whole cost of migrating.

**Position sent to the peer:** take their option (B) — they lift `sanitizeContent` upstream (keep semantics exactly: null-safe, returns `""`, 1MB cap with marker; two functions, not one with a flag — `daemon/index.ts:643` needs non-null and no re-clipping, pinned by `tests/content.integration.test.ts:119`), we pass the predicate explicitly as we already do. Argued **against** their option (A) (flip the published default): it fixes a silent default with another silent default, and our tree is a no-op for it either way so it is not evidence for the flip. Counter-proposed **(D)**: `buildDispatcher` should THROW at construction when the registry holds a `devOnly` tool and no predicate was passed — unaffected consumers stay unaffected, the ambiguous state becomes unrepresentable, and the failure is loud at the moment of the mistake. Same 1.0.0 breaking marker as (A), stated honestly.

**Unverified:** that stress case 14 catches a dropped predicate *under published mcp-kit* is reasoned from the two snippets, not executed — no build against 0.1.0 has been run. Offer stands to prove it in a scratch worktree.

**Resolved 2026-08-22 (peer round 2):** peer ACCEPTED (B) and is taking **(D)** to George in our name instead of (A). They withdrew the request to execute the stress-case check (inference sound, not load-bearing). `sanitizeContent` is being lifted verbatim as a separate function, landing in the same mcp-kit release as whatever George decides on the default — **publish timing is George's call, so treat it as unknown.**

**Their finding, which is the evidence for D:** the template's own generated app `apps/example-repo-mcp` filters `tools/list` (`src/index.ts:41,55`) but does **not** pass `devOnlyEnabled` (`src/dispatcher.ts:26-31`) — so `get_logs` ships hidden-but-callable-by-name into every scaffolded repo. They are fixing that one-liner as its own change, ahead of the de-vendor.

**Why that matters here:** THIS repo has both layers and always has — `src/index.ts:48` (list filter) + `src/dispatcher.ts:36` (dispatch gate) + `src/tools/registry.ts:59-61` (`devModeEnabled`) — proven by `scripts/stress-mcp.ts:596-597` on all three CI legs. The mcp-kit-side option was upstreamed; the app-side wiring was not. Two sibling repos disagreed on a shared invariant and nothing in either tree could surface it. **Do not let this repo's second layer be "simplified away" during the de-vendor** — the list filter alone is exactly the gap `devOnlyEnabled` exists to close.


## 2026-08-22 (late) — folded in from the command-sweep research + three re-verifications

Everything below was MEASURED this session. The full evidence lives in
`plans/2026-08-22-command-sweep-research-brief.md` and
`research/2026-08-22-command-sweep/R1…R9.md`; these are the register rows so the
findings don't live only in a brief.

### B5. `env-loader` reports 0% coverage while fully tested — ROOT-CAUSED, not fixed
`packages/vitest-config/vitest.shared.ts:37` excludes `src/**/index.ts` as a
barrel-file heuristic. That is correct for four packages (their `index.ts` is
6–11 re-export lines) and **wrong for `env-loader`, whose `index.ts` is a
102-line implementation with zero re-exports and is the package's only source
file.** It has 12 passing tests and reports 0/0/0/0.
**Blast radius:** anything arming `COVERAGE_GATE` must fix this FIRST, or the
gate blocks a fully tested package — and the instinct under gate pressure is to
write tests that already exist. Every real coverage gap inside that package is
also invisible today.
**Two fixes, neither applied:** (a) narrow the heuristic to exclude actual
barrels rather than the filename — more correct, touches everyone; (b) a
per-package override in `packages/env-loader/vitest.config.ts` (today
`export default shared`, byte-identical to mcp-kit's) — one file, no risk to
others. Take (b) now, (a) only if the gate is ever armed.

### B6. `e2e/**` is typechecked NOWHERE in the repo
Not merely excluded from one config: `apps/chrome-extension/tsconfig.json` has
`include: ["src/**/*.ts", "vite.config.ts"]`, and `tsc --listFiles` on the real
typecheck run lists **zero** files under `e2e/`. Playwright transpiles specs via
esbuild and never invokes `tsc`. **A type error in a fixture cannot fail CI
today.** Fix is one line in the tsconfig include, but it will surface whatever
type errors are currently hiding — budget for that, don't assume it's free.

### B7. `discard` needs its OWN e2e spec — and the id-swap is now CONFIRMED
Three runs against real Windows Edge: `chrome.tabs.discard(id)` returns a tab
whose id **differs** from the one passed in (`239550782`→`239550786`,
`229934170`→`229934174`, `263071999`→`263072002`). First hard evidence of the
id-swap anywhere in this project, and exactly what a fake adapter cannot model.
Afterwards the Playwright context dies (`EVT::context-closed`, `pages=0`, worker
gone). **The obvious explanation was tested and REFUTED** — a keep-alive page
did not save it, so it is not a last-page teardown artifact.
**NOT a product defect:** discard against George's real, non-automated Edge
leaves the browser alive; the teardown appears only under a Playwright/CDP-driven
headless context. Do not report it as "our command crashes browsers."
**Consequence:** discard IS testable — assert the RETURN VALUE, which arrives
before the teardown — but only in its own spec whose fixture expects
termination. Never in a shared-context describe block, or it takes the siblings
down and the failure looks like theirs. macOS's bundled Chromium behaves
differently again (hard `SEGV_ACCERR`, no return value), so any acceptance
criteria must name their environment.

### B8. The AppleScript path has ZERO real-browser exercise, anywhere
`osascript` is mocked or fixture-substituted at every layer, for list, focus,
tab_action, open_tab, open_window, set_window and doctor's TCC probe. A
Playwright/Chromium suite **cannot reach this path at all**. So "the testing
gap" is two gaps: (a) the extension path, which a sweep suite can close, and
(b) the AppleScript path, macOS-only, which it cannot. Any plan must say which
it is closing and must not imply it closed both. No strategy exists for (b) yet.

### B9. back/forward is a BEHAVIOUR TO PIN, not a bug to fix
Verified working in both directions on George's real gestured Edge history. The
apparent no-op is Chromium's history-manipulation intervention skipping
gestureless entries — which the tool's own `navigate` creates. A test must build
history with a **real Playwright click** (over local HTTP; `data:` URLs do not
work), and should ALSO pin the gestureless case so the intervention is documented
in CI rather than rediscovered. Proven feasible — see R2/E2.

### Re-verifications of three items that had gone stale (2026-08-22)
- **tui-kit `StatusBar` gap — STILL OPEN.** Re-read at **0.5.1**: the component
  is `justifyContent: "space-between"` with **no** margin or gap between the
  message `Text` and the hint `Text`, so a long message still abuts the hint.
  Upstream fix, do not patch locally.
- **cli-kit REPL `Ctrl-C` — STILL OPEN.** Re-read at **2.0.1**: `repl.js`
  registers **no** `rl.on("SIGINT")` handler, so Ctrl-C falls through to
  readline's default and kills the session instead of cancelling the line.
  Upstream fix, do not patch locally.
- **TUI message-clear — HALF FIXED.** The half-page half SHIPPED in the
  primitives port: `halfPage` clears at `apps/browser-tab-mcp/src/tui/App.tsx:223`
  (and `gg`/`G` clear likewise). **The mode-EXIT half is still open** — the
  `setMode({kind:"browse"})` returns at `App.tsx:280, 285, 301, 308, 316` do not
  clear `message`, while the mode-ENTRY paths at `:351, 363, 376` do. Whether
  that fully explains the originally-reported "stale message re-surfaces after
  confirm-close cancel" is **unconfirmed from code alone** — entry already
  clears, so the reported trigger may differ. Needs one live TUI check.

### B10. Pointer: the selection-DSL + deep-control-architecture work is UNTRACKED and USER-GATED
Recorded here because BACKLOG.md did not mention it at all, so it was invisible
to any register built from this file. **This is another agent's work — a Codex
session, 2026-08-22 — and this row is a POINTER, not a restatement; do not edit
their documents or their PROGRESS-LOG entry.**

Three artifacts sit **untracked** in the working tree:
- `docs/tab-selection-transformation-language-spec.md` — the canonical spec
  (~1524 lines), with appended §23–27 on whole/multi-window selection, same-kind
  composition, structural projection, preflight blocking of multi-domain live
  movement, schema-version vs snapshot-revision, a smaller effect IR with a
  `setOrder` escape hatch, and a phased risk-coherent MCP surface.
- `tab-selection-transformation-language-spec.md` (repo root) — an OLDER
  DUPLICATE, deliberately left unchanged by its author. Do not "reconcile" the
  two without asking; the `docs/` copy is canonical.
- `docs/deep-application-control-platform-architecture.md` — companion
  architecture proposal: one monorepo while concepts evolve, separate
  MCP/CLI/TUI products per coherent domain family, exactly one generic
  `control-language` package first, no universal mutation MCP, optional
  federation/supervisor only after measured demand.

**Status: USER-GATED, explicitly.** Its author's stated next step is that George
reviews the reduced transform set, the phased five-tool MCP surface, the
`control-language` naming, and the browser/tmux product boundary — and that **no
implementation plan or code should start until those choices are accepted or
revised.** Also note the untracked PROGRESS-LOG entry describing it was still
uncommitted as of 2026-08-22; if it is still uncommitted when you read this, it
is at risk, but it is not yours to commit.

### B11. The CLI never brands its log prefix — its NDJSON lands in a SHARED `$TMPDIR/mcp/` bucket
Surfaced 2026-08-23 answering a cross-session query from the `dotfiles` session,
which is building a Vector collector that ships MCP NDJSON logs to g-home-server
off an **explicit prefix list**. It had found two prefixes; there are three.

`setLogFilePrefix` has exactly three call sites (`src/index.ts:36` and
`src/tui/index.tsx:27`, both `APP_NAME` minus scope → `browser-tab-mcp`;
`src/daemon/index.ts:875` → `browser-tab-daemon`). **`src/cli.ts` never calls
it**, so every dispatcher-routed CLI subcommand falls through to robustness's
default — `logFilePrefix() => envStr(key("LOG_PREFIX"), "mcp")` and
`getLogDir() => envStr(key("LOG_DIR"), join(tmpdir(), logFilePrefix()))`
(`@george43g/robustness@0.11.0` `dist/logger.js:80,171`).

Reproduced with an isolated `TMPDIR` against the built bin: `list --json`,
`journal` and `history` each create `$TMPDIR/mcp/` holding one
`{"level":"perf","msg":"dispatch.<tool>"}` line. `doctor` and `daemon status`
create nothing — they do not route the dispatcher.

Why it matters beyond tidiness: `$TMPDIR/mcp/` is **shared**. On George's Mac it
is currently dominated by `"entrypoint":"@george43g/example-repo-mcp"`, and our
own **vitest runs write there too** (reproduced — `ws_disabled`/`ws_listening`
lines under an isolated `TMPDIR`). So an observability collector cannot take our
CLI stream without also taking another tool's logs and our test output. Our two
branded prefixes are clean by contrast: `withDaemonEnv`
(`packages/test-kit/src/fakes/daemon-env.ts:76-90`) redirects only
`BROWSER_TAB_CACHE_DIR`, never the logger.

**Fix is one line** — call `setLogFilePrefix` in `src/cli.ts` with the same slug
`src/index.ts:35` computes (or a distinct `browser-tab-cli`). **The durable fix
is the guard**: a test asserting every process entry point brands its prefix.
`cli.ts` drifted silently and nothing failed; the next entry point will too.

Related, checked in the same pass and all clean: no production config sets an
absolute `MCP_LOG_DIR` (`.mcp.json` carries only `MCP_DEV*`; the LaunchAgent
plist has **no `EnvironmentVariables` key**; no `.env*` exists but the committed
`.env.example`). The one setter is `apps/chrome-extension/e2e/fixtures.ts:82`,
scoped to a spawned-process env object. Two traps for anyone auditing this:
`BROWSER_TAB_LOG_DIR` (`daemon/paths.ts:117`) is a **different stream** — the
launchd stdio redirect at `~/Library/Logs/browser-tab` — and `MCP_LOG_PREFIX`
renames the whole **directory**, not just the filename.

Also settled in that pass, for anyone who wondered: the launchd daemon sees the
**same `$TMPDIR` as an interactive shell**. `launchctl list` → pid 27327;
`ps eww -p 27327` → `TMPDIR=/var/folders/2m/…/T/`, identical to the shell's, no
log override in its env; and `$TMPDIR/browser-tab-daemon/browser-tab-daemon-27327-*.ndjson`
is the pid-matched anchor. Scope limits: that is the per-user **LaunchAgent**
case (a system-scope LaunchDaemon would not inherit it — we ship none, and
cannot), and **Windows is unrelated** (Task Scheduler task, `localAppData()`).

**Amendments, 2026-08-23, after two more rounds with the `dotfiles` and
`mcp-cli-toolkit` sessions:**

- **Slug decided: `browser-tab-cli`, distinct — not the `browser-tab-mcp` slug.**
  The reason is retention, not naming. `pruneLogs`
  (`@george43g/robustness@0.11.0` `dist/logger.js:245-263`) keeps N files **per
  directory**, default 5 (`keepLogFiles`, line 66), and protects only a live
  process's *newest* file. The MCP server is long-lived and one-file-per-session;
  the CLI is one file per invocation. Share a directory and a handful of
  `browser-tab list` calls evict the MCP server's prior sessions. Separate
  prefixes give each stream its own budget.
- **The mis-prefixed burst in the live `$TMPDIR/mcp/` was our own test suite** —
  identified, not inferred: `pnpm --filter browser-tab-mcp test`, 2026-08-22
  23:57:48 AEST (67 files / 648 tests), six vitest workers whose records all fall
  in 13:57:48–13:57:54.5Z. The `EADDRINUSE on 127.0.0.1:8790` in them is workers
  racing the real launchd daemon for the extension WS port. Two distinct paths
  reach that bucket: tests (never enter `runMcpServer`/`runTui`/`runDaemon`, so no
  prefix is ever set) and **real CLI invocations** — which are operational data
  with no duplicate anywhere else.
- **Our NDJSON carries no URLs or page titles — verified negative.** 0 lines
  matching `https\?://` across `browser-tab-daemon/`, `browser-tab-mcp/` and
  `mcp/`; the daemon's 224KB file is `heartbeat` ×998, `event_loop_lag` ×104,
  `cg_correlate` ×102 plus lifecycle records. No log call site in
  `apps/browser-tab-mcp/src` or `packages/mcp-kit/src` references url/title/href.
  The one plausible vector was chased: `logError(\`dispatch_error: ${name}\`,
  { message, stack })` (`packages/mcp-kit/src/dispatch.ts:149-152`) copies
  `err.message`/`err.stack` verbatim, but the four URL-refusal throws that could
  echo a URL interpolate only the **scheme**
  (`detect/adapters/{safari,chromium}.ts:44,256`). **Scope: current corpus plus
  present-day call sites — not a guarantee about future records.** A
  `dispatch_error` is one thrown URL away from carrying one, so this wants a test
  rather than a standing measurement. Matters because a Vector collector is being
  wired to ship these logs to g-home-server; **whether browser-tab is collected at
  all is George's call, not the collector's.**
- **Argued against a runtime warning as the class fix.** `mcp-cli-toolkit`
  proposed that the logger warn when it opens under the default prefix. That
  warning is written into the very file that is mis-located — here, into
  `$TMPDIR/mcp/`, the directory nobody collects, and for the six test-worker files
  into processes with no `startup` record at all, so it would not have fired.
  A test-time assertion over the entry-point set fails on a developer's machine
  before the artifact ships. That is the shape to build.

**Two late corrections to the amendments above (2026-08-23), both raised in the
peer thread and both changing where the fix belongs:**

- **The "assert every entry point brands its prefix" test was MY proposal and it
  is the weaker shape — do not build it.** It inherits the exact defect of the
  prefix list it replaces: enumerating entry points is a judgement call, and it
  would have caught `cli.ts` only if someone had thought to list `cli.ts`, which
  is what nobody did. **Build the behavioural version instead:** spawn every
  subcommand the bin dispatches, under an isolated `TMPDIR`, and assert no
  default-prefix directory appears. The subcommand set comes from commander's own
  registered-command table, not a hand-written list, so a new subcommand is
  covered the day it is registered; and it asserts the observable outcome, so it
  catches both known mechanisms (a missing call, and a call that runs after the
  first write fixes `logFilePath`) without needing to distinguish them. Residual
  gap, stated rather than hidden: it covers what the bin dispatches, NOT library
  entry points imported in-process — which is the vitest case. Test workers are
  not a shipped surface, so that gap is accepted.
- **The URL-leak guard belongs in `@george43g/mcp-kit`, not here.**
  `packages/mcp-kit/src/dispatch.ts:149-152` — the `logError` that copies
  `err.message`/`err.stack` verbatim — is kit code, so the leak path is
  structural and every consumer of the dispatcher has it. The guard goes beside
  it and everyone inherits it; ours reduces to a thin check that our own throws
  interpolate only `url.protocol`. Raised by the `mcp-cli-toolkit` session.

Also worth recording because it changes the argument for a template-level fix:
**`apps/example-repo-mcp/src/cli.ts` has the identical hole** — `grep -c
'setLogFilePrefix('` → 0, reproduced there against its built bin under an
isolated `TMPDIR` (`mcp/mcp-97487-…ndjson` holding one `dispatch.health_check`
span). Two independent instances in two repos generated from the same scaffold:
this is a template defect handing every new repo the same hole, not two local
bugs.

**Why the URL guard is needed at all — do not close it as "redaction covers
it".** Measured by the `mcp-cli-toolkit` session 2026-08-23: the logger DOES
redact before writing (`redactString` over `msg`, `redactValue` over the payload,
when `redactionEnabled()`), but **redaction has no URL rule** — phones,
secret-shaped tokens, and emails-if-opted-in, that is the whole set. So a URL in
an `err.stack` passes straight through the redaction layer to the file. That
turns B11's URL finding from a measurement into an argument: the reason a
*future* throw would not be caught is that nothing between the throw and the
file is looking for a URL. "Redaction covers it" is the sentence someone would
reach for to close the `mcp-kit` guard as unnecessary, and it is false.

Anchor note: line numbers cited in this row are the **published artifact**,
`@george43g/robustness@0.11.0` `dist/logger.js` — `setLogFilePrefix` 77-79,
`logFilePath` declaration 166, `writeStderrLine` 156, `ensureLogFile` 264,
`pruneLogs` 245-263, `_resetForTests` 520-522. The template repo's own records
cite its `packages/robustness/src/logger.ts` source lines for the same things.
Both are correct; they are different trees.
