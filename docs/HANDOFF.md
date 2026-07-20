# Handoff — browser-tab build state (2026-07-21)

For an agent continuing this work. The full daemon+extension architecture
landed in one effort (plan: `~/.claude/plans/research-whether-osascript-is-snuggly-blossom.md`);
this file is the delta an agent can't infer from the code alone.

**Status (2026-07-21): the tool is complete and working end-to-end on this
machine — Chrome AND Safari extensions both connect and stream live tab state
with true state-preserving moves.** The one substantial remaining task is the
**wm-stack rewire** (separate repo, § Immediate next steps).

## What is DONE and verified

| Piece | State | Verified how |
|---|---|---|
| HTTP transport removal | done | `pnpm verify`, stress 13/13 |
| osascript engine (chrome/brave/chromium/safari adapters) | done | real-machine parity vs old `~/dotfiles/wm-stack/scripts/browser_tabs.sh` (2 windows/33 tabs identical) |
| cgWindowId correlation (rust-accel CGWindowList) | done | ids match `yabai -m query --windows` exactly, incl. windows on other Spaces |
| Daemon (poll loop, merge, unix IPC, snapshot cache, launchd) | done, **installed & running** on this machine | real focus_tab flipped Chrome's active tab; SIGTERM unlinks socket; launchd KeepAlive verified |
| Chrome MV3 extension + WS protocol + `move_tab` routing | **loaded & verified in real Chrome (2026-07-20)** | live: auth, snapshot push, `open_tab`/`close_tab` over the socket returned `x` handles; survived a daemon restart (reconnect ~6s) + 10.5h uptime |
| Safari extension | **loaded & verified — connects, green status (2026-07-21)** | after the background-page + IIFE + messaging fixes (see gotchas); `sideload` builds one signed app, Safari shows one entry, popup dot = connected |
| Extension UI + observability (popup + settings, wm-stack theme) | done | live status/stats in both browsers; background logs `[browser-tab] …`; settings surfaces the real connect error |
| Extension-feed merge (socket-liveness authority) | done | `dataSource:"extension"` holds through 25s idle; `merge.test.ts` + `ws-heartbeat.test.ts` |
| Safari `sideload`/`convert`/`unregister` automation | done | one-command reload loop; single-DerivedData (no dup registration) |
| TUI tab manager | done | `stress:tui` soak (RSS 220MB max, lag bounded) |
| Docs/contract | done | `docs/WM_STACK_CONTRACT.md` is the consumer contract |

Suites: 64 app tests + 22 extension-core (status + snapshot mappers) + 7
shared-types (incl. Rust drift) all green; `pnpm verify`, `pnpm test:no-native`,
`pnpm stress` (13 assertions / 10 cases), `check:usage` all green.

## Live machine state (may drift — verify, don't assume)

- LaunchAgent `com.george43g.browser-tab` installed and running from
  `apps/browser-tab-mcp/dist/cli.js` (KeepAlive). `browser-tab daemon status`
  → chrome scanning fine (Automation/TCC consent granted for launchd-node on
  2026-07-19), WS on 8790, correlation tier `native`.
- Extension token exists at `~/.browser-tab/extension-token`.
- **After any rebuild that should reach the daemon: `pnpm build` then
  `node apps/browser-tab-mcp/dist/cli.js daemon restart`.**

## Immediate next steps

1. **wm-stack rewire — THE remaining task** (separate repo `~/dotfiles/wm-stack`,
   out of scope for this repo but next in line): migration table at the bottom
   of `docs/WM_STACK_CONTRACT.md`. Call sites found earlier:
   `sketchybar/plugins/update_spaces.sh`, `sketchybar/plugins/request_window_reorg.sh`,
   `lib/select-window.lua` (cached 30s), `modules/modes/hammerspoon/modal_modes.lua`,
   `modules/spaces_modal/hammerspoon/adapters.lua`, `modules/dashboard/hammerspoon/nerds/adapters.lua`,
   `modules/dashboard/scripts/collect_stats.sh`, plus
   `modules/core/hammerspoon/storage.lua` (reads the old snapshot path) and
   the deferred AI-reorg `move_tabs` path (`docs/deferred-features.md`,
   `modules/dashboard/hammerspoon/reorg.lua`). Join on `cgWindowId`, not titles.
   Consume `browser-tab list --json` or the unix socket; `move` requires the
   daemon + a connected extension.

