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

xcrun safari-web-extension-converter "$DIST" \
  --project-location "$APP_DIR/xcode" \
  --app-name "Browser Tab Helper" \
  --bundle-identifier com.george43g.browser-tab-helper \
  --macos-only \
  --swift \
  --no-open \
  --force

echo
echo "Xcode project generated at $APP_DIR/xcode/."
echo "Next: open it in Xcode, set Signing to your personal team for BOTH"
echo "targets, build & run once, then enable the extension in Safari"
echo "Settings > Extensions. See README.md."
