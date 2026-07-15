#!/bin/bash
# scripts/install.sh — one-package installer: takes a fresh-ish machine to
# fully-deployed Rachel.
#
#   ./scripts/install.sh            install + verify
#   ./scripts/install.sh --dry-run  print the full plan, change nothing
#
# What it does:
#   1. Preflight — repo path (resolved from this script's own location),
#      node + node_modules present (it does NOT run npm install for you —
#      the launchd jobs execute node_modules/.bin/tsx, so a missing install
#      is a loud stop, not something to paper over), Telegram credentials
#      configured (env vars or ~/.rachel/telegram.json — validated with the
#      exact truthy check of gate/surfaces/telegram.ts loadTelegramConfig;
#      NEVER written by this script). A real run stops before any side
#      effect; --dry-run prints the full plan first, then the problems.
#   2. Stamps __REPO_PATH__ out of the four launchd templates and installs
#      them to ~/Library/LaunchAgents under each template's own Label. Every
#      write is temp-file + rename, and every stamped plist must pass
#      plutil -lint (and carry no placeholder remnant) BEFORE the rename, so
#      an invalid file never lands in LaunchAgents. Bootstraps
#      ~/.rachel/proactive/config.json with the documented defaults
#      (proactive/push.ts DEFAULT_CONFIG) if — and only if — it does not
#      already exist.
#   3. launchctl bootout-then-bootstrap for each service. bootout exit 3
#      ("No such process") is tolerated: that is real launchd behaviour on
#      a machine where the service was never loaded, so the script is safe
#      to re-run. A bootout/bootstrap failure on one service is recorded
#      and the loop continues — all plists are already on disk by then, so
#      aborting mid-loop would leave unaccounted drift; the summary names
#      every casualty instead.
#   4. Verifies the deployed surface: every service loaded, the bridge
#      running, the proactive config parseable, and
#      ~/.rachel/bridge-heartbeat.json written AFTER the bridge's bootout
#      (the old bridge process is dead from that instant, so its final
#      heartbeat cannot satisfy the check) within a bounded wait (the loop
#      below is the bound — no timeout/gtimeout wrappers). Prints a
#      PASS/FAIL summary naming any failing check and exits nonzero on
#      failure.
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
if [ $# -gt 1 ]; then
  echo "usage: $0 [--dry-run]" >&2
  exit 2
fi
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  "") ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# --- Preflight -------------------------------------------------------------
# Structural problems (missing/unreadable templates) are fatal in both modes
# — without labels there is no plan to print. Environmental problems
# (node_modules, Telegram config) are collected: a real run stops on them
# before any side effect; --dry-run prints the plan first, then reports them.

LABELS=()
for tpl in "${TEMPLATES[@]}"; do
  [ -f "$REPO_ROOT/$tpl" ] || die "template missing: $REPO_ROOT/$tpl"
  if ! label="$(/usr/bin/plutil -extract Label raw -o - "$REPO_ROOT/$tpl" 2>&1)"; then
    die "cannot read Label from $tpl: $label"
  fi
  [ -n "$label" ] || die "empty Label in $tpl"
  LABELS+=("$label")
done
BRIDGE_LABEL="${LABELS[0]}"

PROBLEMS=""
add_problem() {
  PROBLEMS="${PROBLEMS}${1}
"
}

command -v node >/dev/null 2>&1 \
  || add_problem "node not found on PATH — install Node.js first (everything below runs through it)."

[ -x "$REPO_ROOT/node_modules/.bin/tsx" ] \
  || add_problem "node_modules is missing or incomplete at $REPO_ROOT/node_modules — run 'npm install' in $REPO_ROOT first (the launchd jobs execute node_modules/.bin/tsx)."

# Telegram credentials: env pair first, else ~/.rachel/telegram.json —
# validated with the exact truthy check of loadTelegramConfig (JSON.parse +
# `token && chatId`), so a numeric chatId passes and malformed JSON fails
# here instead of crash-looping the bridge later. Never written here.
tg_file_valid() {
  node -e '
    const fs = require("fs");
    try {
      const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.exit(c.token && c.chatId ? 0 : 1);
    } catch {
      process.exit(1);
    }
  ' "$1" 2>/dev/null
}

TELEGRAM_ROUTE=""
TELEGRAM_JSON="$HOME_DIR/.rachel/telegram.json"
if [ -n "${RACHEL_TELEGRAM_TOKEN:-}" ] && [ -n "${RACHEL_TELEGRAM_CHAT_ID:-}" ]; then
  TELEGRAM_ROUTE="env (RACHEL_TELEGRAM_TOKEN + RACHEL_TELEGRAM_CHAT_ID)"
