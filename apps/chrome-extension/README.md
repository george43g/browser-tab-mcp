# browser-tab connector (MV3 extension)

The connector extension for the `browser-tab` daemon. It streams live
tab/window state to the daemon over a localhost WebSocket and executes **true
state-preserving tab moves** (`chrome.tabs.move`) — the thing AppleScript
can't do. One bundle serves Chrome, Brave, Chromium, and (packaged via
`apps/safari-extension`) Safari.

## What it does

- **Push events** — `tabs.on*` / `windows.on*` → a debounced full snapshot to
  the daemon, replacing 5s polling with instant updates. Each tab carries its
  enrichments (audio/mute/pin/sleep/group/status) plus a **favicon** — an
  http(s) URL passes through, a small inline `data:` URI is kept, and a large
  `data:` icon is dropped at the source (`BROWSER_TAB_FAVICON_MAX_BYTES`, 4KiB)
  so it never bloats the debounced push.
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

### Permissions (v2)

The manifest requests `tabs`, `storage`, `alarms`, `tabGroups`, `webNavigation`,
`scripting`, and `history`, plus `host_permissions: ["<all_urls>"]`. These back
the full v2 surface — tab-group reads, focus/navigation journals, on-demand page
content extraction, screenshots, and browser history. The extension probes which
of these actually work at runtime and reports a **capability map** to the daemon
(Safari lacks `tabGroups`/`discard`/`history`), so nothing is assumed from the
manifest alone.

**Re-approval after a permission bump:** Chrome disables an unpacked extension
until you re-enable it whenever its permissions grow — reload it on
`chrome://extensions` after updating. On Safari, `<all_urls>` maps to per-site
prompts; grant **Always Allow on Every Website** for content extraction to work
everywhere.

## Layout

| File | Role |
|---|---|
| `public/manifest.json` | MV3 manifest — `background.service_worker` (Chrome) **+** `background.scripts` (Safari/Firefox background page), `action` popup, `options_page`, icons |
| `src/background.ts` | owns the `DaemonSocket`; tracks state; answers `getStatus`/`reconnect` page messages; keepalive alarm |
| `src/status-view.ts` | shared fetch + render of the status/stats DOM (popup and settings use it) |
| `src/popup.ts` · `public/popup.html` | toolbar popup |
| `src/options.ts` · `public/options.html` | settings page (token/port/browser + live status) |
| `public/ui.css` | wm-stack instrument-panel theme (design-system tokens inlined; no remote font — extension CSP) |
| `src/extract.ts` | the injected page extractor — bundles `@mozilla/readability`, defines the idempotent global `window.__btExtract(mode, maxBytes)` (metadata / reader-mode text / live state). Injected on demand via `scripting.executeScript` (never a persistent content script); also drives capture-on-blur (`extension-core/capture.ts`) |
| `vite.config.ts` | builds each entry (`background`/`options`/`popup`/`extract`) as a **self-contained IIFE** (no ES modules / shared chunks) so the same bundle runs as a Chrome service worker AND a Safari background page |

Shared, browser-agnostic logic (socket, snapshot mappers, status presenter,
options storage) lives in `packages/extension-core`.

## Protocol version & staleness

The connector's `hello` carries `extVersion` (build string) and
`protocolVersion` — the wire revision it speaks, single-sourced as
`WIRE_PROTOCOL_VERSION` in `@george43g/shared-types`. The daemon compares that
against its own: when the extension is **older**, it logs a loud `ext_stale`
warning, `browser-tab doctor` prints a `⚠ <browser> extension is stale …` line,
and `daemon_status` reports `stale: true` for that browser. A stale build that
reports no `capabilities` is given a **conservative all-false map** so consumers
gracefully refuse v2 ops (with a hint) instead of hitting a raw "unknown command
kind" error — and journaling/enrichments degrade visibly rather than silently.

