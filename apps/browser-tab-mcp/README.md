# browser-tab-mcp

macOS browser-tab detection & management for the yabai/Hammerspoon wm-stack —
one bin (`browser-tab`) that runs the MCP server, CLI, TUI, and launchd daemon.

## Quick start

```bash
pnpm install
pnpm build           # compile TS + (optional) Rust accelerator
pnpm test            # run unit + integration tests
pnpm stress          # 25-case robustness harness
```

## Global install

The build is self-contained: `@george43g/*` workspace packages bundle inline,
so the bin installs and runs outside the workspace with only its real npm deps.

```bash
pnpm build                                   # dist/ must exist first (no prepare hook)
pnpm --filter @george43g/browser-tab-mcp exec pnpm add -g .   # or: cd apps/browser-tab-mcp && pnpm add -g .
browser-tab --version
browser-tab doctor                           # engine: ts, correlation: yabai (see note)
browser-tab list                             # list open windows/tabs
```

**Native accelerator on a global install:** the arch-specific rust-accel `.node`
is not shipped in the package, so a global bin runs the TypeScript path.
cgWindowId correlation then falls back from native `CGWindowList` to
`yabai -m query --windows` (tier 2) — always present in the wm-stack, so the
yabai join is preserved. Only `focusedBrowser` z-order, `display`-targeting for
window placement (explicit `bounds` still work), and the doctor Screen-Recording
preflight degrade, all gracefully. Run from the workspace build (`node
dist/cli.js …`) to get the native tier.

## Build identity

Every artifact carries a build stamp — `<semver>+<count>.<sha>[.dirty.<ts>]`:

```bash
$ browser-tab --version
0.9.0+412.a1b2c3d (built 2026-08-09T06:12:00Z)
```

Semver only moves on release, so it cannot distinguish two builds *between*
releases — which is exactly how a rebuilt-but-never-reloaded extension keeps
reporting a plausible version. The stamp changes on every build:

- **`count`** — `git rev-list --count HEAD`, so you can tell at a glance which
  of two builds is newer. Derived from history rather than a committed counter,
  so it survives clean checkouts and agrees between a laptop and CI.
- **`sha`** — ties the build back to source.
- **`.dirty.<ts>`** — uncommitted changes, plus a minute-resolution timestamp so
  successive dev builds off the same commit stay distinguishable.

It is injected at build time (`scripts/build-stamp.mjs` → Vite `define`) into
both the bin and the extension bundle; `tsx` dev runs compute it lazily from git.
The extension's `manifest.json` `version` must stay bare semver for Chrome, so
the stamp rides in the JS and is reported over the socket instead.

`doctor` and `daemon_status` compare the daemon's stamp against each connected
extension's and warn on a mismatch — catching the case protocol-version
staleness cannot see, where a stale bundle speaks the *same* wire version while
running different code:

```
  ℹ  daemon build 0.9.0+412.a1b2c3d
⚠ chrome extension build 0.2.0+411.9f21ab4 ≠ daemon build 0.9.0+412.a1b2c3d —
  a rebuilt extension is not a reloaded one. Reload it (chrome://extensions).
```

A dirty build of the *same* commit counts as a match — flagging it would cry
wolf on every dev iteration; what matters is the source revision.

## cgWindowId correlation (the wm-stack join key)

Each browser window is stamped with its CGWindowID — the id yabai uses — so
consumers join on an id instead of matching titles. `src/detect/correlate.ts`
groups CG windows by the browser's pid and matches window bounds within ±2px.

**Bounds alone are not enough under a tiling WM.** yabai gives every same-space
window of an app the identical frame, so every window of a multi-window browser
bounds-matches every candidate. Rather than guess, correlation falls through to
a **title tiebreaker**: yabai reports a distinct title per window, and the
snapshot's window title is a substring of it (Chrome appends
`" - Google Chrome - <profile>"`, Safari prepends `"<profile> — "`). Matching is
case/whitespace-insensitive and tiered — exact, then prefix/suffix, then bare
containment — and takes a candidate only when exactly one matches at some tier.

The tiebreaker is deliberately conservative; `cgWindowId` stays `null` when

- no title map is reachable (no yabai on PATH),
- the window or its candidate has no title,
- two candidates' titles match equally well, or
- two windows would end up claiming the same CG window.

The native tier carries no titles of its own (`kCGWindowName` needs Screen
Recording consent), so it borrows yabai's — but only after bounds have actually
proved ambiguous, so an unambiguous poll never pays for the extra subprocess.

