#!/bin/bash
# Launches the Telegram runtime (src/telegram/main.ts) with credentials loaded
# from ~/.rachel/telegram.json rather than embedded in the launchd plist, so
# the token/chat ID never sit in plaintext inside a commonly-readable
# ~/Library/LaunchAgents/*.plist. Intended to be invoked by
# scripts/deploy/com.rachel.telegram.plist; can also be run manually for a
# foreground check.
set -euo pipefail

# launchd jobs get no user PATH by default. The installer supplies the runtime
# path; manual launches may use the caller's PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
NODE_BIN="${RACHEL_NODE_BIN:-$(command -v node || true)}"
CREDENTIALS_FILE="$HOME/.rachel/telegram.json"

[ -x "$NODE_BIN" ] || { echo "run-telegram.sh: node executable not found; set RACHEL_NODE_BIN" >&2; exit 1; }

if [ ! -f "$CREDENTIALS_FILE" ]; then
  echo "run-telegram.sh: credentials file not found at $CREDENTIALS_FILE" >&2
  exit 1
fi

TOKEN=$("$NODE_BIN" -e '
  const fs = require("fs");
  const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(typeof data.token === "string" ? data.token : "");
' "$CREDENTIALS_FILE")

CHAT_ID=$("$NODE_BIN" -e '
  const fs = require("fs");
  const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(typeof data.chatId === "string" ? data.chatId : "");
' "$CREDENTIALS_FILE")

if [ -z "$TOKEN" ]; then
  echo "run-telegram.sh: token field is missing or empty in $CREDENTIALS_FILE" >&2
  exit 1
fi

if [ -z "$CHAT_ID" ]; then
  echo "run-telegram.sh: chatId field is missing or empty in $CREDENTIALS_FILE" >&2
  exit 1
fi

export RACHEL_TELEGRAM_TOKEN="$TOKEN"
export RACHEL_TELEGRAM_CHAT_ID="$CHAT_ID"
export RACHEL_PROVIDER="${RACHEL_PROVIDER:-claude}"

cd "$REPO_DIR"
exec "$NODE_BIN" node_modules/.bin/tsx src/telegram/main.ts
