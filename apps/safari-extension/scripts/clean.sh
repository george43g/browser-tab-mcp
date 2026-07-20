#!/usr/bin/env bash
# Prune Safari Web Extension registrations for the browser-tab connector.
#
# Safari registers ONE web extension per *containing-app bundle*. If two app
# builds exist on disk (e.g. an Xcode ⌘R build in the default DerivedData and
# a script build in a different location), Safari lists the extension TWICE
# and toggling gets glitchy. This removes registrations whose .appex no longer
# exists (default), or ALL browser-tab-helper registrations (`--all`, a hard
# reset before a clean rebuild).
#
#   ./scripts/clean.sh          # prune stale (missing-path) registrations
#   ./scripts/clean.sh --all    # unregister every browser-tab-helper copy
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
APP_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
MODE="${1:-stale}"
MATCH="browser-tab-helper" # lowercase bundle id — only matches identifier lines

# Remove the stray dedicated build dir older rebuild.sh versions used (that
# second location was the source of the duplicate registration).
rm -rf "$APP_DIR/.xcode-derived"

if ! command -v pluginkit >/dev/null 2>&1; then
  echo "pluginkit unavailable; nothing to prune."
  exit 0
fi

# Each registration prints an identifier line (contains the lowercase bundle
# id) followed by a `Path = <…>.appex` line. (No `mapfile`: macOS ships bash 3.2.)
PATHS=()
while IFS= read -r p; do
  [[ -n "$p" ]] && PATHS+=("$p")
done < <(pluginkit -mAvvv 2>/dev/null | awk -v m="$MATCH" '
  index($0, m) { hit = 1; next }
  hit && /Path = / { line = $0; sub(/^[[:space:]]*Path = /, "", line); print line; hit = 0 }
')

if [[ ${#PATHS[@]} -eq 0 ]]; then
  echo "no browser-tab-helper registrations found."
  exit 0
fi

echo "found ${#PATHS[@]} registration(s):"
removed=0
for p in "${PATHS[@]}"; do
  [[ -z "$p" ]] && continue
  if [[ "$MODE" == "--all" ]]; then
    echo "  unregister (--all): $p"
    pluginkit -r "$p" 2>/dev/null || true
    removed=$((removed + 1))
  elif [[ ! -e "$p" ]]; then
    echo "  unregister (stale): $p"
    pluginkit -r "$p" 2>/dev/null || true
    removed=$((removed + 1))
  else
    echo "  keep (live):        $p"
  fi
done

echo "pruned $removed registration(s)."
if [[ $removed -gt 0 ]]; then
  echo "If Safari still shows a duplicate, quit and reopen Safari so it rescans."
fi
