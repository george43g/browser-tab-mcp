# Handoff — browser-tab build state (2026-07-19)

For an agent continuing this work. The full daemon+extension architecture
landed in one effort (plan: `~/.claude/plans/research-whether-osascript-is-snuggly-blossom.md`);
this file is the delta an agent can't infer from the code alone.

## What is DONE and verified

| Piece | State | Verified how |
|---|---|---|
| HTTP transport removal | done | `pnpm verify`, stress 13/13 |
| osascript engine (chrome/brave/chromium/safari adapters) | done | real-machine parity vs old `~/dotfiles/wm-stack/scripts/browser_tabs.sh` (2 windows/33 tabs identical) |
| cgWindowId correlation (rust-accel CGWindowList) | done | ids match `yabai -m query --windows` exactly, incl. windows on other Spaces |
| Daemon (poll loop, merge, unix IPC, snapshot cache, launchd) | done, **installed & running** on this machine | real focus_tab flipped Chrome's active tab; SIGTERM unlinks socket; launchd KeepAlive verified |
| Chrome MV3 extension + WS protocol + `move_tab` routing | code done, bundle builds | scripted fake-extension client tests (auth reject, merge precedence, command round-trip, disconnect fallback) — **not yet loaded in real Chrome** |
| Safari extension | prep only (`apps/safari-extension/`) | blocked: no full Xcode on this machine |
| TUI tab manager | done | `stress:tui` soak (RSS 220MB max, lag bounded) |
| Docs/contract | done | `docs/WM_STACK_CONTRACT.md` is the consumer contract |

Suites: 58 app tests + 9 extension-core tests + 7 shared-types (incl. Rust
drift) all green; `pnpm verify`, `pnpm test:no-native`, `pnpm stress`
(13 assertions / 10 cases), `check:usage` all green.

## Live machine state (may drift — verify, don't assume)

- LaunchAgent `com.george43g.browser-tab` installed and running from
  `apps/browser-tab-mcp/dist/cli.js` (KeepAlive). `browser-tab daemon status`
  → chrome scanning fine (Automation/TCC consent granted for launchd-node on
  2026-07-19), WS on 8790, correlation tier `native`.
- Extension token exists at `~/.browser-tab/extension-token`.
- **After any rebuild that should reach the daemon: `pnpm build` then
  `node apps/browser-tab-mcp/dist/cli.js daemon restart`.**

## Immediate next steps (in order)

1. **Real-Chrome extension E2E** (user must first load
   `apps/chrome-extension/dist` unpacked + paste `daemon token` into options):
   verify `daemon_status` shows `extensions:["chrome"]`, `list_tabs` hands out
   `t:chrome:x…` handles, `browser-tab move <xTab> --target-window <xWin>`
   preserves page state (scroll/form), kill the SW via
   `chrome://serviceworker-internals` → reconnect <30s (alarms watchdog).
2. **wm-stack rewire** (separate repo `~/dotfiles/wm-stack`, out of scope here
   but next in line): migration table at the bottom of
   `docs/WM_STACK_CONTRACT.md`. Call sites found earlier:
   `sketchybar/plugins/update_spaces.sh`, `sketchybar/plugins/request_window_reorg.sh`,
   `lib/select-window.lua` (cached 30s), `modules/modes/hammerspoon/modal_modes.lua`,
   `modules/spaces_modal/hammerspoon/adapters.lua`, `modules/dashboard/hammerspoon/nerds/adapters.lua`,
   `modules/dashboard/scripts/collect_stats.sh`, plus
   `modules/core/hammerspoon/storage.lua` (reads the old snapshot path) and
   the deferred AI-reorg `move_tabs` path (`docs/deferred-features.md`,
   `modules/dashboard/hammerspoon/reorg.lua`). Join on `cgWindowId`, not titles.
3. **Safari extension** once user installs Xcode:
   `apps/safari-extension/scripts/convert.sh`, sign both targets with his
   team, enable in Safari, paste token, set browser=safari in options. Then
   run the background-lifetime soak in `apps/safari-extension/README.md`
   (unproven: Safari may kill the background page despite WS traffic — if so,
   Safari stays on the AppleScript path automatically; consider then making
   the connection nudge-able or accepting reads-via-AppleScript + commands-only).

## Gotchas that cost time (don't rediscover)

- **vite lib build picks deps' `browser` export condition** — bundling `ws`
  produced a dead stub *only in dist* (tsx path fine). Any new Node-only dep
  → add to `rollupOptions.external` in `apps/browser-tab-mcp/vite.config.ts`.
- **TCC consent kill loop**: SIGKILLing osascript on timeout dismisses the
  macOS Automation dialog; next poll re-prompts forever. Fixed:
  `effectiveOsaTimeoutMs()` in `src/detect/osascript.ts` gives each app a 60s
  first-contact window per process. Permission attributes to the *node
  binary* under launchd — node upgrades re-prompt silently (-1743); `doctor`
  surfaces it.
- **CGWindowList must use `kCGWindowListOptionAll`** (OnScreenOnly misses
  other Spaces). Never read `kCGWindowName` (Screen Recording TCC).
- **Two tab-id generations**: AppleScript `t:chrome:123` vs extension
  `t:chrome:x123` (different native id spaces; no cross-mapping by design).
  Commands route by generation; stale-generation → "re-run list_tabs" error.
  Safari AppleScript ids are synthetic `t:safari:w<win>:i<index1>`.
- **`browsers[]` is sorted alphabetically** (brave < chrome < safari) after
  the poll merge — don't index `[0]` expecting chrome.
- Safari AppleScript `move` reloads the page → gated behind `allowReload`;
  Safari `targetIndex` unsupported (append-only) via AppleScript.
- Repo rule: every CLI change must update `.usage.kdl` + `pnpm artifacts`
  (CI gate `check:usage`); README must change alongside `src/**` (readme-check).

## Key files (fastest orientation path)

- Contract: `docs/WM_STACK_CONTRACT.md` · Schemas: `packages/shared-types/src/index.ts`
- Engine: `apps/browser-tab-mcp/src/detect/{engine,osascript,parse,ids,correlate}.ts`,
  adapters under `src/detect/adapters/` (fake adapter = `BROWSER_TAB_FAKE_ADAPTER=1`)
- Daemon: `src/daemon/{index,engine-loop,merge,state,ipc-server,ws-server,launchd,token,paths,snapshot-writer}.ts`
  (command routing lives in `src/daemon/index.ts:executeCommand`)
- Clients: `src/client/{daemon-client,tabs-service}.ts` (tabs-service = the
  single daemon→fallback routing layer all tools use)
- Extension: `packages/extension-core/src/*`, `apps/chrome-extension/{public,src}`
- TUI: `src/tui/{App.tsx,rows.ts,useSnapshot.ts}`
- Tests: `apps/browser-tab-mcp/tests/{adapters,correlate,integration,daemon-ipc,ws-server}.test.ts`

## Deliberate deviations from the original plan

- Safari WS-lifetime spike (M0-A) couldn't run — no Xcode; risk carried into
  the M6 checklist above instead. Fallback path exists so nothing is blocked.
- TUI has no `o` (open URL) prompt — `browser-tab open <url>` covers it; ink
  text input wasn't worth the complexity.
- MCPB manifest narrowed to `darwin` only.
