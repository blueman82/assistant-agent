#!/bin/bash
# scripts/install.sh — one-package installer: takes a fresh-ish machine to
# fully-deployed Rachel.
#
#   ./scripts/install.sh            install + verify
#   ./scripts/install.sh --dry-run  print the full plan, change nothing
#
# What it does:
#   1. Preflight — repo path (resolved from this script's own location),
#      node_modules present (it does NOT run npm install for you — the
#      launchd jobs execute node_modules/.bin/tsx, so a missing install is
#      a loud stop, not something to paper over), Telegram credentials
#      configured (env vars or ~/.rachel/telegram.json — mirrors
#      gate/surfaces/telegram.ts loadTelegramConfig; NEVER written by this
#      script).
#   2. Stamps __REPO_PATH__ out of the four launchd templates and installs
#      them to ~/Library/LaunchAgents under each template's own Label.
#      Bootstraps ~/.rachel/proactive/config.json with the documented
#      defaults (proactive/push.ts DEFAULT_CONFIG) if — and only if — it
#      does not already exist.
#   3. launchctl bootout-then-bootstrap for each service. bootout exit 3
#      ("No such process") is tolerated: that is real launchd behaviour on
#      a machine where the service was never loaded, so the script is safe
#      to re-run.
#   4. Verifies the deployed surface: every service loaded, the bridge
#      running, and ~/.rachel/bridge-heartbeat.json refreshed within a
#      bounded wait (the loop below is the bound — no timeout/gtimeout
#      wrappers). Prints a PASS/FAIL summary naming any failing check and
#      exits nonzero on failure.
#
# Injection seams (for tests — leave unset for a real install):
#   INSTALL_HOME                 overrides $HOME for ~/.rachel and the
#                                default LaunchAgents dir
#   INSTALL_LAUNCH_AGENTS_DIR    overrides the plist install target dir
#   INSTALL_LAUNCHCTL            overrides the launchctl binary (default:
#                                launchctl from PATH)
#   INSTALL_HEARTBEAT_WAIT_SECS  overrides the heartbeat wait bound
#                                (default 120s — covers the bridge's 409
#                                backoff window after a restart)
set -u

START_EPOCH="$(date +%s)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

HOME_DIR="${INSTALL_HOME:-$HOME}"
LAUNCH_AGENTS_DIR="${INSTALL_LAUNCH_AGENTS_DIR:-$HOME_DIR/Library/LaunchAgents}"
LAUNCHCTL="${INSTALL_LAUNCHCTL:-launchctl}"
HEARTBEAT_WAIT_SECS="${INSTALL_HEARTBEAT_WAIT_SECS:-120}"
DOMAIN="gui/$(id -u)"
PROACTIVE_CFG="$HOME_DIR/.rachel/proactive/config.json"
HEARTBEAT_FILE="$HOME_DIR/.rachel/bridge-heartbeat.json"

# The four service templates. Labels are read from the templates themselves
# below, never assumed.
TEMPLATES=(
  bridge/launchd.plist
  tasks/inbox-brief-launchd.plist
  tasks/proactive-sweep-launchd.plist
  tasks/proactive-calendar-launchd.plist
)

DRY_RUN=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  "") ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# --- Preflight -------------------------------------------------------------

LABELS=()
for tpl in "${TEMPLATES[@]}"; do
  [ -f "$REPO_ROOT/$tpl" ] || die "template missing: $REPO_ROOT/$tpl"
  label="$(/usr/bin/plutil -extract Label raw -o - "$REPO_ROOT/$tpl" 2>/dev/null)" \
    || die "cannot read Label from $tpl"
  [ -n "$label" ] || die "empty Label in $tpl"
  LABELS+=("$label")
done
BRIDGE_LABEL="${LABELS[0]}"

[ -x "$REPO_ROOT/node_modules/.bin/tsx" ] \
  || die "node_modules is missing or incomplete at $REPO_ROOT/node_modules — run 'npm install' in $REPO_ROOT first (the launchd jobs execute node_modules/.bin/tsx), then re-run this installer."

# Telegram credentials: env pair first, else ~/.rachel/telegram.json with
# non-empty token + chatId (mirrors loadTelegramConfig). Never written here.
TELEGRAM_ROUTE=""
if [ -n "${RACHEL_TELEGRAM_TOKEN:-}" ] && [ -n "${RACHEL_TELEGRAM_CHAT_ID:-}" ]; then
  TELEGRAM_ROUTE="env (RACHEL_TELEGRAM_TOKEN + RACHEL_TELEGRAM_CHAT_ID)"
else
  tj="$HOME_DIR/.rachel/telegram.json"
  if [ -f "$tj" ] \
    && grep -Eq '"token"[[:space:]]*:[[:space:]]*"[^"]+"' "$tj" \
    && grep -Eq '"chatId"[[:space:]]*:[[:space:]]*"[^"]+"' "$tj"; then
    TELEGRAM_ROUTE="file ($tj)"
  fi
fi
if [ -z "$TELEGRAM_ROUTE" ]; then
  cat >&2 <<EOF
FAIL: Telegram is not configured, and this installer never writes credentials.
Configure ONE of these two routes, then re-run:
  1) Environment variables:
       export RACHEL_TELEGRAM_TOKEN='<bot token>'
       export RACHEL_TELEGRAM_CHAT_ID='<chat id>'
  2) Config file — create $HOME_DIR/.rachel/telegram.json containing:
       {"token": "<bot token>", "chatId": "<chat id>"}
EOF
  exit 1
fi

