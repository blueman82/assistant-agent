#!/bin/bash
# Launches the Telegram runtime (src/telegram/main.ts) with credentials loaded
# from ~/.rachel/telegram.json rather than embedded in the launchd plist, so
# the token/chat ID never sit in plaintext inside a commonly-readable
# ~/Library/LaunchAgents/*.plist. Intended to be invoked by
# scripts/deploy/com.rachel.telegram.plist; can also be run manually for a
# foreground check.
set -euo pipefail

# launchd jobs get no user PATH by default; node lives here (verified via
# `command -v node` -> /opt/homebrew/bin/node on this machine). Must be set
# before the first `node -e` call below, not just before the final exec.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

REPO_DIR="/Users/harrison/Github/assistant-agent"
CREDENTIALS_FILE="$HOME/.rachel/telegram.json"

if [ ! -f "$CREDENTIALS_FILE" ]; then
  echo "run-telegram.sh: credentials file not found at $CREDENTIALS_FILE" >&2
  exit 1
fi

TOKEN=$(node -e '
  const fs = require("fs");
  const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(typeof data.token === "string" ? data.token : "");
' "$CREDENTIALS_FILE")

CHAT_ID=$(node -e '
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
exec node_modules/.bin/tsx src/telegram/main.ts
