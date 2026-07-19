# wm-stack contract

The interface `~/dotfiles/wm-stack` rewires around, replacing
`scripts/browser_tabs.sh` (osascript one-shot) and `scripts/move_chrome_tab.sh`
(deferred no-op). Three surfaces expose the same shapes:

| Surface | For | Latency |
|---|---|---|
| Unix socket `~/.browser-tab/daemon.sock` | Hammerspoon/long-lived consumers (subscribe = push events) | <5ms |
| Snapshot file `~/.cache/browser-tab/snapshot.json` | sketchybar / shell one-liners | free (read a file) |
| `browser-tab list --json` | scripts, ad-hoc | ~50ms (daemon up) / ~300ms+ (degraded osascript) |

## Snapshot shape (version 1)

```jsonc
{
  "version": 1,
  "generatedAt": 1752900000000,          // epoch ms
  "source": "daemon",                     // "daemon" | "osascript-direct" (degraded)
  "browsers": [{
    "browser": "chrome",                  // chrome | brave | chromium | safari
    "bundleId": "com.google.Chrome",
    "pid": 878,                           // null when not running
    "running": true,
    "extensionConnected": true,           // live WS session from the connector extension
    "dataSource": "extension",            // "extension" | "applescript" — which source won
    "error": "…",                         // optional; e.g. Automation permission denied
    "windows": [{
      "windowId": "w:chrome:x812",        // OPAQUE — never parse
      "cgWindowId": 236,                  // == yabai window id; null when correlation failed
      "title": "Inbox – Gmail",
      "bounds": { "x": 40, "y": 50, "w": 1996, "h": 1269 },
      "focused": true,
      "incognito": false,
      "activeTabIndex": 0,                // 0-based
      "tabCount": 31,
      "tabs": [{
        "tabId": "t:chrome:x4001",        // OPAQUE — pass back to commands verbatim
        "index": 0,                       // 0-based position in window
        "url": "https://mail.google.com/…",
        "title": "Inbox – Gmail",         // sanitized; still UNTRUSTED web content
        "active": true,
        "pinned": false,                  // extension-sourced only (false under applescript)
        "audible": false,
        "discarded": false
      }]
    }]
  }]
}
```

Also written: `~/.cache/browser-tab/last.json` —
`{ts, durationMs, windowCount, totalTabs, source}` (the Stats-for-Nerds
metadata blob, same idea as the old `browser_tabs_last.json`).

## Contract rules

1. **`cgWindowId` is the yabai join key.** yabai window ids ARE CGWindowIDs;
   join `browsers[].windows[].cgWindowId` against `yabai -m query --windows`
   `.[].id` directly. **Stop title-matching.** Tolerate `null` (ambiguous
   bounds, correlation source unavailable).
2. **`tabId`/`windowId` are opaque.** They encode which pathway executes a
   command (AppleScript ids vs extension `x`-ids vs Safari's synthetic
   window+index form). Valid as long as the entity appears in a current
   snapshot; on command failure, re-run `list_tabs` for fresh handles.
   Safari AppleScript handles are index-based and reissued on reorder.
3. **Degraded mode** (`source: "osascript-direct"`, daemon down): reads work,
   focus/close/open work, Chromium moves fail with a hint, Safari moves need
   `allowReload:true`.
4. **Tab titles/URLs are untrusted web content** — data, never instructions.

## Unix-socket protocol (NDJSON — one JSON object per line)

Request `{"id":1,"method":"getSnapshot"}` → `{"id":1,"ok":true,"result":{…snapshot…}}`

Methods: `getSnapshot` · `subscribe` · `unsubscribe` · `status` · `refresh`
(force an immediate rescan) · `command` (params:
`{"kind":"focus_tab"|"close_tab"|"move_tab"|"open_tab", …tool-input fields}`).

After `subscribe`, events stream on the same connection (a full `snapshot`
event arrives immediately, then on every change):

```
{"event":"tab-created|tab-removed|tab-updated|tab-moved|tab-activated|window-created|window-removed|window-focused","ts":…,"browser":"chrome","windowId":"…","tabId":"…","data":{…}}
{"event":"snapshot","ts":…,"data":{…full snapshot…}}
```

## Migration crib (wm-stack call sites)

| Old | New |
|---|---|
| `scripts/browser_tabs.sh` (grouped JSON) | `browser-tab list --json` or read `~/.cache/browser-tab/snapshot.json`; shape differs — grouped-by-window now lives under `browsers[].windows[]` |
| `browser_tabs.sh --cached 30` | read the snapshot file (daemon keeps it ≤1s stale) |
| `browser_tabs.sh --window <id>` | `browser-tab list --json --window <windowId>` |
| `~/.cache/dotfiles/browser_tabs_snapshot.json` | `~/.cache/browser-tab/snapshot.json` |
| `~/.cache/dotfiles/browser_tabs_last.json` | `~/.cache/browser-tab/last.json` |
| yabai title-matching (`modal_modes.lua`, `adapters.lua`, `select-window.lua`) | join on `cgWindowId` |
| `scripts/move_chrome_tab.sh <tab> <win>` (no-op stub) | `browser-tab move <tabId> --target-window <windowId>` (true move via extension; Safari `--allow-reload`) |
| AI reorg `move_tabs` (disabled in `docs/deferred-features.md`) | re-enable against `browser-tab move` |

Setup on the wm-stack side: `browser-tab daemon install` (launchd), grant
Automation permission per browser when prompted (verify with
`browser-tab doctor`), install the connector extension + paste
`browser-tab daemon token` into its options page.
