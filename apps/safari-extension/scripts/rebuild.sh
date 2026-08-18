#!/usr/bin/env bash
# Fast Safari iteration loop for CODE changes (no manifest/file-set change):
#   prune stale registrations -> rebuild the web bundle -> xcodebuild the
#   container app -> open it so it re-registers the extension with Safari.
#
# Builds into Xcode's DEFAULT DerivedData (no -derivedDataPath) so this script
# and an Xcode ⌘R converge on ONE app bundle — otherwise you get two apps
# registered and Safari lists the extension twice. clean.sh (run first) prunes
# any stale registrations left over from earlier dual-location builds.
#
# You still do the Apple GUI-only bits by hand:
#   - first-time team/provisioning signing (set once in Xcode; persists until
#     the next convert.sh)
#   - "Develop > Allow Unsigned Extensions" (Debug builds; resets on quit)
#   - enabling / toggling the extension in Safari > Settings > Extensions
#
# Use convert.sh instead when the file SET changes (files added/removed) or the
# manifest structure changes — the project references dist/ in place, so
# code-only edits need only this script.
#
# Optional: DEVELOPMENT_TEAM=XXXXXXXXXX ...  (overrides the team baked into the
# project by Xcode).
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
APP_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
REPO_ROOT="$(cd -- "$APP_DIR/../.." && pwd -P)"
PROJECT="$APP_DIR/xcode/Browser Tab Helper/Browser Tab Helper.xcodeproj"
SCHEME="Browser Tab Helper"

command -v xcodebuild >/dev/null 2>&1 || {
  echo "error: xcodebuild not found — install full Xcode." >&2
  exit 1
}
if [[ ! -d "$PROJECT" ]]; then
  echo "error: no Xcode project at $PROJECT — run ./scripts/convert.sh first." >&2
  exit 1
fi

echo "==> [1/4] pruning stale extension registrations"
bash "$SCRIPT_DIR/clean.sh"

echo "==> [2/4] building web bundle (dist/ is referenced in place by the project)"
(cd "$REPO_ROOT" && pnpm --filter @george43g/chrome-extension build)

echo "==> [3/4] xcodebuild clean build (Debug, default DerivedData)"
# Clean first: because resources are referenced in place, Xcode's cache can
# otherwise bundle a stale copy of dist/. No -derivedDataPath, so this shares
# a location with Xcode's ⌘R builds → a single registered app.
#
# The version comes from the JUST-BUILT manifest, which is the file Safari
# itself reads for the version shown in Settings > Extensions — so the container
# app and the extension can never disagree about which release this is.
# Overriding on the command line (rather than relying on the project) means a
# release bump needs only a rebuild, never a re-convert. The build number is the
# same commit count the build stamp uses (scripts/build-stamp.mjs), so the app's
# version and the extension's stamp point at one commit.
EXT_VERSION="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version" \
  "$REPO_ROOT/apps/chrome-extension/dist/manifest.json")"
BUILD_NUMBER="$(git -C "$REPO_ROOT" rev-list --count HEAD 2>/dev/null || echo 1)"
echo "    version: $EXT_VERSION (build $BUILD_NUMBER)"
XCARGS=(
  -project "$PROJECT"
  -scheme "$SCHEME"
  -configuration Debug
  -allowProvisioningUpdates
  "MARKETING_VERSION=$EXT_VERSION"
  "CURRENT_PROJECT_VERSION=$BUILD_NUMBER"
)
[[ -n "${DEVELOPMENT_TEAM:-}" ]] && XCARGS+=("DEVELOPMENT_TEAM=$DEVELOPMENT_TEAM")
xcodebuild "${XCARGS[@]}" clean build

echo "==> [4/4] locating and launching the built app"
PRODUCTS_DIR="$(xcodebuild "${XCARGS[@]}" -showBuildSettings 2>/dev/null \
  | awk -F' = ' '/ BUILT_PRODUCTS_DIR = /{print $2; exit}')"
APP=""
[[ -n "$PRODUCTS_DIR" ]] && APP="$(find "$PRODUCTS_DIR" -maxdepth 1 -name '*.app' -print -quit 2>/dev/null || true)"
if [[ -z "$APP" ]]; then
  echo "error: build succeeded but no .app found (BUILT_PRODUCTS_DIR='$PRODUCTS_DIR')." >&2
  exit 1
fi

echo "    app: $APP"
open "$APP"

cat <<'EOF'

Done. Finish in Safari (GUI-only):
  1. Settings > Extensions: toggle "Browser Tab Helper Extension" OFF then ON
     (Safari won't load a rebuilt .appex until you do — or quit+reopen Safari).
  2. Click the toolbar icon: the status dot should read "connected".
If it doesn't, open Develop > Web Extension Backgrounds > Browser Tab Helper
and read the [browser-tab] console for the actual error.
EOF
