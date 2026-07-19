# Safari Web Extension (browser-tab connector)

Safari packaging for the shared connector extension (`packages/extension-core`
+ `apps/chrome-extension`). Safari Web Extensions must ship inside a signed
containing app — this directory holds the converter script and the generated
Xcode project.

**Status: prep-only until full Xcode is installed.** Safari detection and
`allowReload` moves already work daemon-side via AppleScript; the extension
upgrades Safari to push events + true state-preserving moves.

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

5. Safari **Settings → Extensions → browser-tab connector** → enable. On the
   extension's options page, paste the token from `browser-tab daemon token`
   and set the browser to `safari`.

If Safari refuses the extension, toggle **Develop → Allow Unsigned
Extensions** (Develop menu must be enabled) — needed only for unsigned/ad-hoc
builds, and it resets when Safari quits. Properly signed builds persist.

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