2. **Optional polish / loose ends:**
   - Safari **background-lifetime soak** (`apps/safari-extension/README.md`):
     leave Safari idle 30 min, confirm it stays connected or reconnects. The
     `scripts` background *page* should stay alive (unlike the MV3 SW), but
     it's unproven over long idles — if it dies, Safari falls back to the
     AppleScript path automatically.
   - Chrome extension SW-kill reconnect (`chrome://serviceworker-internals`)
     — should reconnect <30s (alarms watchdog); keepalive already proven by a
     clean reconnect after `daemon restart`.
   - The dual `background.scripts` key makes Chrome print a harmless
     "requires MV2" warning. To make Chrome pristine, a Safari-only manifest
     (drop `service_worker`) would need a `convert` + re-sign — not worth it
     unless the warning bothers someone.
   - Mobile Safari: **deferred** (user decision).

**Both browser extensions are DONE and verified** (2026-07-21). The Chrome and
Safari fixes + the extension UI/observability + the merge liveness fix + the
Safari packaging automation all landed; see the DONE table and gotchas.

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

Connector-extension gotchas (all fixed; **don't regress**) — see the
"Connector extension" + "Extension–daemon merge" sections in `AGENTS.md` and
`apps/chrome-extension/README.md` for the full story:

- **Safari can't run an MV3 service worker** reliably (never lists in *Develop
  → Web Extension Backgrounds*, unmessageable). Manifest ships BOTH
  `background.service_worker` (Chrome) and `background.scripts` (Safari →
  background page). Also: no `background.type:"module"` — build is
  **self-contained IIFE** (`format:"iife"`, one pass per `EXT_ENTRY`), classic
  `<script>` tags. Reintroducing modules/chunks breaks Safari.
- **Cross-browser messaging**: Safari/Firefox `sendMessage` resolves only if
  the listener **returns a promise**; Chrome needs `sendResponse`+`return
  true`. `background.ts` branches on `globalThis.browser`.
- **Merge authority = socket liveness, not snapshot age** (`merge.ts` +
  `ws-server.ts` heartbeat + `extFeedTtlMs()`). Age-gating made idle browsers
  silently revert to AppleScript handles.
- **Safari duplicate-extension trap**: two container-app builds in different
  DerivedData = extension listed twice. `sideload` builds into Xcode's default
  DerivedData; `unregister` (clean.sh) prunes stale copies.
- Generated `apps/safari-extension/xcode/` is **gitignored** (personal signing)
  and biome-ignored; regenerate with `pnpm --filter @george43g/safari-extension convert`.

## Key files (fastest orientation path)

- Contract: `docs/WM_STACK_CONTRACT.md` · Schemas: `packages/shared-types/src/index.ts`
- Engine: `apps/browser-tab-mcp/src/detect/{engine,osascript,parse,ids,correlate}.ts`,
  adapters under `src/detect/adapters/` (fake adapter = `BROWSER_TAB_FAKE_ADAPTER=1`)
- Daemon: `src/daemon/{index,engine-loop,merge,state,ipc-server,ws-server,launchd,token,paths,snapshot-writer}.ts`
  (command routing lives in `src/daemon/index.ts:executeCommand`)
- Clients: `src/client/{daemon-client,tabs-service}.ts` (tabs-service = the
  single daemon→fallback routing layer all tools use)
- Extension: `packages/extension-core/src/*` (`socket`, `status`, `log`,
  `snapshot`, `options`, `runtime`), `apps/chrome-extension/{public,src}`
  (`background`, `status-view`, `popup`, `options`), `apps/safari-extension/scripts/*`
- TUI: `src/tui/{App.tsx,rows.ts,useSnapshot.ts}`
- Tests: `apps/browser-tab-mcp/tests/{adapters,correlate,integration,daemon-ipc,ws-server,merge,ws-heartbeat}.test.ts`,
  `packages/extension-core/src/{status,snapshot}.test.ts`

## Deliberate deviations from the original plan

- Safari WS-lifetime spike (M0-A) was deferred (no Xcode at the time) and
  resolved later: the extension now connects via a background *page*
  (`scripts`), not the flaky MV3 service worker. Long-idle soak still worth
  running; AppleScript fallback exists regardless.
- TUI has no `o` (open URL) prompt — `browser-tab open <url>` covers it; ink
  text input wasn't worth the complexity.
- MCPB manifest narrowed to `darwin` only.
