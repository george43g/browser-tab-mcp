<div align="center">

# browser-tab

**macOS browser-tab detection & management for window-manager stacks — daemon + MCP server + CLI + TUI from a single bin.**

[![CI](https://github.com/george43g/browser-tab-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/george43g/browser-tab-mcp/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/george43g/browser-tab-mcp)](https://github.com/george43g/browser-tab-mcp/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >=24](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](https://nodejs.org)

[Install](#install) · [Tools](#tools) · [Connect from your editor](#one-click-install) · [Docs](#docs) · [Skill for AI agents](#install-the-companion-skill)

![browser-tab TUI](docs/screenshots/overview.gif)

</div>

---

Knows which tabs are open in which browser windows (Chrome, Brave, Chromium, Edge, Safari), joins them to yabai window ids (`cgWindowId` == CGWindowID), and executes tab commands — including **true state-preserving cross-window moves** via the bundled browser extension (`chrome.tabs.move`; AppleScript can't do that). Built for [wm-stack](https://github.com/george43g) but generally useful: a launchd daemon polls via AppleScript, extensions push live events over a localhost WebSocket, and MCP/CLI/TUI/unix-socket clients all consume the same merged snapshot. See [`docs/WM_STACK_CONTRACT.md`](docs/WM_STACK_CONTRACT.md) for the consumer contract.

## Install

Not published to npm — versioning is deliberately decoupled from distribution
(release-please tags GitHub Releases; see [`docs/RELEASE.md`](docs/RELEASE.md)).
Install from source:

```bash
git clone https://github.com/george43g/browser-tab-mcp.git
cd browser-tab-mcp
pnpm install && pnpm build   # Node >=24, pnpm 10.x

node apps/browser-tab-mcp/dist/cli.js --version   # the single bin

# optional: put it on your PATH as `browser-tab`
alias browser-tab="node $PWD/apps/browser-tab-mcp/dist/cli.js"
```

All subcommands route through that single bin:

```bash
browser-tab daemon install   # launchd daemon: polling + extension socket + IPC
browser-tab daemon token     # print the extension auth token
browser-tab list --json      # windows + tabs + cgWindowId (yabai join key)
browser-tab focus <tabId>    # activate a tab and raise its window
browser-tab focus <tabId> --no-raise   # activate it in place, leave the window alone
browser-tab move <tabId> --target-window <windowId>   # true move (extension)
browser-tab move <tabId> --to -1                      # same-window: signed one-based position (-1 = end)
browser-tab move <tabId> --by -3                      # same-window: relative move, clamps at the edges
browser-tab open <url>       # open a tab
browser-tab close <tabId>    # close a tab
browser-tab group remove --group <groupId>   # dissolve a group, keeping every tab
browser-tab tui              # live tab manager (Ink)
browser-tab mcp              # run the MCP server (stdio)
browser-tab doctor           # preflight: Automation permission, correlation tier
browser-tab repl             # interactive REPL — same dispatcher as MCP
```

`daemon install` registers a per-user service that restarts the daemon if it
exits — a launchd LaunchAgent on macOS, a Task Scheduler `ONLOGON` task on
Windows (not a Service: that needs elevation and runs in session 0, which cannot
see your browser), and elsewhere it refuses with an instruction rather than
silently producing a daemon that never starts. On macOS the agent sets
`ThrottleInterval` to 30s, so a daemon that ends up in a restart loop cannot
respawn on launchd's 10s default and add load to the machine that caused it.
Re-run `daemon install` after upgrading to pick up changes to the service
definition.

## One-click install

Paste these into your MCP host's config, replacing `/path/to/browser-tab-mcp`
with your clone (the package is not on npm, so there is no `npx` form).

### Claude Desktop / Code (`claude_desktop_config.json` or `.mcp.json`)

```json
{
  "mcpServers": {
    "browser-tab": {
      "command": "node",
      "args": ["/path/to/browser-tab-mcp/apps/browser-tab-mcp/dist/cli.js", "mcp"]
    }
  }
}
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "browser-tab": {
      "command": "node",
      "args": ["/path/to/browser-tab-mcp/apps/browser-tab-mcp/dist/cli.js", "mcp"]
    }
  }
}
```

### Warp / Codex / OpenCode

Identical JSON snippet — they all consume the same shape under `mcpServers`. See `opencode.json` and `.cursor/mcp.json` in this repo for working examples (with relative paths for local dev).

## Tools

Every MCP tool is also a CLI subcommand and a REPL command (one in-process dispatcher).
Every tool ships a complete MCP annotations block — a human title plus explicit
`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint` — surfaced in
`tools/list` so hosts can gate risk truthfully (`tab_action` counts as destructive:
navigate/discard can irreversibly lose in-page state). The column below shows the
highlights; the contract test `tool-annotations.contract.test.ts` enforces the full set.

| Tool | Description | Annotations |
|---|---|---|
| `list_tabs` | Windows + tabs across Chrome/Brave/Chromium/Edge/Safari with opaque handles, bounds, and `cgWindowId` (yabai join key). Filters: `browser`, `windowId`, `urlFilter`. | read-only, idempotent |
| `select_tabs` | Resolve a control-language selector (identity/position/predicate/temporal + set algebra, signed one-based positions) against the live snapshot. Pure read: rows/ids/count plus resolution metadata — snapshotToken, warnings, live-move-domain uniformity — and a short-lived `selectionId` for follow-up planning calls. CLI: `browser-tab select --selector <json\|@file\|->`. | read-only, idempotent |
| `plan_tab_change` | Plan ONE transform (move/setOrder/reverse/sort/pack) over a selection without applying it: ordered primitive effects, warnings, risk class, and a short-lived `planId` for `apply_tab_layout`. Policy violations fail at plan time with stable codes. CLI: `browser-tab plan`. | read-only |
| `apply_tab_layout` | Apply a live-layout plan: state-preserving moves only, never reloads or closures. Not transactional — per-effect outcomes, actual final arrangements, residual reported honestly; stale plans refused. CLI: `browser-tab apply --plan <id>`. | |
| `copy_tabs` | Reconstruct selected tabs at another window or browser; every source stays open. Copies load fresh; pinned intent carried; policy-refused URLs skipped per-item; `idempotencyKey` makes retries safe. CLI: `browser-tab copy --to-window\|--new-window`. | open-world |
| `cut_tabs` | DESTRUCTIVE transfer: reconstruct at the destination, verify, then close the source — a source whose replacement did not verify is never closed. Requires `confirmDestruction:true` in the arguments. CLI: `browser-tab cut --confirm-destruction`. | destructive, open-world |
| `focus_tab` | Activate a tab and — unless `raiseWindow:false` — un-minimize and raise its window. Returns the window's post-state for a window manager to act on. | |
| `move_tab` | Move a tab: same-window with signed `to` (one-based, `-1` = end) or relative `by: ±N`, across windows with `targetWindowId`. Signed forms are resolved by the daemon against a live snapshot. True state-preserving move via the extension; Safari AppleScript fallback with `allowReload:true`. | |
| `open_tab` | Open an http(s) URL, optionally in a specific window/browser or in the background. | open-world |
| `close_tab` | Close a tab. | destructive |
| `daemon_status` | Daemon reachability, poll interval, correlation tier, per-browser counts + extension connectivity. | read-only |
| `health_check` | Server/runtime snapshot. Never touches external I/O. | read-only, idempotent |
| `noop` | Echo demo (Rust acceleration path). | read-only, idempotent |
| `get_logs` | **Dev-mode only** (`MCP_DEV=1`). Last N in-memory log lines. | read-only |

### `focus_tab` and the window manager

`focus_tab` activates the tab and, by default (`raiseWindow: true`), un-minimizes
and raises its window — identically whether it runs through the extension or
through AppleScript. Pass `raiseWindow: false` (`--no-raise`) to select the tab
and touch nothing else.

Either way the result carries the window's post-state, so a window manager never
needs a second `list_tabs` to decide what to do next:

| Field | Meaning |
|---|---|
| `cgWindowId` | CoreGraphics/yabai window id — the join key. `null` when correlation is ambiguous; absent when the daemon isn't running (correlation lives there). Correlation matches on bounds, then on bounds shifted by each display origin (Safari reports `top` display-local), then on the window title — and a matched window adopts the CoreGraphics frame, so its `bounds` are the true global ones. |
| `windowState` | `normal` / `minimized` / `maximized` / `fullscreen` after the call. |
| `wasMinimized` | Whether the window was minimized *before* — i.e. the tab was somewhere you couldn't see. |
| `windowFocused` | Whether the window is now its browser's frontmost window. |

browser-tab deliberately does **not** manage Spaces or window placement: it
reports, your WM decides. There is no yabai actuation in this tool.

### Why `history` returned nothing

Every `history` result carries a `sources` array — one entry per source the
query considered, *including the ones it never asked* — so an empty or
Chrome-only result says why instead of looking like "there was nothing":

```json
{ "browser": "safari", "source": "safari-db", "status": "unavailable", "rows": 0,
  "reason": "Safari history is disabled — set BROWSER_TAB_SAFARI_HISTORY=1 …" }
```

`status` is `ok` (queried, `rows` counts its pre-merge contribution),
`unavailable` (not queried) or `error` (queried and failed, `reason` carries the
message). A merged query degrades per-source; naming one `browser` explicitly
still errors outright.

### Reading state without running anything

The daemon keeps two files under `~/.cache/browser-tab/` for consumers that
can't afford to fork a CLI (a status-bar plugin re-running every few seconds):

| File | Rewritten | mtime means |
|---|---|---|
| `snapshot.json` | only when state changes (≤1/s) | **state changed** |
| `heartbeat.json` | end of every completed poll tick | **daemon alive** |

They're separate on purpose: an idle machine leaves `snapshot.json` hours old
*and* perfectly correct, so its age can't tell a quiet daemon from a dead one.
`heartbeat.json` answers that with one `stat` — and because it's written at the
end of a tick rather than on a timer, a daemon wedged on a hung `osascript`
stops beating instead of lying. It's removed on a clean stop, and carries
`snapshotChangedAt` so one read separates "alive" from "current". See
[`docs/WM_STACK_CONTRACT.md`](docs/WM_STACK_CONTRACT.md) for the shell recipe.

Every daemon-served snapshot also carries a monotonic `revision` plus an opaque
`snapshotToken` (`<bootId>:<revision>`, equality-comparison only) — state
identity for optimistic-concurrency callers, separate from the contract
`version` (fixed at 2); the heartbeat mirrors `revision` for shell consumers.

### Output: human at a terminal, JSON everywhere else

Read commands (`list`, `journal`, `history`, `daemon status`) print a readable
view when stdout is a terminal, and **JSON** when it isn't — so pipes, scripts
and CI keep the exact machine-readable output they always had. Precedence:
`--json` wins, then a non-TTY stdout, then `CI=true`, else human.

**Failure is signalled the same way in every mode.** A failing tool exits
non-zero whether you're piping, passing `--json`, running under CI, or watching
a terminal, and JSON mode emits one documented shape so a consumer can branch on
a single key:

```console
$ browser-tab --json focus nonsense ; echo "exit=$?"
{"error":{"tool":"focus_tab","message":"Tool \"focus_tab\" failed: Malformed handle \"nonsense\" — use handles from list_tabs."}}
exit=1
```

Success output is unchanged — the bare domain object, no wrapper.

```console
$ browser-tab list --browser chrome
chrome  extension · 2 windows · 4 tabs ← focused
  w:chrome:x523241490  normal  1860×1020  cg:279
      t:chrome:x523241740  Posts matching '' - Stack Overflow   stackoverflow.com  asleep
    ▸ t:chrome:x523241788  Extensions - browser-tab connector   extensions
  w:chrome:x523241807  normal  1860×1020  cg:71129
    ▸ t:chrome:x523241808  Example Domain                       example.com

$ browser-tab list --json | jq '.browsers[0].windows | length'
2
```

`▸` marks the active tab; a window with no `cgWindowId` shows `cg:none`, since
that field is the yabai/wm-stack join key and a silent `null` there is easy to
miss. The TUI uses the same `cg:none` marker.

The human view is **coloured** — browser names bold, handles cyan, metadata dim,
`cg:none` yellow, the active `▸` green — and honours the usual conventions:
`NO_COLOR` off, `FORCE_COLOR` on regardless of TTY. Two escape hatches exist
because the inferred signals have no inverse: `FORCE_HUMAN=1` selects the human
view when stdout is a pipe (so `browser-tab list | less -R` works), and
`FORCE_COLOR=1` keeps the colour with it.

**Narrow terminals lose a column, never the answer.** Rows lay out against the
real terminal width, and when there isn't room the least useful column goes
first — badges, then host, then the clock — before the title is squeezed. The
handle and the `cg:` join key are never dropped: a row you can read but can't
feed back into `focus` / `window set` has lost the only reason it was printed.

The global flags are real: `--no-color` disables colour, `-v/--verbose` raises
the log level, and `-q/--quiet` suppresses the success payload — **but never an
error, and never the exit code**, because a quiet failure that also exits 0 is
the one thing such a flag must not cause. Options that can't honour a value now
refuse it (`--fields`, `journal --view`) instead of silently falling back, and
`journal --view tabMru|journey` demands its handle up front rather than
degrading to an empty result that reads like "no history".

**URLs are allowlisted.** `open`, `window open` and `act navigate` accept
`http`, `https`, `about` and the browser-internal schemes; `javascript:`,
`file:` and `data:` are refused, because the caller is often a model that has
just read untrusted web content and those three turn a tab tool into script
execution, local-file disclosure and inline-HTML injection. Widen it
deliberately with `BROWSER_TAB_ALLOW_URL_SCHEMES=file,data`.

### The TUI adapts to the terminal, in both dimensions

`browser-tab tui` derives its viewport from the live terminal size and clamps
every row to the available width, so a narrow or short window degrades by
truncating (`…`) rather than wrapping. That matters more than it sounds: a
wrapped row makes Ink print more lines than the screen has, which scrolls the
frame and overprints the status bar — and the status bar is where the
`press y to confirm` prompt for closing a tab appears. Titles are truncated by
display width and never mid-emoji. Resize while it's running; it re-lays out.

### Global flags for the knobs you flip per-invocation

A curated set of environment variables is also accepted as CLI flags, and the
flag always wins:

| Flag | Env var |
|---|---|
| `--log-dir <dir>` | `MCP_LOG_DIR` |
| `--disable-native` | `MCP_DISABLE_NATIVE` |
| `--socket-path <path>` | `BROWSER_TAB_SOCKET_PATH` |
| `--ws-port <port>` | `BROWSER_TAB_WS_PORT` |
| `--state-dir <dir>` | `BROWSER_TAB_STATE_DIR` |
| `--cache-dir <dir>` | `BROWSER_TAB_CACHE_DIR` |
| `--browsers <list>` | `BROWSER_TAB_BROWSERS` |
| `--poll-ms <ms>` | `BROWSER_TAB_POLL_MS` |
| `--fake-adapter` | `BROWSER_TAB_FAKE_ADAPTER` |
| `--dev` | `MCP_DEV` |

Together these are enough to drive a fully isolated daemon by hand — which is
exactly what the e2e harness does. Every *other* recognized variable is
env-only and documented in `.env.example`.

The connector extension lives in `apps/chrome-extension` (load `dist/` unpacked, paste `browser-tab daemon token` in its options page) with Safari packaging in `apps/safari-extension` (`pnpm --filter @george43g/safari-extension sideload`; needs Xcode — see its README). Its toolbar **popup** and **settings page** show live connection status, window/tab counts, and the real error if it can't connect. Without an extension, everything except true Chromium moves still works via AppleScript.

### Driving a Chromium build the adapter doesn't know by name

The AppleScript path addresses a browser **by app name** (`tell application
"Chromium"`), and Apple Events route by app identity — not by pid, not by
`--user-data-dir`. So a second instance of the same bundle is not separately
addressable however isolated its profile is, and the adapter only knows four
names: Google Chrome, Brave Browser, Chromium, Microsoft Edge.

`BROWSER_TAB_CHROMIUM_APP_NAME` points the `chromium` id at a differently-named
Chromium build — **Google Chrome for Testing** (Google's automation build, and
what Playwright downloads), Thorium, Ungoogled Chromium, a local compile. They
all speak the identical scripting dictionary, so the app name is the only thing
that cannot be inferred:

```sh
BROWSER_TAB_CHROMIUM_APP_NAME="Google Chrome for Testing" browser-tab list --browser chromium
```

This is what `pnpm sweep:macos` uses to verify the AppleScript adapters against
a real browser without touching the one you actually have open.

## Install the companion skill

This repo ships with a Claude skill that teaches an AI agent how to use your tool end-to-end. The skill lives at `skills/browser-tab/SKILL.md` and is meant to be rewritten by you (or by the AI itself, after first reading the tool) to document the tool's actual behavior.

```bash
# Copy the skill into your global Claude skills dir
mkdir -p ~/.claude/skills/browser-tab
cp skills/browser-tab/SKILL.md ~/.claude/skills/browser-tab/

# Or symlink (so updates from this repo show up automatically)
ln -s "$(pwd)/skills/browser-tab/SKILL.md" ~/.claude/skills/browser-tab/SKILL.md
```

## Docs

| File | What it covers |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Canonical agent guide (also `CLAUDE.md`, `.cursorrules` as symlinks) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How packages fit together; which to delete if you don't need a surface |
| [`docs/RUST_ACCELERATION.md`](docs/RUST_ACCELERATION.md) | napi-rs build, `.node` binary handling, drift-check between Zod and serde |
| [`docs/TUI_DESIGN.md`](docs/TUI_DESIGN.md) | Theme system, keybindings, dev stats, cache invariants |
| [`docs/GUARDRAILS_MCP_RESPONSES.md`](docs/GUARDRAILS_MCP_RESPONSES.md) | UUID-gated instructions + prompt-injection defense |
| [`docs/RELEASE.md`](docs/RELEASE.md) | release-please flow — tags, GitHub Releases, changelog (no npm publish) |

## What's inside (template author's eyes only)

This section is for the engineer running the scaffolder — delete it once you've made the tool your own.

```
apps/
  browser-tab-mcp/             your tool — clone-and-rename target
    src/
      cli.ts                THE SINGLE BIN — commander dispatch
      index.ts              runMcpServer() + callMcpTool() (library exports)
      tui/                  Ink TUI — delete dir + the `tui` subcmd if not needed
      tools/                health_check + noop demo + dev-only get_logs
      dispatcher.ts         invariants block; withTimeout + perf + abort + error wrap
      native-bridge.ts      tryLoadNative() with MCP_DISABLE_NATIVE escape
    scripts/
      mcp-dev-proxy.ts      handshake-replay proxy for live source-reload
      stress-mcp.ts         8-case robustness harness
      screenshots/          VHS .tape files driving docs/screenshots/*.gif
    .usage.kdl              CLI spec → completions + manpage + markdown docs
  rust-accel/               napi-rs crate (optional acceleration)

packages/
  mcp-kit, extension-core, env-loader, shared-types, test-kit,
  control-language (pure selection-language core — selector AST + resolver;
  the browser binding lives in-app at src/select/: snapshot-backed
  SelectionDomain with typed fields, journal-fed temporal fields,
  runtime-probed live-move-domain metadata, a journal-MRU focused-window
  fallback for when no browser window is OS-focused, and the pure transform
  planner at src/select/plan/ — bounded effect IR, LIS-minimal relocations,
  the frozen edge-policy table enforced at plan time),
  tsconfig, biome-config, vitest-config
  (robustness ^0.7.0 / cli-kit ^2.0.1 / tui-kit ^0.4.1 are npm deps published
   from mcp-cli-starter-template — no longer vendored here, and bundled inline
   so the shipped bin stays self-contained)

mise.toml                   toolchain pins (node, pnpm) + named tasks
.github/workflows/          ci.yml, release.yml (release-please; tags+releases, no npm publish),
                            readme-check.yml, screenshots.yml
docs/                       Mintlify-ready (docs.json + MDX pages)
skills/browser-tab/             Repo-installable companion skill (rewrite at scaffold time)
```

## License

MIT