elif command -v node >/dev/null 2>&1 && [ -f "$TELEGRAM_JSON" ] && tg_file_valid "$TELEGRAM_JSON"; then
  TELEGRAM_ROUTE="file ($TELEGRAM_JSON)"
fi
if [ -z "$TELEGRAM_ROUTE" ]; then
  tg_note=""
  [ -f "$TELEGRAM_JSON" ] && tg_note="
  Note: $TELEGRAM_JSON exists but failed validation (it must be valid JSON with non-empty token and chatId)."
  add_problem "Telegram is not configured, and this installer never writes credentials.
Configure ONE of these two routes, then re-run:
  1) Environment variables:
       export RACHEL_TELEGRAM_TOKEN='<bot token>'
       export RACHEL_TELEGRAM_CHAT_ID='<chat id>'
  2) Config file — create $TELEGRAM_JSON containing:
       {\"token\": \"<bot token>\", \"chatId\": \"<chat id>\"}$tg_note"
fi

if [ -n "$PROBLEMS" ] && [ "$DRY_RUN" -eq 0 ]; then
  printf 'FAIL: preflight failed — nothing was changed:\n%s' "$PROBLEMS" >&2
  exit 1
fi

echo "Rachel installer"
echo "  repo:          $REPO_ROOT"
echo "  LaunchAgents:  $LAUNCH_AGENTS_DIR"
echo "  launchctl:     $LAUNCHCTL ($DOMAIN)"
echo "  telegram:      ${TELEGRAM_ROUTE:-NOT CONFIGURED (see preflight problems below)}"
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
  mkdir -p "$LAUNCH_AGENTS_DIR" || die "could not create $LAUNCH_AGENTS_DIR"
  # Temp-file + rename, with lint and placeholder checks BEFORE the rename,
  # so LaunchAgents never holds a truncated or invalid plist.
  tmp="$target.tmp-$$"
  content="$(cat "$REPO_ROOT/$tpl")"
  if ! printf '%s\n' "${content//__REPO_PATH__/$REPO_ROOT}" > "$tmp"; then
    rm -f "$tmp"
    die "could not write $tmp"
  fi
  if grep -q '__REPO_PATH__' "$tmp"; then
    rm -f "$tmp"
    die "placeholder __REPO_PATH__ not consumed while stamping $tpl"
  fi
  if ! lint_out="$(/usr/bin/plutil -lint "$tmp" 2>&1)"; then
    rm -f "$tmp"
    die "stamped plist for $label failed plutil lint (is the repo path plist-safe?): $lint_out"
  fi
  mv "$tmp" "$target" || die "could not move $tmp to $target"
  echo "wrote          $target"
done

if [ -f "$PROACTIVE_CFG" ]; then
  echo "kept           $PROACTIVE_CFG  (exists — never overwritten)"
elif [ "$DRY_RUN" -eq 1 ]; then
  echo "would write    $PROACTIVE_CFG  (proactive defaults: Europe/Dublin, quiet 22:30-08:00, budget 10)"
else
  mkdir -p "$(dirname "$PROACTIVE_CFG")" || die "could not create $(dirname "$PROACTIVE_CFG")"
  # Temp-file + rename with checked writes: a partial config.json would be
  # protected forever by the never-overwrite guard above, and push.ts would
  # silently fall back to defaults on every tick.
  cfg_tmp="$PROACTIVE_CFG.tmp-$$"
  # Verbatim mirror of proactive/push.ts DEFAULT_CONFIG.
  cat > "$cfg_tmp" <<'EOF' || { rm -f "$cfg_tmp"; die "could not write $PROACTIVE_CFG (is the directory writable?)"; }
{
  "schema_version": 1,
  "timezone": "Europe/Dublin",
  "quiet_hours": { "start": "22:30", "end": "08:00" },
  "daily_budget": 10,
  "pr_watch_repos": [],
  "calendar_oneshot_hours": [8, 11, 14, 17]
}
EOF
  mv "$cfg_tmp" "$PROACTIVE_CFG" || die "could not move $cfg_tmp to $PROACTIVE_CFG"
  echo "wrote          $PROACTIVE_CFG  (proactive defaults)"
fi

# --- Failure accumulator ----------------------------------------------------
# Shared by the services loop and verification: every casualty is recorded
# and named in the final summary instead of aborting mid-loop (by the time
# services are bootstrapped, all plists are already on disk — a mid-loop
# abort would leave silent drift between on-disk plists and loaded jobs).

FAILED=0
FAIL_LIST=""
pass() { echo "PASS  $*"; }
fail() {
  echo "FAIL  $*"
  FAIL_LIST="$FAIL_LIST
  - $*"
  FAILED=$((FAILED + 1))
}

# --- Services: bootout-then-bootstrap each ---------------------------------

echo ""
echo "== Services =="
# Freshness baseline for the heartbeat check: the instant the OLD bridge is
# booted out. Its final heartbeat write is necessarily earlier, so it cannot
# satisfy the verification — only the NEW bridge's writes can.
HEARTBEAT_EPOCH="$START_EPOCH"
i=0
for tpl in "${TEMPLATES[@]}"; do
  label="${LABELS[$i]}"; i=$((i + 1))
  target="$LAUNCH_AGENTS_DIR/$label.plist"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would run      $LAUNCHCTL bootout $DOMAIN/$label  (exit 3 tolerated when not loaded)"
    echo "would run      $LAUNCHCTL bootstrap $DOMAIN $target"
    continue
  fi
  bootout_out="$("$LAUNCHCTL" bootout "$DOMAIN/$label" 2>&1)"
  rc=$?
  if [ "$label" = "$BRIDGE_LABEL" ]; then HEARTBEAT_EPOCH="$(date +%s)"; fi
  case "$rc" in
    0) echo "booted out     $label  (was loaded)" ;;
    3) echo "not loaded     $label  (fresh install — nothing to boot out)" ;;
    *) fail "launchctl bootout $DOMAIN/$label exited $rc: $bootout_out"; continue ;;
  esac
  bootstrap_out="$("$LAUNCHCTL" bootstrap "$DOMAIN" "$target" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "launchctl bootstrap failed for $label (exit $rc): $bootstrap_out"
    continue
  fi
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
  echo "would verify   proactive config parses: $PROACTIVE_CFG"
  echo "would verify   heartbeat fresh: $HEARTBEAT_FILE  (written after the bridge bootout, within ${HEARTBEAT_WAIT_SECS}s)"
  echo ""
  if [ -n "$PROBLEMS" ]; then
    printf 'Preflight problems — a real run would stop before making any change:\n%s' "$PROBLEMS"
    echo ""
    echo "DRY RUN complete — plan printed; fix the problems above before installing."
    exit 1
  fi
  echo "DRY RUN complete — no changes were made."
  exit 0
