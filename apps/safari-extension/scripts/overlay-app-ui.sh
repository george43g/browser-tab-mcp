#!/usr/bin/env bash
# Copy the TRACKED container-app UI over the GENERATED Xcode project.
#
# `xcode/` is gitignored and regenerated wholesale by convert.sh, so anything
# edited in there is a local change that dies at the next convert — it cannot
# be reviewed, cloned or built by anyone else. The real sources live in
# ../app-ui/ and this script is what puts them where Xcode looks.
#
# Run by BOTH convert.sh (after generation) and rebuild.sh (before
# xcodebuild), so a code-only `sideload` picks it up without a re-convert.
#
# IDEMPOTENT BY CONSTRUCTION: every step either copies a whole file over the
# top of whatever was there, or sets a build setting to a value. Nothing is
# appended, so running it twice — or twenty times — leaves exactly one copy
# of the UI in the project. That is the reason there is no `sed` patching
# here; the one build setting that must change is handled by
# set-app-sandbox.mjs, which sets rather than patches.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
APP_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
SRC="$APP_DIR/app-ui"
PROJECT_ROOT="$APP_DIR/xcode/Browser Tab Helper"
TARGET="$PROJECT_ROOT/Browser Tab Helper"
PBXPROJ="$PROJECT_ROOT/Browser Tab Helper.xcodeproj/project.pbxproj"

# Whether the CONTAINER APP keeps App Sandbox. Default NO — see README.md
# § "App Sandbox — a deliberate, named security change" for the measurement
# and the security note. `BT_APP_SANDBOX=YES` restores Apple's default (the status
# readout then degrades to "daemon isn't reachable", which is a real state
# the UI already handles rather than a crash).
APP_SANDBOX="${BT_APP_SANDBOX:-NO}"

if [[ ! -d "$PROJECT_ROOT" ]]; then
  echo "error: no generated project at $PROJECT_ROOT — run ./scripts/convert.sh first." >&2
  exit 1
fi

echo "==> overlaying tracked container-app UI from app-ui/"

# Whole-file replacement, never a patch. The generated project already has a
# file reference at each of these paths, so nothing in the pbxproj changes.
copy() {
  local rel="$1"
  if [[ ! -f "$SRC/$rel" ]]; then
    echo "error: missing overlay source $SRC/$rel" >&2
    exit 1
  fi
  mkdir -p "$(dirname -- "$TARGET/$rel")"
  # `command cp`: an interactive `cp -i` alias answers its own prompt "no" in
  # a shell with no tty and fails with exit 1 (see the repo's AGENTS.md).
  command cp -f "$SRC/$rel" "$TARGET/$rel"
  echo "    $rel"
}

copy "ViewController.swift"
copy "Resources/Base.lproj/Main.html"
copy "Resources/Script.js"
copy "Resources/Style.css"

node "$SCRIPT_DIR/set-app-sandbox.mjs" "$PBXPROJ" "$APP_SANDBOX"

echo "==> overlay applied"
