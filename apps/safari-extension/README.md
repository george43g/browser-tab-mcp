# Safari Web Extension (browser-tab connector)

Safari packaging for the shared connector extension (`packages/extension-core`
+ `apps/chrome-extension`). Safari Web Extensions must ship inside a signed
containing app — this directory holds the converter script and the generated
Xcode project.

Safari detection and `allowReload` moves already work daemon-side via
AppleScript; the extension upgrades Safari to push events + true
state-preserving moves.

## Safari compatibility notes (learned the hard way)

- **No module service worker.** Safari's web-extension runtime does not
  support `background.type: "module"` (the converter warns on it) and loads
  the background as a *classic* script — which cannot use ES `import`. The
  build therefore emits each entry as a **self-contained IIFE** (no shared
  chunks, no module syntax); the manifest declares `background.service_worker`
  with no `type`. This was why the Safari extension connected to *nothing*
  before: the background never loaded.
- **Resources are referenced, not copied.** `convert.sh` generates a project
  whose pbxproj fileRefs point at `../../chrome-extension/dist/*`. The
  Extension target's on-disk `Resources/` dir looks empty — that's normal.
  It also means JS-only changes need only `pnpm --filter
  @george43g/chrome-extension build` + an Xcode rebuild (no re-convert).
- **Observability.** The background logs every state change as
  `[browser-tab] …` — read it in **Develop → Web Extension Backgrounds →
  Browser Tab Helper** (Console tab). The toolbar **popup** and the settings
  page also show live connection status, the last error, and window/tab
  counts, so a failure is visible instead of silent.

## The container app is a status window, not a launcher

The converter's stock app showed one sentence and one unconditional
**Quit and Open Safari Settings…** button — a control that is wrong in every
state except one. It now resolves a real status and shows the control that
matches:

| State | What it says | Control |
|---|---|---|
| extension off in Safari | "…currently off. You can turn it on in the Extensions section of Safari Settings." | **Quit and Open Safari Settings…** — the ONLY state that shows it |
| enabled, daemon reachable, live build == bundled | "Browser Tab Helper's extension is on and connected." | Check Again |
| enabled, daemon reachable, live build != bundled | "Safari is running a different build of the extension than this app ships." + both stamps | Check Again |
| enabled, daemon reachable, no Safari feed | "…but Safari's extension hasn't connected to it." | Check Again |
| enabled, daemon unreachable | "…the browser-tab daemon isn't reachable" + the connect error | Check Again |
| Safari didn't answer | "Safari did not report whether the extension is on." + the error | Check Again |

**"Check Again" re-runs the check and re-renders. It does not redeploy
anything, and it is labelled for what it does.** Nothing the app can call
makes Safari reload an `.appex` — only `xcodebuild` does that (and
`browser-tab reload-extension --browser safari` is a Chrome facility Safari
accepts and ignores). The window also re-checks when the app becomes active,
and after a non-terminal result it re-checks at 3s / 8s / 20s, because Safari
usually adopts a rebuilt bundle within ~15s of a `sideload`.

**Where the two versions come from.** *Bundled* is the build stamp baked into
`Contents/PlugIns/*.appex/Contents/Resources/background.js` by
`scripts/build-stamp.mjs` — read out of the app's own bundle. *Running in
Safari* is `extensionInfo[browser=safari].extVersion` from the daemon, which
is the same string the extension reported in its `hello`. They are the same
kind of value, so comparing them is exact — the manifest's bare semver cannot
tell two builds of one release apart, which is how a stale bundle keeps
reporting a plausible version (backlog **B34**).

### The sources are tracked; `xcode/` is not

`xcode/` is gitignored and regenerated wholesale by `convert.sh`, so anything
edited in there is a local change that dies at the next convert. The real
sources live in **`app-ui/`**:

```
app-ui/ViewController.swift              # status resolution + the daemon IPC client
app-ui/Resources/Base.lproj/Main.html    # the window
app-ui/Resources/Script.js               # every string, one entry per state
app-ui/Resources/Style.css               # close to Apple's template, plus the version table
```

`scripts/overlay-app-ui.sh` copies them into the generated project. It runs in
**both** `convert.sh` (after generation) and `rebuild.sh` (before
`xcodebuild`), so a code-only `sideload` picks up an `app-ui/` edit with no
re-convert. It is **idempotent by construction**: every step is a whole-file
copy or a build-setting *set*, never an append or a patch, so running it twice
leaves exactly one copy of the UI.

All the Swift lives in `ViewController.swift` on purpose — adding a new `.swift`
file would mean editing `project.pbxproj` (a build file, a file reference, a
group child and a sources-phase entry), which is exactly the fragile
appended-twice patching the overlay exists to avoid.

### App Sandbox — a deliberate, named security change

**The container app is built with `ENABLE_APP_SANDBOX = NO`. The extension
(`.appex`) keeps the sandbox.** `scripts/set-app-sandbox.mjs` scopes the change
by `PRODUCT_BUNDLE_IDENTIFIER`, because the setting appears in four build
configurations and flipping the appex's would break the extension.

Why: the live extension version is only available over the daemon's unix
socket at `~/.browser-tab/daemon.sock`, and a sandboxed app cannot reach it.
Measured 2026-09-07 on macOS 15.7.7, building the same UI both ways —

- `BT_APP_SANDBOX=YES` → the window renders
  `connect(/Users/…/.browser-tab/daemon.sock): Operation not permitted`
- `BT_APP_SANDBOX=NO` → the window renders the live and bundled stamps