**Correlation observability.** When correlation degrades (window ids drop to
`null`), the daemon logs a `cg_correlate` line with per-tier counts (`exact`,
`shifted`, `titleOnly`, `tiebroken`, `nulled`, `claimCollisions`). Set
`BROWSER_TAB_CG_DIAG=1` to log every correlation pass plus `cg_merge_trigger`
staleness lines. yabai query failures log as `yabai_query_failed` or
`yabai_titles_unavailable` — both warn-level; `cg_correlate`/`cg_merge_trigger`
are info-level.

Env: `BROWSER_TAB_CG_DIAG` (0).

## Bin

A **single** bin, `browser-tab`, with subcommands (run `browser-tab --help`):

| Subcommand | Purpose |
|-----|---------|
| `mcp` | MCP server (stdio) |
| `tui` | Ink live tab manager |
| `doctor` / `health` | preflight checks / health snapshot |
| `list` / `journal` / `history` | reads: topology · focus-nav memory · global URL history |
| `focus` / `close` / `open` / `move` | tab commands (true moves need daemon + extension) |
| `act` / `group` / `window` | write-side control: tab actions · tab groups · window ops |
| `page` / `annotate` / `screenshot` | perception: content/state · URL notes · captures |
| `bookmark` (alias `bm`) | bookmark CRUD: `search` · `list` · `create` · `update` · `remove` |
| `daemon run\|install\|status\|token` | launchd daemon lifecycle |
| `logs` | recent server/daemon log lines (**dev-only** — the dispatcher refuses without `MCP_DEV=1`) |
| `repl` (alias `console`) | interactive REPL over the in-process dispatcher |

## Platforms

| | macOS | Windows | Linux |
|---|---|---|---|
| Daemon (IPC, WS, snapshot, journal, history, page, tab-1 screenshots) | ✅ | ✅ | ✅ |
| Connector extension (Chrome/Brave/Chromium/Edge) | ✅ | ✅ | ✅ |
| AppleScript fallback — works with NO extension installed | ✅ | — | — |
| `cgWindowId` correlation (the wm-stack join key) | ✅ | — | — |
| Tier-2 window capture (`screencapture -l`) | ✅ | — | — |
| Safari | ✅ | — | — |
| Start at login | launchd LaunchAgent | Task Scheduler (`ONLOGON`) | run it yourself |

**Off macOS the connector extension is not the preferred source, it is the only
one** — and that is a smaller difference than it sounds, because the extension
is authoritative on macOS too whenever it is connected. What Windows and Linux
genuinely lose is the *no-extension fallback* and the CGWindowID join. Both are
stated rather than simulated: `doctor` prints a platform row saying so, and
every macOS-only command refuses with a sentence naming the platform and the
fix instead of `spawn osascript ENOENT`.

There is no `cgWindowId` off macOS because there is no CoreGraphics to issue
one; the field is `null`, not wrong. The wm-stack consumer is yabai, which is
macOS-only anyway.

### Windows specifics

- **IPC is a named pipe**, `\\.\pipe\browser-tab-<user>`, not a socket file.
  The pipe namespace is machine-wide, so it is namespaced per user. `isPipe()`
  in `daemon/paths.ts` is what makes callers skip the mkdir/stat/unlink work
  that only applies to a real file.