**A rebuilt extension is not a reloaded one:** after `pnpm --filter
@george43g/chrome-extension build`, reload it in `chrome://extensions` (Chrome)
or `sideload` + toggle in Settings (Safari). Until you do, the daemon keeps
seeing the old baked-in `protocolVersion` and flags it stale.

## Versioning

`public/manifest.json` `version` is the **only user-facing version** of this
extension — Chrome and Safari both show it in the extensions list (Safari reads
it for Settings › Extensions; the container app's `MARKETING_VERSION` is a
different field and is stamped from this one).

**It is not bumped by hand.** The manifest and this `package.json` are both
release-please `extra-files` (`release-please-config.json`), so a release
rewrites them in the same commit as the root version — one repo, one number.
There used to be a `run bump` command here; it was deleted, because a version
you have to remember to move is a version that stops moving. This one did: the
extension sat at `0.2.0` across seven releases while the tool reached `1.1.1`,
and Safari faithfully displayed the stale number the whole time.

Two tests hold it there:

- `tests/build-output.test.ts` — the BUILT `dist/manifest.json` matches
  `package.json`, and is legal for Chrome (1–4 integer parts, ≤ 65535, no
  `-rc` suffix — Chrome refuses to load an extension whose version is a
  prerelease, so a prerelease cut would be a broken artifact, not a cosmetic
  problem).
- `apps/browser-tab-mcp/tests/release-versions.contract.test.ts` — every
  version-carrying file in the repo is one release-please rewrites, and all of
  them already hold the released version. This is the one that would have gone
  red at `0.2.0`.

A released file is still not a reloaded extension: **rebuild + reload** after a
version moves (see above).

This is deliberately separate from the wire `protocolVersion` (single-sourced as
`WIRE_PROTOCOL_VERSION` in `@george43g/shared-types` — bump it when the
daemon↔extension contract gains capabilities/commands, which is what the
staleness check keys on) and from the build stamp
(`<semver>+<count>.<sha>`, `scripts/build-stamp.mjs`), which answers *which
build* rather than *which release*.

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

Run `pnpm --filter @george43g/chrome-extension test` (turbo builds `dist/`
first, since the build-output guards read it). This app now has:

- `tests/messaging.test.ts` — the cross-browser reply regression: the
  `onMessage` listener must RETURN a promise under `globalThis.browser`
  (Safari/Firefox) and call `sendResponse` + `return true` under Chrome. Drives
  both branches via `vi.resetModules()` (the namespace check is import-frozen).
- `tests/build-output.test.ts` — static guards on the built `dist/`: MV3, BOTH
  `background.service_worker` and `background.scripts`, no
  `background.type:"module"`, IIFE-not-ESM entry JS, no `type="module"` script
  tags, and every referenced asset present on disk.

DOM-touching tests opt into a DOM with `// @vitest-environment happy-dom` at
the top of the file (the default env is node). Shared fixtures + the
`installFakeChrome` fake come from `@george43g/test-kit`. The end-to-end
`DaemonSocket`↔`ExtensionServer` path is covered by
`apps/browser-tab-mcp/tests/ext-socket.integration.test.ts`. Coverage gating is
tracked in **`docs/FOLLOWUPS.md § 1`**.

### E2E (`pnpm --filter @george43g/chrome-extension test:e2e`)

Playwright (`e2e/*.e2e.test.ts`, its own runner — excluded from the vitest unit
run) loads the **built `dist/`** into a real (new-headless) Chromium — the full
chromium build supports MV3 extensions, the headless shell does not — and drives
the full round-trip against a throwaway, `BROWSER_TAB_STATE_DIR`/`_CACHE_DIR`-
isolated daemon (fake AppleScript adapter, so the only real browser in the loop
is Playwright's): load → seed the options config → the background connects over
loopback (`dataSource:"extension"`, `x`-handles) → a daemon-driven cross-window
`move` preserves the page's scroll (the `chrome.tabs.move` win vs close+reopen).
Requires `pnpm build` first (the harness spawns `dist/cli.js`). Runs as its own
CI job (`e2e-chromium`); Safari stays manual-smoke only.
