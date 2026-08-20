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
- First release: the prediction of `0.1.0` was **wrong** — the live run
  proposes **`1.0.0`** (release-please's initial-release default; PR #31).
  Accept 1.0.0, or pin `"release-as": "0.1.0"` in `release-please-config.json`
  for one cycle? Changelog spans full history either way unless
  `bootstrap-sha` narrows it (`docs/RELEASE.md` § "First release").
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
