# wm-stack contract

The interface `~/dotfiles/wm-stack` rewires around, replacing
`scripts/browser_tabs.sh` (osascript one-shot) and `scripts/move_chrome_tab.sh`
(deferred no-op). Three surfaces expose the same shapes:

| Surface | For | Latency |
|---|---|---|
| Unix socket `~/.browser-tab/daemon.sock` | Hammerspoon/long-lived consumers (subscribe = push events) | <5ms |
| Snapshot file `~/.cache/browser-tab/snapshot.json` | sketchybar / shell one-liners | free (read a file) |
| `browser-tab list --json` | scripts, ad-hoc | ~50ms (daemon up) / ~300ms+ (degraded osascript) |

## Snapshot shape (version 2)

> **v2 is a strict superset of v1** — every field below that v1 didn't have is
> optional or defaulted. Consumers MUST tolerate unknown fields and MUST NOT
> hard-assert `version === 1`. See "Versioning" below.

```jsonc
{
  "version": 2,
  "generatedAt": 1752900000000,          // epoch ms
  "source": "daemon",                     // "daemon" | "osascript-direct" (degraded)
  "focusedBrowser": "chrome",             // v2; optional — OS-frontmost browser (native CG tier only)
  "browsers": [{
    "browser": "chrome",                  // chrome | brave | chromium | safari
    "bundleId": "com.google.Chrome",
    "pid": 878,                           // null when not running
    "running": true,
    "extensionConnected": true,           // live WS session from the connector extension
    "dataSource": "extension",            // "extension" | "applescript" — which source won
    "capabilities": {                     // v2; optional — per-browser feature availability
      "tabGroups": true, "audible": true, "discard": true, "navigate": true, "history": true
      // …runtime-probed (extension) or a static map (applescript). Gate on these, not on browser name.
    },
    "error": "…",                         // optional; e.g. Automation permission denied
    "tabGroups": [{                       // v2; Chrome-family extension only ([] otherwise)
      "groupId": "g:chrome:x77",          // OPAQUE handle
      "windowId": "w:chrome:x812",
      "title": "Work", "color": "blue", "collapsed": false
    }],
    "windows": [{
      "windowId": "w:chrome:x812",        // OPAQUE — never parse
      "cgWindowId": 236,                  // == yabai window id; null when correlation failed
      "title": "Inbox – Gmail",
      "bounds": { "x": 40, "y": 50, "w": 1996, "h": 1269 },
      "focused": true,
      "incognito": false,
      "activeTabIndex": 0,                // 0-based
      "activeTabId": "t:chrome:x4001",    // v2; optional — handle of the active tab
      "state": "normal",                  // v2; optional — normal|minimized|maximized|fullscreen (ext-sourced)
      "tabCount": 31,
      "tabs": [{
        "tabId": "t:chrome:x4001",        // OPAQUE — pass back to commands verbatim
        "index": 0,                       // 0-based position in window
        "url": "https://mail.google.com/…",
        "title": "Inbox – Gmail",         // sanitized; still UNTRUSTED web content
        "active": true,
        "groupId": "g:chrome:x77",        // v2; optional — tab-group handle when grouped
        "pinned": false,                  // extension-sourced only (false under applescript)
        "audible": false,
        "discarded": false,
        "muted": false,                   // v2 (defaulted false)
        "mutedReason": "user",            // v2; optional — Chrome only
        "frozen": false,                  // v2 (defaulted false) — Chrome 132+
        "lastAccessed": 1752899990000,    // v2; optional — Chrome 121+
        "status": "complete"              // v2; optional — loading|complete|unloaded
      }]
    }]
  }]
}
```

The **snapshot file and `browser-tab list --json` always emit the full shape.**
The `list_tabs` MCP tool defaults to a trimmed `fields:"core"` projection (drops
the enrichment optionals, tab groups, and capabilities) for token economy; pass
`fields:"full"` for everything.

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
5. **Gate on `capabilities`, not browser name.** A field/command's availability
   varies by browser AND version (e.g. Safari has no `tabGroups`/`discard`/
   `history`; `frozen` is Chrome 132+). Check `browsers[].capabilities[<key>]`
   before relying on an enrichment field or issuing a v2 command. Under
   AppleScript the map reflects the (smaller) AppleScript feature set.

### Versioning

