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
| `daemon run\|install\|status\|token` | launchd daemon lifecycle |
| `repl` (alias `console`) | interactive REPL over the in-process dispatcher |

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

Journals live in the daemon only (empty when it's down), persist as rotated
NDJSON under `$BROWSER_TAB_CACHE_DIR/journal/`, and the per-tab `navEpoch`
maintained here is the cache-busting key later capabilities reuse. Handles in
results are for **correlation, not commands** — re-run `list` for live handles.
See `docs/WM_STACK_CONTRACT.md` for the wire shape.

## Write-side control

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

## TUI (`browser-tab tui`)

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
