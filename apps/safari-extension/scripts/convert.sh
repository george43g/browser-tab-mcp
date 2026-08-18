#!/usr/bin/env bash
# Generate (or regenerate) the Safari Web Extension Xcode project from the
# built Chrome extension bundle. Requires FULL Xcode (not just Command
# Line Tools): the converter ships inside Xcode.app.
#
# Regenerate only when the extension manifest changes; day-to-day JS
# changes only need `pnpm --filter @george43g/chrome-extension build`
# followed by an Xcode rebuild (the project references the dist output
# copied into it at conversion time — see README.md).
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
APP_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
DIST="$APP_DIR/../chrome-extension/dist"

if ! xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
  echo "error: safari-web-extension-converter not found." >&2
  echo "Install full Xcode from the App Store, then run:" >&2
  echo "  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" >&2
  exit 1
fi

if [[ ! -f "$DIST/manifest.json" ]]; then
  echo "error: build the extension first: pnpm --filter @george43g/chrome-extension build" >&2
  exit 1
fi

# Clean regenerate. The converter REFERENCES the web bundle in place
# (pbxproj fileRefs point at ../../chrome-extension/dist/*), it does not copy
# it — so the Extension's on-disk Resources dir looks empty, which is normal.
# But when the file SET changes (adding popup.html/ui.css/icons/…), `--force`
# over an existing project can leave stale/missing references. Wiping the
# project dir guarantees a pbxproj that references exactly the current dist.
# Signing (DEVELOPMENT_TEAM) is overwritten by the converter regardless.
rm -rf "$APP_DIR/xcode"

xcrun safari-web-extension-converter "$DIST" \
  --project-location "$APP_DIR/xcode" \
  --app-name "Browser Tab Helper" \
  --bundle-identifier com.george43g.browser-tab-helper \
  --macos-only \
  --swift \
  --no-open \
  --force

# Stamp the container app with the connector's version.
#
# The converter hardcodes MARKETING_VERSION = 1.0 and never looks at the
# manifest, so without this the Helper app's "About" box and every build
# artifact claim 1.0 forever while the extension itself moves. The manifest
# version is release-please-owned (release-please-config.json `extra-files`),
# so stamping FROM it keeps the whole Safari side on the one release line
# rather than inventing a second version to maintain by hand.
#
# rebuild.sh passes the same value on the xcodebuild command line, so a version
# bump does NOT require a re-convert — this exists so that an Xcode ⌘R build,
# which reads only the project, agrees with what the CLI produces.
VERSION="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version" "$DIST/manifest.json")"
PBXPROJ="$APP_DIR/xcode/Browser Tab Helper/Browser Tab Helper.xcodeproj/project.pbxproj"
sed -i '' -E "s/(MARKETING_VERSION = )[^;]*;/\1$VERSION;/g" "$PBXPROJ"
echo "Stamped MARKETING_VERSION = $VERSION into the generated project."

echo
echo "Xcode project generated at $APP_DIR/xcode/."
echo "Next: open it in Xcode, set Signing to your personal team for BOTH"
echo "targets, build & run once, then enable the extension in Safari"
echo "Settings > Extensions. See README.md."