`version` increments on **additive milestones** (v1 → v2 added capabilities,
tab groups, focus/audio/sleep enrichments, `focusedBrowser`). The rule for
consumers: **tolerate unknown fields, treat every non-core field as optional,
and never hard-assert a specific `version`.** A genuinely breaking change (a
field removed or re-typed) would bump to a new major with its own migration
section — additive growth stays within the current major. After upgrading the
tool, `browser-tab daemon restart` so a long-running launchd daemon serves the
new shape (`daemon_status.contractVersion` reports what it's currently serving;
`doctor` flags a mismatch).

## Unix-socket protocol (NDJSON — one JSON object per line)

Request `{"id":1,"method":"getSnapshot"}` → `{"id":1,"ok":true,"result":{…snapshot…}}`

Methods: `getSnapshot` · `subscribe` · `unsubscribe` · `status` (also returns
`displays[]` and the per-browser `capabilities` map) · `refresh`
(force an immediate rescan) · `command` (params: `{"kind": …, …tool-input fields}`) ·
`journal` (params: `{"view":"windowMru"|"tabMru"|"journey"|"recent", browser?, windowId?, tabId?, limit?}`
→ the daemon's recorded focus/navigation history; `focus[]` for windowMru/tabMru/recent,
`nav[]` for journey. Handles in journal records are for correlation only — they may be stale) ·
`getPage` (params: `{"tabId", "mode":"metadata"|"text"|"state", "force"?}` → extracted page
content/state; extension-only, cached per `navEpoch`; returns `{mode, url, title?, text?, metadata?,
state?, navEpoch, cached, ...}` — all text is untrusted web content) ·
`annotate` (params: `{"url", "note"?}` → URL-keyed note cache; `note` present = set, absent = read;
returns `{url, note?, updatedAt?, existed}`) ·
`screenshot` (params: `{"tabId"?, "windowId"?, "force"?, "focus"?}` — exactly one of tabId/windowId.
tabId = tier "tab" (extension `captureVisibleTab`, active-tab preflight, 2/s rate-limit, cached per
`navEpoch`); windowId = tier "window" (`screencapture -l <cgWindowId>`, opt-in via
`BROWSER_TAB_WINDOW_CAPTURE`). Returns `{tier, path, bytes, format:"jpeg", cached, navEpoch?}`; the
MCP tool additionally emits the jpeg as a base64 image content block).

`history` (params: `{"browser"?, "query"?, "startTime"?, "endTime"?, "maxResults"?}` — the browser's
persisted URL history, distinct from `journal`. Chrome-family reads it via the extension
(`chrome.history`); Safari via a daemon-side sqlite copy of `History.db` (opt-in via
`BROWSER_TAB_SAFARI_HISTORY`, needs Full Disk Access). Omit `browser` to merge every reachable
source; an explicit-but-unavailable source errors. Returns `{rows: [{url, title?, visitTime, visitCount,
browser}], truncated}`, newest first. URLs/titles are untrusted).

Command `kind`s and their tool-input fields:

| kind | fields | notes |
|---|---|---|
| `focus_tab` / `close_tab` | `tabId` | |
| `move_tab` | `tabId`, `targetWindowId?`, `targetIndex?`, `newWindow?`, `targetGroupId?`, `allowReload?` | true move via extension; Safari AppleScript reloads (needs `allowReload`) |
| `open_tab` | `url`, `browser?`, `windowId?`, `activate?`, `index?`, `pinned?`, `groupId?` | `index`/`pinned`/`groupId` are extension-only |
| `tab_action` | `tabId`, `action`, `url?` | action ∈ mute\|unmute\|pin\|unpin\|discard\|reload\|navigate\|back\|forward\|duplicate; AppleScript covers navigate/reload (+ back/forward on Chromium), rest need the extension |
| `group_tabs` | `action`, `tabIds?`, `groupId?`, `title?`, `color?`, `collapsed?`, `targetWindowId?`, `index?`, `browser?` | action ∈ create\|add\|remove\|update\|move; extension-only (Chrome-family) |
| `open_window` | `urls[]`, `browser?`, `bounds?`, `display?`, `state?`, `incognito?`, `focused?` | `bounds` {x,y,w,h} global points wins over `display` (0-based monitor index → fills it); AppleScript supports bounds + normal/minimized |
| `set_window` | `windowId`, `bounds?`, `display?`, `state?`, `focused?` | as above |
| `close_window` | `windowId` | destructive — closes every tab in the window |

`CommandResult` carries `{ok, command, browser, tabId?, windowId?, groupId?, index?, payload?}`.
Handles come from `list_tabs`; a command may reissue a handle — re-list afterward.
`display` targeting needs the native module (`list_displays()`); without it, use explicit
`bounds` in global screen coordinates. Query available displays via the `status` method.

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
