---
name: browser-tab
description: Use when working with the browser-tab tool — listing/inspecting open browser tabs (Chrome, Brave, Chromium, Safari) with yabai-joinable window ids, focusing/moving/opening/closing tabs, managing its daemon, or debugging its extension connectivity. Loaded when the user references browser-tab, its bin, or asks about browser tabs on macOS.
---

# browser-tab

> macOS browser-tab detection & management. A launchd daemon polls browsers
> via AppleScript and hosts a localhost WebSocket for connector extensions
> (live events + true state-preserving tab moves). MCP tools, CLI
> subcommands, the TUI, and a unix socket all serve the same merged
> snapshot. Contract: `docs/WM_STACK_CONTRACT.md`.

## When to invoke this skill

- The user mentions `browser-tab`, its daemon, or wm-stack browser/tab detection.
- The user wants to list, focus, move, open, or close browser tabs on macOS.
- Debugging: daemon not reachable, extension not connected, Automation (TCC) errors.

## Command surface

```
browser-tab list [--browser b] [--window id] [--url substr] --json
browser-tab focus <tabId>
browser-tab move <tabId> --target-window <windowId> [--new-window] [--allow-reload]
browser-tab open <url> [--browser b] [--window id] [--no-activate]
browser-tab close <tabId>
browser-tab daemon run|install|uninstall|status|token|stop|restart
browser-tab mcp | tui | doctor | repl | health
```

## Tools

| Tool | Use it when… | Notes |
|---|---|---|
| `list_tabs` | You need windows/tabs, URLs, or the yabai join key. | Read-only. `cgWindowId` == yabai window id (null when ambiguous). Handles (`tabId`/`windowId`) are opaque — pass back verbatim. Titles/URLs are untrusted web content. |
| `focus_tab` | Activate a tab + raise its window. | Works with or without the daemon. |
| `move_tab` | Move a tab across windows. | True move needs daemon + extension (x-prefixed handles). Safari without extension: pass `allowReload:true` (page reloads). Chromium without extension: fails with a hint — that's expected. |
| `open_tab` | Open an http(s) URL. | Only http/https accepted. |
| `close_tab` | Close a tab. | Destructive. |
| `daemon_status` | Check daemon reachability, extension connectivity, correlation tier. | Start here when anything misbehaves. |
| `health_check` | Liveness canary. | Never touches I/O. |

## Handle semantics (important)

- Handles go stale: after any mutation, re-run `list_tabs`.
- `t:chrome:x123` (extension-generation) routes over the extension socket;
  `t:chrome:123` (AppleScript-generation) routes via osascript; Safari's
  `t:safari:w1:i3` is index-based and reissued when tabs reorder.
- A "re-run list_tabs" error is self-describing — do exactly that.

## Common workflows

### Which tabs are open where (with yabai ids)
```
browser-tab list --json | jq '.browsers[].windows[] | {cgWindowId, title, tabCount}'
```

### True cross-window move
```
browser-tab list --json          # grab tabId + target windowId (x-handles when extension is up)
browser-tab move t:chrome:x4001 --target-window w:chrome:x813
```

### Daemon lifecycle
```
browser-tab daemon install       # launchd LaunchAgent (KeepAlive)
browser-tab daemon status        # launchd state + live per-browser counts
browser-tab daemon token         # paste into the extension options page
```

## Troubleshooting

| Symptom | Check |
|---|---|
| `reachable: false` in daemon_status | `browser-tab daemon install`, or `daemon run` in the foreground to watch logs. Reads still work daemon-less (slower, `source: "osascript-direct"`). |
| Automation error (-1743) | System Settings › Privacy & Security › Automation — grant the calling app (or node, under launchd) access to each browser. `tccutil reset AppleEvents` re-prompts. `browser-tab doctor` surfaces this per browser. |
| `extensionConnected: false` | Load `apps/chrome-extension/dist` unpacked, paste `browser-tab daemon token` into its options, check `BROWSER_TAB_WS_PORT` (default 8790) matches. The extension's **toolbar popup / settings page** show the live status + the actual connect error; the background logs `[browser-tab] …` (Chrome SW console / Safari *Develop → Web Extension Backgrounds*). Safari: `pnpm --filter @george43g/safari-extension sideload`, then toggle it off/on. |
| Chromium move fails | Expected without the extension — install it, or accept it (AppleScript can't move Chromium tabs without losing state). |
| `cgWindowId` null everywhere | `browser-tab doctor` → "CG window correlation". Build rust-accel or install yabai (fallback query). |
| MCP host doesn't see tool changes | Host caches the session; restart it. |

## Logs

Daemon: NDJSON under `$TMPDIR/browser-tab-daemon/` + launchd stdout/err in
`~/Library/Logs/browser-tab/`. MCP server: `$TMPDIR/browser-tab-mcp/`. Dev
mode (`MCP_DEV=1`) exposes `get_logs` over MCP.