echo "Rachel installer"
echo "  repo:          $REPO_ROOT"
echo "  LaunchAgents:  $LAUNCH_AGENTS_DIR"
echo "  launchctl:     $LAUNCHCTL ($DOMAIN)"
echo "  telegram:      configured via $TELEGRAM_ROUTE"
if [ "$DRY_RUN" -eq 1 ]; then
  echo ""
  echo "DRY RUN — printing the full plan; nothing will be written and launchctl will not be called."
fi

# --- Files: stamped plists + proactive config ------------------------------

echo ""
echo "== Files =="
i=0
for tpl in "${TEMPLATES[@]}"; do
  label="${LABELS[$i]}"; i=$((i + 1))
  target="$LAUNCH_AGENTS_DIR/$label.plist"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would write    $target  (stamp __REPO_PATH__ -> $REPO_ROOT in $tpl)"
    continue
  fi
  mkdir -p "$LAUNCH_AGENTS_DIR"
  content="$(cat "$REPO_ROOT/$tpl")"
  printf '%s\n' "${content//__REPO_PATH__/$REPO_ROOT}" > "$target" \
    || die "could not write $target"
  echo "wrote          $target"
done

if [ -f "$PROACTIVE_CFG" ]; then
  echo "kept           $PROACTIVE_CFG  (exists — never overwritten)"
elif [ "$DRY_RUN" -eq 1 ]; then
  echo "would write    $PROACTIVE_CFG  (proactive defaults: Europe/Dublin, quiet 22:30-08:00, budget 10)"
else
  mkdir -p "$(dirname "$PROACTIVE_CFG")" || die "could not create $(dirname "$PROACTIVE_CFG")"
  # Verbatim mirror of proactive/push.ts DEFAULT_CONFIG.
  cat > "$PROACTIVE_CFG" <<'EOF'
{
  "schema_version": 1,
  "timezone": "Europe/Dublin",
  "quiet_hours": { "start": "22:30", "end": "08:00" },
  "daily_budget": 10,
  "pr_watch_repos": [],
  "calendar_oneshot_hours": [8, 11, 14, 17]
}
EOF
  echo "wrote          $PROACTIVE_CFG  (proactive defaults)"
fi

# --- Services: bootout-then-bootstrap each ---------------------------------

echo ""
echo "== Services =="
i=0
for tpl in "${TEMPLATES[@]}"; do
  label="${LABELS[$i]}"; i=$((i + 1))
  target="$LAUNCH_AGENTS_DIR/$label.plist"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would run      $LAUNCHCTL bootout $DOMAIN/$label  (exit 3 tolerated when not loaded)"
    echo "would run      $LAUNCHCTL bootstrap $DOMAIN $target"
    continue
  fi
  "$LAUNCHCTL" bootout "$DOMAIN/$label" >/dev/null 2>&1
  rc=$?
  case "$rc" in
    0) echo "booted out     $label  (was loaded)" ;;
    3) echo "not loaded     $label  (fresh install — nothing to boot out)" ;;
    *) die "launchctl bootout $DOMAIN/$label failed with exit $rc" ;;
  esac
  "$LAUNCHCTL" bootstrap "$DOMAIN" "$target" \
    || die "launchctl bootstrap $DOMAIN $target failed for $label"
  echo "bootstrapped   $label"
done

# --- Verification ----------------------------------------------------------

echo ""
echo "== Verification =="
if [ "$DRY_RUN" -eq 1 ]; then
  for label in "${LABELS[@]}"; do
    echo "would verify   service loaded: $label  ($LAUNCHCTL print $DOMAIN/$label)"
  done
  echo "would verify   bridge running: $BRIDGE_LABEL  (state = running)"
  echo "would verify   heartbeat fresh: $HEARTBEAT_FILE  (within ${HEARTBEAT_WAIT_SECS}s)"
  echo ""
  echo "DRY RUN complete — no changes were made."
  exit 0
fi

FAILED=0
FAIL_LIST=""
pass() { echo "PASS  $*"; }
fail() {
  echo "FAIL  $*"
  FAIL_LIST="$FAIL_LIST
  - $*"
  FAILED=$((FAILED + 1))
}

for label in "${LABELS[@]}"; do
  if "$LAUNCHCTL" print "$DOMAIN/$label" >/dev/null 2>&1; then
    pass "service loaded: $label"
  else
    fail "service not loaded: $label"
  fi
done

if "$LAUNCHCTL" print "$DOMAIN/$BRIDGE_LABEL" 2>/dev/null | grep -q "state = running"; then
  pass "bridge running: $BRIDGE_LABEL"
else
  fail "bridge not running: $BRIDGE_LABEL"
fi

# Bounded heartbeat wait — the loop itself is the bound (no timeout/gtimeout
# wrappers). Fresh = mtime at or after this run started (5s clock slack), so
# a stale file from a dead bridge does not pass.
wait_start="$(date +%s)"
deadline=$((wait_start + HEARTBEAT_WAIT_SECS))
hb_ok=0
while :; do
  if [ -f "$HEARTBEAT_FILE" ]; then
    mtime="$(stat -f %m "$HEARTBEAT_FILE" 2>/dev/null || echo 0)"
    if [ "$mtime" -ge $((START_EPOCH - 5)) ]; then hb_ok=1; break; fi
  fi
  now="$(date +%s)"
  [ "$now" -ge "$deadline" ] && break
  sleep 2
done
if [ "$hb_ok" -eq 1 ]; then
  pass "heartbeat fresh: $HEARTBEAT_FILE  (after $(( $(date +%s) - wait_start ))s)"
else
  fail "heartbeat missing or stale after ${HEARTBEAT_WAIT_SECS}s: $HEARTBEAT_FILE  (is the bridge polling?)"
fi

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "PASS: all verification checks passed — Rachel is fully deployed."
  exit 0
fi
echo "FAIL: $FAILED verification check(s) failed:$FAIL_LIST"
exit 1
