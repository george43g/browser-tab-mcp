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
→ `xcodebuild clean build` (Debug, **default DerivedData**) → `open`s the built
app. Then the only manual step is Safari **Settings → Extensions**: toggle the
extension **off then on** (Safari won't load a rebuilt `.appex` otherwise).
Re-run `convert.sh` only when the file set or manifest structure changes — it
regenerates (and unsigns) the project.

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
JS-only changes: rebuild the chrome-extension bundle, then re-run the
converter or copy `dist/` over the project's `Resources` copy and rebuild in
Xcode.