fi

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

# The config may pre-date this run (never-overwrite guard), so verify it
# actually parses — a corrupt file would silently degrade push.ts to
# defaults on every tick.
if [ -f "$PROACTIVE_CFG" ] \
  && node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$PROACTIVE_CFG" >/dev/null 2>&1; then
  pass "proactive config parses: $PROACTIVE_CFG"
else
  fail "proactive config missing or invalid JSON: $PROACTIVE_CFG"
fi

# Bounded heartbeat wait — the loop itself is the bound (no timeout/gtimeout
# wrappers). Fresh = mtime at or after the bridge's bootout (5s clock
# slack): the old bridge is dead from that instant, so neither its final
# write nor a stale file from a dead bridge can pass; only the restarted
# bridge's polling produces a passing mtime.
wait_start="$(date +%s)"
deadline=$((wait_start + HEARTBEAT_WAIT_SECS))
hb_ok=0
while :; do
  if [ -f "$HEARTBEAT_FILE" ]; then
    mtime="$(stat -f %m "$HEARTBEAT_FILE" 2>/dev/null || echo 0)"
    if [ "$mtime" -ge $((HEARTBEAT_EPOCH - 5)) ]; then hb_ok=1; break; fi
  fi
  now="$(date +%s)"
  [ "$now" -ge "$deadline" ] && break
  sleep 2
done
if [ "$hb_ok" -eq 1 ]; then
  pass "heartbeat fresh: $HEARTBEAT_FILE  (after $(( $(date +%s) - wait_start ))s)"
else
  fail "heartbeat missing or not written since the bridge bootout, after ${HEARTBEAT_WAIT_SECS}s: $HEARTBEAT_FILE  (is the bridge polling?)"
fi

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "PASS: all verification checks passed — Rachel is fully deployed."
  exit 0
fi
echo "FAIL: $FAILED check(s) failed:$FAIL_LIST"
exit 1