- **State, cache and logs** live under `%LOCALAPPDATA%\browser-tab\`.
- **`daemon install`** registers a Task Scheduler task (`browser-tab-daemon`)
  with an `ONLOGON` trigger, running as the logged-in user. It is deliberately
  not a Windows *Service*: a service needs elevation and runs in session 0,
  where it could not reach the user's browser at all. Task Scheduler has no
  true KeepAlive — the daemon's own watchdog covers the wedged case by exiting,
  and restart-on-failure covers the crash case.

Every platform branch is driven in CI from one runner via
`BROWSER_TAB_PLATFORM`, and `windows-latest` is in the build matrix so the
claims above are tested rather than asserted.

## Bookmarks (`bookmarks` / `browser-tab bookmark`)

CRUD over the browser's own bookmark store, via the connected extension.

```bash
browser-tab bookmark search --query fastify
browser-tab bookmark list --folder 10 --recursive
browser-tab bookmark create --parent 10 --title Vitest --url https://vitest.dev
browser-tab bookmark create --parent 1 --title Reading      # no --url => a FOLDER
browser-tab bookmark remove --id 10                         # a folder takes its subtree
```

**Extension-only, and not merged across browsers.** There is no AppleScript
surface for bookmarks in any supported browser, and the on-disk stores
(Chrome's `Bookmarks` JSON, Safari's `Bookmarks.plist`) are owned and rewritten
by a running browser — the same reason the SurfingKeys research ruled out
touching its LevelDB. So a down daemon is an **error**, not an empty list: an
empty result is indistinguishable from "you have no bookmarks", and a caller
might act on it.

`history` merges across sources because a union of visits is meaningful. A
merged bookmark **write** is not, and a merged `remove` would be destructive —
so exactly one browser per call, inferred when only one extension is connected
and **required** when several are.

Three details worth knowing:

- **A folder is a node with no `url`.** Not `url: ""` — the absence *is* the
  distinction, and it survives the mapping intact. Creating without `--url` is
  how you make one.
- **Rows are flat, with `parentId`.** Chrome nests `children`; every consumer
  here wants rows, and `--recursive` flattens a subtree rather than nesting it.
- **URLs go through the same allowlist as `open_tab`** — and it matters more
  here. A tab opened with `javascript:` runs once; a *bookmark* saved with it is
  a persistent, user-clickable trap that outlives the session.

Availability is the runtime-probed `bookmarks` capability, so gate on the map,
never on the browser name.

### One feature, every surface

**Every tool is reachable from every interface.** MCP defines them, the CLI
fronts all of them, the REPL shares the CLI's dispatcher, and the TUI covers the
per-tab actions. That is asserted, not aspired to:
`tests/interface-parity.contract.test.ts` walks the real commander tree and fails
naming any tool with no CLI command — which is how `get_logs` came to have one.

`logs` is registered unconditionally and gated by the **dispatcher**, not by
hiding it from `--help`. Hiding never disabled anything, and a help text that
changes with the environment would make the generated usage artifacts
un-checkable.

### Option values are validated, not coerced

Every optional flag is either **absent** or a **real value**. An empty one is a
usage error:

```console
$ browser-tab list --browser ""
--browser was given an empty value — omit the flag to leave it unset.   # exit 1
```

This used to be silent, and silently *inverted*: the payload was built with
`opts.browser ? { browser } : {}`, so an empty string was falsy, the key was
dropped, and a query meant to narrow to one browser widened to all of them.
Numeric flags reject non-numbers instead of forwarding `NaN`, and `--tabs`
rejects an empty entry rather than acting on fewer tabs than you named.

### What `doctor` reports

The headline accounts for warnings, because it is the line that gets pasted
somewhere on its own:

```
Doctor: 2 warnings — see below.       # was "Doctor: all clear." with ⚠ rows under it
```

Extension protocol/build staleness are report **items** now, not writes appended
after the verdict — same glyphs, same ordering, and they count. `ok` still means
"no errors", so warnings do not change the exit code; only an `✗` exits 1.

`chromium` is polled by default alongside chrome/brave/edge/safari. It is a
first-class `BrowserId` everywhere else, and leaving it out of the defaults made
it the one browser you had to name explicitly to see; a browser that is not
installed costs one cheap probe and reports `running: false`.

### Tab-group colour is visible

`color` has been in the v2 contract from the start — mapped from Chrome,
writable via `group_tabs --color` — and no renderer showed it. Now `list` prints
`⊞<title>` painted in the group's colour (text stays plain so width maths is
unaffected), and the TUI badge uses a coloured disc (🔵🟢🟡…), falling back to
`⊞` for a colour the palette does not know.

`journal` and `history` timestamps gain a `MM-DD` prefix on rows that are not
from today — those lists routinely cross midnight, and a time-only column put
`23:59:01` directly above `00:05:12`, which reads as mis-sorted.

## HTTP interface (opt-in)

```bash
BROWSER_TAB_HTTP_PORT=8787 browser-tab daemon run
TOKEN=$(browser-tab daemon token)