The app already carried `com.apple.security.network.client`, which does not
cover a unix-domain `connect()`, and no public temporary-exception entitlement
does either (the file exceptions grant `open`, not `connect`).

This is a real reduction in the app's confinement, and it is only defensible
because this is a locally-signed personal dev build that is never distributed:
App Store submission would require the sandbox back. Set `BT_APP_SANDBOX=YES`
to restore Apple's default — the app still builds and runs, it just degrades to
the "daemon isn't reachable" state, which the UI handles rather than crashing.

The container app reads the real home via `getpwuid`, not `NSHomeDirectory()`,
so the socket path is correct in a sandboxed build too — the reading that is
right in both worlds rather than the one that happens to work today.

## One-time setup

1. Install full Xcode (App Store) and point the tools at it:

   ```bash
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   sudo xcodebuild -license accept
   ```

2. Build the web extension bundle and convert it:

   ```bash
   pnpm --filter @george43g/chrome-extension build
   ./scripts/convert.sh
   ```

3. Open `xcode/Browser Tab Helper/Browser Tab Helper.xcodeproj`, select your
   personal team under **Signing & Capabilities** for BOTH targets (app +
   extension). A paid Apple Developer account gives non-expiring local
   builds; a free account re-signs every 7 days.

4. Build & run the app once (⌘R). It registers the extension with Safari.

5. Safari **Settings → Extensions → browser-tab connector** → enable. Open the
   extension's settings, paste the token from `browser-tab daemon token`, set
   the browser to `safari`, and click **test connection** — the status dot
   should go green (`connected`). Clicking the toolbar icon shows the same
   live readout.

If Safari refuses the extension, toggle **Develop → Allow Unsigned
Extensions** (Develop menu must be enabled) — needed only for unsigned/ad-hoc
builds, and it resets when Safari quits. Properly signed builds persist.

## Iterating on code changes (fast loop)

For pure **code** edits (no files added/removed, no manifest structure change)
you do NOT need `convert.sh` — the project references `dist/` in place. One
command prunes stale registrations, rebuilds the bundle, compiles the app, and
launches it to re-register:

```bash
pnpm --filter @george43g/safari-extension sideload
#   override signing team if needed:
#   DEVELOPMENT_TEAM=XXXXXXXXXX pnpm --filter @george43g/safari-extension sideload
```

> The script is named **`sideload`**, not `rebuild`, on purpose: `rebuild` is a
> built-in pnpm command, so `pnpm --filter … rebuild` runs *that* instead of the
> script and silently does nothing.

It runs `clean.sh` (prune) → `pnpm --filter @george43g/chrome-extension build`
→ the `app-ui/` overlay → `xcodebuild clean build` (Debug, **default
DerivedData**) → `open`s the built app. Re-run `convert.sh` only when the file
set or manifest structure changes — it regenerates (and unsigns) the project.

**Cost and focus.** Five runs on 2026-09-07 measured **10.3–13.3s wall** each
(`/usr/bin/time -p`), and every one is effectively cold because `rebuild.sh`
does `xcodebuild clean build`. The final `open` **steals focus**; set
`BT_OPEN_BACKGROUND=1` to use `open -g` instead, which is what an automated
sideload should do.

**The launch is not what re-registers the extension.** Measured across three
runs: with `open` suppressed entirely and the container app not running,
Safari still adopted the rebuilt stamp in ~6s — the same as with plain `open`
and with `open -g`. `xcodebuild`'s own
`lsregister -f -R -trusted` step does the work. The launch is kept because a
first-ever install (or a run after `clean.sh --all`) does need the app to run
once, and because a human running `sideload` by hand wants to see the status
window.

**Duplicate extension in Safari?** That happens when two container-app builds
are registered (e.g. an Xcode ⌘R build *and* a script build in a different
DerivedData). `sideload` now builds into Xcode's default DerivedData so both
converge on one app. To clean up existing duplicates:

```bash
pnpm --filter @george43g/safari-extension unregister   # prune stale (missing) copies
apps/safari-extension/scripts/clean.sh --all           # hard reset: unregister ALL copies
```

Full reset if Safari still shows two: quit Safari, run `clean.sh --all`, delete
any built `Browser Tab Helper.app` under `~/Library/Developer/Xcode/DerivedData/`,
`sideload` once, reopen Safari.

The first-time team signing, "Allow Unsigned Extensions", and enabling the
extension are Apple GUI-only and stay manual.

## Distribution note

Public distribution of Safari Web Extensions is App Store-only; notarized
Developer ID apps outside the store still count as "unsigned" to Safari.
For this personal tool, local Xcode signing is the intended path.

## Known risk: background page lifetime

Safari's background page lifecycle with long-lived WebSockets is less proven
than Chrome's (Chrome ≥116 keeps the service worker alive on socket traffic).
Validate after first install: leave Safari idle 30 minutes, then confirm
`browser-tab daemon status` still shows `safari` under `extensions`, or that
it reconnects on the next tab event. If the background page dies for good,
Safari stays on the AppleScript pathway automatically — nothing breaks; you
just lose push events and true moves.

## Regenerating

Re-run `./scripts/convert.sh` only when `public/manifest.json` changes
(`--force` overwrites the project; re-apply signing settings afterwards).
JS-only changes: `sideload` is enough — the project references `dist/` in
place, and the `app-ui/` overlay re-applies on every run.

A re-convert also re-applies the overlay, so the container app UI survives a
regeneration; what does NOT survive is the signing team, which is a manual
Xcode step (or `DEVELOPMENT_TEAM=… pnpm --filter @george43g/safari-extension
sideload`).
