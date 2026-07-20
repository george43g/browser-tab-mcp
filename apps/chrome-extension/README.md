# browser-tab connector (MV3 extension)

The connector extension for the `browser-tab` daemon. It streams live
tab/window state to the daemon over a localhost WebSocket and executes **true
state-preserving tab moves** (`chrome.tabs.move`) — the thing AppleScript
can't do. One bundle serves Chrome, Brave, Chromium, and (packaged via
`apps/safari-extension`) Safari.

## What it does

- **Push events** — `tabs.on*` / `windows.on*` → a debounced full snapshot to
  the daemon, replacing 5s polling with instant updates.
- **Commands over the socket** — `move_tab` / `focus_tab` / `close_tab` /
  `open_tab` via `chrome.tabs.*`, so a cross-window move keeps scroll/form/JS
  state. These carry the `x`-prefixed handle generation (`t:chrome:x123`).
- **Observability** — a toolbar **popup** and a **settings page** show live
  connection status (dot + word), the daemon `127.0.0.1:port`, window/tab
  counts, last event time, and the real error if it can't connect. The
  background worker logs everything with a `[browser-tab]` prefix.

## Load it (Chrome / Brave / Chromium)

```bash
pnpm --filter @george43g/chrome-extension build   # → dist/
```

`chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select `apps/chrome-extension/dist`. Open the extension's **options**, paste
the token from `browser-tab daemon token`, set the browser, **Save**. The
toolbar icon shows the live status; a green dot = connected.

Safari packaging lives in `apps/safari-extension` (see its README).

## Layout

| File | Role |
|---|---|
| `public/manifest.json` | MV3 manifest — `background.service_worker` (Chrome) **+** `background.scripts` (Safari/Firefox background page), `action` popup, `options_page`, icons |
| `src/background.ts` | owns the `DaemonSocket`; tracks state; answers `getStatus`/`reconnect` page messages; keepalive alarm |
| `src/status-view.ts` | shared fetch + render of the status/stats DOM (popup and settings use it) |
| `src/popup.ts` · `public/popup.html` | toolbar popup |
| `src/options.ts` · `public/options.html` | settings page (token/port/browser + live status) |
| `public/ui.css` | wm-stack instrument-panel theme (design-system tokens inlined; no remote font — extension CSP) |
| `vite.config.ts` | builds each entry as a **self-contained IIFE** (no ES modules / shared chunks) so the same bundle runs as a Chrome service worker AND a Safari background page |

Shared, browser-agnostic logic (socket, snapshot mappers, status presenter,
options storage) lives in `packages/extension-core`.

## Gotchas

- **Self-contained IIFE build, not ES modules.** Safari doesn't support
  `background.type: "module"` and can't `import` in a classic background
  script. The build inlines each entry (`format: "iife"`,
  `inlineDynamicImports`, one pass per `EXT_ENTRY`). Page `<script>` tags are
  classic, not `type="module"`.
- **Dual background keys.** Chrome uses `service_worker`; Safari's MV3 service
  worker is unreliable (idles out, never appears in Web Extension
  Backgrounds), so `scripts` gives it a persistent background page. Chrome may
  show a harmless "`background.scripts` requires MV2" warning — it still uses
  the service worker.
- **Cross-browser messaging.** Chrome resolves `sendMessage` via
  `sendResponse` + `return true`; Safari/Firefox only resolve if the listener
  **returns a promise**. `background.ts` detects the namespace and does both.

## Testing

This app currently has **no automated tests** — only its pure logic is covered
(via `packages/extension-core/src/{status,snapshot}.test.ts`). The runtime
(`background.ts`, socket, messaging, popup/options) and the built bundle are
unvalidated, so CI cannot catch the class of bugs this connector hit (module
SW, dual background, cross-browser messaging). The plan to close that —
a real client↔server Node integration test, static build-output guards, and
coverage enforcement — is in **`docs/FOLLOWUPS.md`** (with a harness sketch).
Read it before adding tests here.