curl -H "Authorization: Bearer $TOKEN" localhost:8787/snapshot
curl -H "Authorization: Bearer $TOKEN" -N localhost:8787/events        # SSE
curl -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"fields":"core"}' localhost:8787/tools/list_tabs
```

| Route | |
|---|---|
| `GET /health` | liveness + open stream count |
| `GET /snapshot` | the current snapshot |
| `GET /events` | Server-Sent Events, mirroring the socket's `subscribe` |
| `POST /tools/:name` | dispatch any tool; JSON body = its input |

**Off unless `BROWSER_TAB_HTTP_PORT` is set.** There is no default port — a
default would mean an upgrade silently starts listening on a machine whose owner
never asked for it.

Three properties make it safe to turn on, and all three are tested as behaviour:

- **Binds `127.0.0.1`, not configurably.** Omitting the host makes Node listen on
  every interface; on a laptop that joins untrusted networks that would expose
  tab contents and tool dispatch to the LAN.
- **`Authorization: Bearer` only** — never `?token=`, which lands in shell
  history, proxy logs and `ps` output. Constant-time compared, and a missing
  token gets the same answer as a wrong one (a distinct message is a probing
  oracle).
- **No CORS header, to anyone.** The extension already puts this daemon next
  door to arbitrary pages; one that could *read* `/snapshot` would learn every
  open tab.

Tool dispatch goes through the **same `callMcpTool`** the CLI and MCP host use,
so an HTTP caller cannot get different behaviour from the same tool name. SSE
backpressure is **dropped, not buffered** — a live feed, not a queue.

Rationale in full: `docs/agent-handoff/DECISIONS.md` § 2026-08-18.

## Focus & navigation journals

The daemon records an event-sourced history of where the user has been —
which window/tab was focused (and in what order) and each tab's navigation
chain. The connector extension pushes immediate focus/nav `event` frames;
AppleScript-mode browsers get coarser events derived from poll diffs. Read it
with the `journal` tool or CLI:

```bash
browser-tab journal --view windowMru            # windows by last focus (cross-browser)
browser-tab journal --view tabMru --window <id> # a window's tabs by last focus
browser-tab journal --view journey --tab <id>   # a tab's navigation chain
browser-tab journal --view recent               # raw focus tail
```

Each row carries **the handle it is about** — a window handle for `windowMru`, a
tab handle for the rest — so the output of a "where was I last" query can be
pasted straight into `focus` / `window set`. That is the only reason to ask the
question, and for a while the human view printed everything except that field.

Journals live in the daemon only (empty when it's down), persist as rotated
NDJSON under `$BROWSER_TAB_CACHE_DIR/journal/`, and the per-tab `navEpoch`
maintained here is the cache-busting key later capabilities reuse. Handles in
results are for **correlation, not commands** — re-run `list` for live handles.
See `docs/WM_STACK_CONTRACT.md` for the wire shape.

## URL hygiene & big-session listing

**Recorded URLs never carry credentials.** A tab URL like
`http://admin:secret@192.168.1.1/` embeds a live password, and tab URLs are
denormalized into snapshot files, journals, history results, logs and agent
context. So basic-auth userinfo is stripped at every mapper: the extension
redacts before a URL even reaches the wire, and the daemon re-applies the same
`redactUrlUserinfo` to AppleScript/Safari/history sources (escape hatch:
`BROWSER_TAB_KEEP_URL_USERINFO=1`, daemon side only — it cannot resurrect what
a current extension already stripped).

**`fields:"summary"`** (`list_tabs`, `browser-tab list --fields summary`)
returns the SHAPE of a session — windows and tab groups with counts and the
active tab, zero per-tab rows — and is the right first call on a big session:
a real 103-tab cleanup found even the trimmed `core` projection exceeding an
MCP client's token budget. Drill into one window afterwards with `windowId`
plus `urlFilter`. Still a valid Snapshot (`tabs: []`, counts in `tabCount`).

## Write-side control

