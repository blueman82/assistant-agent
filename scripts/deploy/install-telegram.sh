#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
HOME_DIR="${HOME:?HOME is required}"
NODE_BIN="${RACHEL_NODE_BIN:-$(command -v node || true)}"
TEMPLATE="$SCRIPT_DIR/com.rachel.telegram.plist"
TARGET="$HOME_DIR/Library/LaunchAgents/com.rachel.telegram.plist"

[ -x "$NODE_BIN" ] || { echo "node executable not found; set RACHEL_NODE_BIN" >&2; exit 1; }

escape_sed() { printf '%s' "$1" | sed 's/[\\&|]/\\&/g'; }
mkdir -p "$HOME_DIR/.rachel" "$(dirname -- "$TARGET")"
sed \
  -e "s|@RACHEL_REPO_DIR@|$(escape_sed "$REPO_DIR")|g" \
  -e "s|@RACHEL_NODE_BIN@|$(escape_sed "$NODE_BIN")|g" \
  -e "s|@RACHEL_HOME@|$(escape_sed "$HOME_DIR")|g" \
  "$TEMPLATE" > "$TARGET"
plutil -lint "$TARGET"
launchctl bootout "gui/$(id -u)/com.rachel.telegram" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$TARGET"
launchctl kickstart -k "gui/$(id -u)/com.rachel.telegram"
echo "Installed com.rachel.telegram from $REPO_DIR"