**Group semantics that will surprise you if unstated:** `group_tabs create`
groups tabs **in their own window** (the first live tab's) — Chrome's default
would group into the *focused* window and move every tab there. List-taking
group actions (`create`/`add`/`remove`) validate per-id: stale handles are
skipped, acted around, and reported in `payload.skippedTabIds` (as handles);
only an all-stale list errors. `move_tab` results report the tab's **actual**
final `index`/`windowId` via a closing `tabs.get`, because `tabs.move`'s echo
has returned indices past the end of the window. After any write, the
extension pushes a fresh snapshot immediately, so a read that follows a write
sees the write.

Beyond reads + `focus`/`move`/`open`/`close`, the tool can drive tabs and
windows imperatively:

```bash
browser-tab act <tabId> mute            # or unmute|pin|unpin|discard|reload|back|forward|duplicate
browser-tab act <tabId> navigate --url https://example.com
browser-tab group create --tabs t:chrome:x1,t:chrome:x2 --title Work --color blue
browser-tab group move --group g:chrome:x77 --target-window w:chrome:x9
browser-tab window open https://a.com https://b.com --display 1     # fills monitor 1
browser-tab window open https://a.com --bounds 0,0,1280,800
browser-tab window set w:chrome:x9 --state minimized
browser-tab window close w:chrome:x9
```

Capability boundary (runtime-probed, never hardcoded): the browser extension
covers every action; the AppleScript fallback covers navigate/reload for all
browsers, back/forward on Chromium only, and window bounds + normal/minimized.
Everything else (mute/pin/discard/duplicate, **tab groups**, maximized/fullscreen)
errors with a "needs the extension" hint. Tab-group ops are Chrome-family only.

Window placement takes either explicit `--bounds x,y,w,h` (global screen points)
or a `--display <n>` index that fills that monitor. Display targeting reads the
active-display list from the native module; without it, use `--bounds`. List the
available displays via `browser-tab daemon status --json` (the `displays` field).

`--bounds` and `--state` compose: `window set <id> --bounds … --state normal`
restores the window *and* places it (state is applied first, then the geometry,
so your explicit bounds win). Chrome's API rejects the two in one call, so the
daemon issues them as two updates rather than dropping either.

**Handles never cross browsers.** Every handle is scoped to one browser, and the
numeric id inside it is only unique within that browser — so a `w:safari:…`
target for a `t:chrome:…` tab is rejected with an actionable error rather than
being unpacked into Chrome's id space. This applies to every command that takes
a second handle (`move --target-window`, `open --window`, and all of `group`,
including *each* id in `--tabs`). Re-run `list` and use handles from one browser.

## Page content & state

On-demand page perception — the tool returns reader-mode text, metadata, or
live state signals; the consumer AI interprets (no AI in-tool). **Extension-only**
(there is no AppleScript way to read a page) and daemon-only (the cache lives
there).

```bash
browser-tab page <tabId>                 # reader-mode article text (default)
browser-tab page <tabId> --mode metadata # title/description/og/canonical/lang
browser-tab page <tabId> --mode state    # dirty forms, media, scroll, selection, word count
browser-tab page <tabId> --force         # bypass the navEpoch cache and re-extract
```

Extraction is injected on demand via `chrome.scripting.executeScript` (never a
persistent content script) using a bundled `@mozilla/readability`. Results are
cached in the daemon keyed on the tab's `navEpoch`, so an unchanged page serves
instantly; `--force` re-extracts. All returned text is untrusted web content and
is wrapped accordingly.

**Capture-on-blur**: when the daemon enables it (`BROWSER_TAB_BLUR_CAPTURE`, on
by default), the extension snapshots the state of the tab you just *left* on a
tab switch (settle-delayed, cooldown-throttled, skips discarded/incognito/non-http),
and the daemon backfills that onto the tab's most recent focus journal record —
so "left this tab mid-edit" shows up in `journal`.

```bash
browser-tab annotate <url> --note "my cached summary"   # write
browser-tab annotate <url>                              # read
```

`annotate` is a tiny URL-keyed note cache in the daemon — a place for a consumer
to stash its own summaries. It's a cache substrate, not intelligence.

Env: `BROWSER_TAB_BLUR_CAPTURE` (1), `BROWSER_TAB_EXTRACT_MAX_BYTES` (200KB),
`BROWSER_TAB_WS_MAX_PAYLOAD` (16MB), `BROWSER_TAB_CONTENT_MAX` (200 cached pages).

## Screenshots

Two tiers, one `screenshot` tool — the image comes back as an MCP image content
block (base64 jpeg) alongside a structured `{tier, path, bytes, cached, navEpoch}`.

- **Tier "tab"** (`screenshot {tabId}`) — the extension's `captureVisibleTab`
  (no TCC). It only sees a window's **active** tab, so the daemon preflights
  that the tab is active — otherwise it errors with a hint, or pass `focus:true`
  to activate the tab first (which changes what the user sees). Rate-limited
  ~2/s per browser (fails fast with a "retry in Nms" hint, never queues) and
  cached per `navEpoch`, so an unchanged page serves instantly (`force:true`
  recaptures).
- **Tier "window"** (`screenshot {windowId}`) — the daemon's
  `screencapture -l <cgWindowId>` for **any** visible window of any browser.
  Opt-in via `BROWSER_TAB_WINDOW_CAPTURE=1` and gated by Screen Recording
  permission (`browser-tab doctor` probes it via the native
  `CGPreflightScreenCaptureAccess`).

```bash
browser-tab screenshot <tabId>                 # tier 1 (active tab)
browser-tab screenshot <tabId> --focus         # activate the tab, then capture
browser-tab screenshot <windowId> --window     # tier 2 (needs the env flag)
browser-tab screenshot <tabId> --out shot.jpg  # also copy the jpeg out
```

Shots land in `~/.cache/browser-tab/shots/` (file-count LRU). Env:
`BROWSER_TAB_WINDOW_CAPTURE` (0), `BROWSER_TAB_SHOT_QUALITY` (70),
`BROWSER_TAB_SHOT_MAX` (200), `BROWSER_TAB_SHOT_DIR`.

## Global history

The browser's own persisted URL history — distinct from `journal` (the daemon's
in-session focus/nav memory). One `history` tool, two sources, merged
newest-first and tagged per browser:

- **Chrome-family** — the connected extension's `chrome.history` (granted since
  the contract-v2 permission batch). No daemon-side file access.
- **Safari** — a daemon-side sqlite read of `~/Library/Safari/History.db`, since
  Safari has no `chrome.history`. **Opt-in** behind `BROWSER_TAB_SAFARI_HISTORY=1`
  and gated by **Full Disk Access** (FDA is per-binary, so the launchd daemon may
  be denied even when your terminal isn't — `doctor` flags the split). The daemon
  copies History.db + its WAL sidecars to a private tmpdir and queries the copy
  with `/usr/bin/sqlite3 -json`; Cocoa `visit_time` is converted to epoch ms.
  Injection-free by construction — only numeric time bounds reach the SQL, and
  the text filter runs on the returned rows in TypeScript.

```sh
browser-tab history                              # merge every reachable source
browser-tab history --browser chrome --query gh  # one browser, substring filter
browser-tab history --start <ms> --end <ms>      # time-bounded (epoch ms)
browser-tab history --limit 100                  # cap the rows
```

Passing an explicit `--browser` whose source is unavailable errors with a hint;
omitting it merges whatever's reachable (empty when nothing is, like `journal`).
URLs/titles are untrusted web content. Env: `BROWSER_TAB_SAFARI_HISTORY` (0),
`BROWSER_TAB_SQLITE_BIN` (`/usr/bin/sqlite3`), `BROWSER_TAB_SAFARI_HISTORY_DB`.

**Every result reports its sources — including the empty one.** Rows alone
can't distinguish "Safari had nothing" from "Safari was never asked", so each
query lists one line per source it considered, whether or not it ran:

```console
$ browser-tab history --query zzz-no-such-url
history - no rows
  sources
    brave     extension   unavailable  the browser-tab extension is not connected
    chrome    extension   ok           0 rows
    edge      extension   unavailable  the browser-tab extension is not connected
    safari    safari-db   unavailable  Safari history is disabled - set BROWSER_TAB_SAFARI_HISTORY=1
```

## Reloading the extension (`browser-tab reload-extension`)

The deploy loop for extension changes used to end in a manual click. It doesn't
have to:

```sh
pnpm --filter @george43g/chrome-extension build
browser-tab reload-extension --browser chrome
```

**How it works, and why it is not fire-and-forget.** `chrome.runtime.reload()`
restarts the extension from disk. It is the only restart mechanism present in
both Chrome (25+) and Safari (14+) — `chrome.management` is absent from Safari
entirely, which is why there is no "manager" mini-extension here. The extension
**acks before it reloads**: `runtime.reload()` tears the background context
down immediately, so replying afterwards is impossible and every successful
reload would otherwise be reported as a command timeout.

That ack therefore proves only that the message arrived. The daemon reports the
truth by watching the socket — it waits for the connection to **drop and come
back**, and fails loudly otherwise. This matters: if the rebuilt manifest
requests a **new permission**, the browser leaves the extension disabled
pending your approval and it never returns.

**There is no `reload_extension` MCP tool, deliberately.** A model driving this
server would be disconnecting its own transport, and the failure would look
like a transport bug rather than a tool call. The CLI is the only way in.

**Bootstrapping:** a bundle that predates this command can't reload itself —
reload it by hand once and the command works from then on. It says so.

**Safari: don't use this command — you don't need it.** MEASURED 2026-08-18
(Safari 26.x): Safari accepts `chrome.runtime.reload()` and then does nothing
observable — the background page never drops its socket, so the daemon
correctly refuses to claim a reload happened.

It doesn't matter, because Safari updates itself. `pnpm --filter
@george43g/safari-extension sideload` prunes stale registrations, rebuilds,
`xcodebuild`s and re-registers the app — and across two back-to-back trials
with **no toggle and no reload command**, the extension disconnected and came
back on the freshly built stamp within ~15s. The manual "Settings > Extensions
toggle off/on" step that script used to print is unnecessary here; it remains
the fallback if a future Safari regresses this.

### Which build is actually running?

The extension logs its build stamp at startup and, on every connect, whether it
matches the daemon:

```
[browser-tab] worker up · v0.2.0+52.0844c73
[browser-tab] connected to daemon 127.0.0.1:8790 as chrome
[browser-tab] build 0.2.0+52.0844c73 matches daemon 1.1.1+52.0844c73
```

A mismatch logs a warning naming both stamps. `doctor` reports the same thing,
but only from the daemon's side — and "a rebuilt extension is not a reloaded
one" is a browser-side fact, so this is the one place you see it without
leaving the browser. Both use the same comparison (commit identity; the semver
prefix and any `dirty` marker are ignored), so they cannot disagree.

## TUI (`browser-tab tui`)

Keys: `j`/`k` move · `⏎` focus · `a` **actions** · `x` close · `m` move tab ·
`space` fold · `r` refresh · `q` quit.

`a` opens a tab-action picker (mute/unmute, pin/unpin, discard, reload,
duplicate, back/forward) in the status bar — `j`/`k` choose, `⏎` runs, `Esc`
cancels. It is a picker rather than ten more keybindings because the help bar is
clamped to **one row**: the kit's `HelpBar` wraps below ~90 columns, and a
wrapping bar silently steals a row from the list viewport, which is how a width
bug presents here as a height overflow.

The menu is **capability-filtered** from the runtime-probed map (never from the
browser name), and never offers both halves of a toggle at once — a menu is a
promise, and offering `duplicate` on an AppleScript-only pathway promises an
error toast.

The help bar itself now **drops its least useful hints rather than overflowing**
(`refresh` → `fold` → `move tab` → `close` → `actions`); `j/k`, `⏎` and `q`
survive at any width, because a TUI you cannot quit is worse than one with fewer
hints.

A live Ink tab manager (browser › window › tab), fed by the daemon event stream
(falls back to 5s polling when the daemon is down). Keys: `j/k` move · `⏎` focus
· `x` close · `m` move tab · `space` fold window · `r` refresh · `q` quit.

Each tab row ends with compact status badges drawn from the contract-v2
enrichment already in the snapshot (no extra fetch) — full coverage of the
badge-worthy tab state:

| Badge | State |
|---|---|
| 📌 | pinned |
| ⏳ | loading |
| 🔇 / 🔊 | muted / audible (mute wins) |
| 🧊 | frozen (Chrome 132+ CPU freeze) |
| 💤 | discarded (unloaded from memory) |
| ⊞*Name* | tab-group membership (shows group title) |

The leading `●`/`·` marks the window's active tab; `lastAccessed` drives sort/MRU
(see `journal`) rather than a per-row glyph.

A **scroll position indicator** (a 1-column track) appears at the right edge of
the list only when its content overflows the terminal height — below that
threshold, the list keeps full width. The track shows a filled block (█) for
the visible portion and a vertical bar (│) for scrolled-past content, updated
in real time as you navigate.

The **sticky detail pane** appears alongside the list when the terminal is wide
enough (≥74 columns). It shows elaboration on the current selection — full URL,
tab state, group membership, last-access time (for tabs), or window bounds and
capability summary (for browsers/windows). Below 74 columns the pane drops
entirely rather than squeezing into a half-legible truncated column, trading
width for readability where it matters most.

Navigation preserves context across snapshot updates: when the browser state
changes (a window opens, tabs reload), the cursor follows the *row* by identity
rather than numeric index, so focus stays on the tab you were browsing even if
other rows shift above or below it.

Half-page motions (`^d` down, `^u` up) are disabled in modal modes (move/action
pickers, close confirmation), since modal lists are shorter than a full page and
the motion keys would scroll an empty or misaligned view. `gg`/`G` (jump to
top/bottom) are disabled there for the same reason. `j`/`k` stay active in
every mode, but in move/action mode they steer the modal's own selection (the
move target, the action list) rather than the hidden browse cursor.

### Soak-testing the TUI (`pnpm stress:tui`)

Two verdicts, deliberately separate. The **workload** owns correctness: it
renders the real `App` against a real daemon (fake adapter, no browser) across
six terminal geometries from 200x60 down to 40x12, drives real keystrokes, and
fails on any frame taller than the terminal or any line wider than it. It also
pushes ~20M rows through `buildRows` + the viewport helpers with tabs opening,
closing and folding between iterations. The **driver** owns resources: RSS and
event-loop p99, sampled from the watchdog state file.

Two things this harness now refuses to do, because it used to do both:

- **Pass while measuring nothing.** Zero collected samples is a failure. It
  previously printed `max RSS 0MB, max lag 0ms, 0 samples` and exited 0 — the
  workload's hot loop was synchronous, so the watchdog's timer never fired.
- **Render content that cannot break.** `BROWSER_TAB_FAKE_SCALE` /
  `BROWSER_TAB_FAKE_TABS` scale the fake adapter up with long, realistic,
  emoji-bearing titles. Its default fixtures ("Inbox (3) - Gmail") are far too
  short to reach a width budget, so rendering them measures the fixture rather
  than the layout.

The list height follows the terminal: it is derived from `stdout.rows` minus the
chrome (header + status bar + help bar) and re-derived on resize, so the list
fills a tall window and shrinks rather than overflowing a short one. The scroll
window is clamped at both ends, so it stays full at the bottom of the list
instead of shrinking as you approach it. `m` (move) offers only windows of the
*same* browser, excluding the tab's own — cross-browser moves are impossible and
a self-move is a no-op.

If the daemon goes away while the TUI is open (restart, crash), the header flips
from `daemon stream` to `osascript polling` and the subscription is retried with
backoff — it no longer freezes on stale data while claiming to be live.

## Adding a tool

1. Copy `src/tools/noop.ts` to `src/tools/<your-tool>.ts`.
2. Define Zod input/output schemas (in `@george43g/shared-types` if you want to mirror in Rust, else inline in the tool file).
3. Register the new tool in `src/tools/registry.ts`.
4. Add an integration test in `tests/integration.test.ts`.
5. If the tool affects process lifecycle, add a case in `scripts/stress-mcp.ts`.

The dispatcher already wires `withTimeout`, `perf` spans, abort propagation, structured error wrapping, and structuredContent return — your handler just needs to be a pure `(input, signal) => output` async function.

## Removing surfaces

- **Drop TUI support**: delete `src/tui/`, the `tui` subcommand from `src/cli.ts`, the `browser-tab-tui` bin entry from `package.json`, and the TUI entry from `vite.config.ts` `lib.entry`.
- **Drop Rust acceleration**: delete `apps/rust-accel/`, the `src/native-bridge.ts` file, and the `tryLoadNative()` call in `src/tools/noop.ts`.
- **Drop `get_logs`**: delete `src/tools/get-logs.ts` and remove it from the registry.

## Shell completions

Bash/zsh/fish completions + manpage + per-subcommand markdown docs are generated on demand from `.usage.kdl` via `usage(1)`. The scaffold ships the spec + the regen tasks but NOT the pre-generated artifacts (they reference the clone's actual bin name, not the placeholder).

The intended workflow is: generate the artifacts once, commit them, then let CI's `pnpm check:usage` step (and the matching `cli-artifacts-drift` workflow on the scaffolder side) fail any future edit that changes `.usage.kdl` without a matching regen.

First-run flow:

```bash
mise install                                  # one-time: installs usage(1)
pnpm artifacts                                # regenerate completions/ + man/ + docs/cli/
git add completions man docs/cli              # check in the baseline
git commit -m "chore: initial usage(1) artifacts"
pnpm completions:install                      # auto-detect $SHELL and install into the right path
```

From the second run forward, `pnpm check:usage` (and CI) enforces freshness — edit `.usage.kdl` and forget to regen, build fails.

`completions:install` (script: `scripts/install-completions.sh`) handles the well-known locations for each shell:

| Shell | Default install path |
|-------|----------------------|
| bash  | `~/.local/share/bash-completion/completions/browser-tab` (XDG) or `~/.bash_completion.d/browser-tab` |
| zsh   | `${ZDOTDIR:-~}/.zsh/completion/_browser-tab` |
| fish  | `~/.config/fish/completions/browser-tab.fish` |

CI gate `scripts/check-usage-freshness.mjs` (`pnpm check:usage`) fails the build if `.usage.kdl` was edited without regenerating the artifacts.

## Install in Claude Desktop (.mcpb bundle)

Claude Desktop loads MCP servers from `.mcpb` bundles — zip archives with a `manifest.json` + the runtime files. Build one with:

```bash
pnpm pack:mcpb         # runs `pnpm build` then bundles into browser-tab-mcp-<version>.mcpb
```

The output `.mcpb` drops into Claude Desktop via drag-and-drop (or **Settings → Extensions → Install from file**). Claude reads `manifest.json` (MCPB spec v0.3), spawns `node ${__dirname}/dist/index.js` for stdio transport, and surfaces this server's tools + resources in the catalogue.

The shipping manifest lives at `manifest.json` and pins:

- `manifest_version: "0.3"` — MCPB spec pin
- `server.type: "node"`, `entry_point: dist/index.js`
- `compatibility.platforms: ["darwin", "linux", "win32"]`
- `compatibility.runtimes.node: ">=24.0.0"`

To customize: edit `manifest.json` (e.g. add a `icon` field, update the description) — the build script reads it verbatim and only overrides `version` from `package.json`.

See `../../docs/ARCHITECTURE.md` for the full package map.
