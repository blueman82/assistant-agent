#!/bin/bash
# Regression check for WU1's live hook-fire probe (2026-07-06, session 679d72bd).
# Ported from coderails' hooks/scripts/tests/no_edit_on_main.test.sh shape: synthetic
# PreToolUse payloads against temp dirs, CLAUDE_DISCIPLINE_LOG override, mktemp+trap
# cleanup. Bash 3.2 compatible (no associative arrays, no `[[ ]]` regex features).
#
# What this asserts, and why it isn't the same as re-testing coderails itself:
# coderails' own hooks/scripts/tests/no_edit_on_main.test.sh and test_gate.test.sh
# already prove those scripts' LOGIC is correct in isolation. This file instead
# proves what assistant-agent's actual runtime environment does RIGHT NOW — the
# globally installed plugin copy, not the coderails source checkout — because a
# secretary SDK session only ever sees whatever plugin version is installed.
#
# Live-probe findings this encodes (raw observed evidence, 2026-07-06 23:0x BST):
#   1. `npx tsx secretary.ts` piped "create tasks/2026-07-06-hook-probe.md..." ran
#      clean (Write, Bash, Read, Edit all proceeded, turns=5, exit 0) — tasks/*.md
#      is not misfired on. CLAUDE_DISCIPLINE_LOG showed only Stop-hook entries
#      (confidence_labels, did_not_verify) for that session, no deny.
#   2. `npx tsx secretary.ts` in a disposable clone of assistant-agent checked out
#      on `main`, piped "Edit secretary.ts to add a one-line comment... then stop":
#      the Edit PROCEEDED (turns=3, exit 0, `// probe` landed as line 1). This is
#      the code-arm-on-main case that no_edit_on_main.sh is documented (in the
#      coderails source) to universally deny — it did NOT fire here.
#   3. Root cause (static + matches the live result, AS OF 2026-07-06): the
#      globally installed plugin — ~/.claude/plugins/cache/coderails/coderails/1.0.0,
#      version 1.0.0, installed 2026-06-24, autoUpdates:false — had NO
#      no_edit_on_main.sh file on disk and NO Write|Edit|MultiEdit matcher entry in
#      its hooks/hooks.json at all. It also lacked enforce_pr_workflow.sh. The
#      coderails SOURCE checkout at ~/Github/coderails was version 1.1.0 and DID
#      have both. The installed copy was stale relative to source — a real
#      version-skew gap, not a hook bug (see assistant-agent PR #3).
#      UPDATE (2026-07-07): the plugin self-updated to 1.1.0 overnight — the
#      installed cache now carries the full 12-script set, including
#      no_edit_on_main.sh and enforce_pr_workflow.sh. The gap this test documented
#      is closed; assertions below flipped from MISSING to PRESENT accordingly.
#      INSTALLED_HOOKS is resolved dynamically (via installed_plugins.json) rather
#      than hardcoded to a version string, so this test tracks whichever plugin
#      version is actually active instead of drifting stale again.
#   4. test_gate.sh IS present in the installed copy (older revision: `cat` instead
#      of the bounded `read -r -d '' -t 5`, but functionally equivalent for this
#      assertion) and fires correctly: allows a `git commit` when `.claude/test_command`
#      passes, denies when it fails (negative control, proves not vacuously green).
#   5. Incidental finding: `.claude/test_command` itself (no file extension) is NOT
#      in no_edit_on_main.sh's allowlist (extensions checked: .md/.txt/.rst/.yaml/
#      .yml/.json/.toml/.ini/.cfg; bare names checked: .gitignore/LICENSE only) —
#      so now that the plugin includes no_edit_on_main.sh, editing
#      .claude/test_command directly on main IS denied (matches the flipped
#      assertions above). Filed as a finding for whoever next touches that file on
#      main; Task 1 edits it only via a feature-branch PR anyway.
set -u
INSTALLED_PLUGINS_JSON="$HOME/.claude/plugins/installed_plugins.json"
CACHE_ROOT="$HOME/.claude/plugins/cache/coderails/coderails"

# Resolve the ACTIVE installed plugin path rather than hardcoding a version
# string — the plugin auto-updates (finding 3 above happened because a
# hardcoded 1.0.0 path silently kept testing a superseded install). Prefer the
# installPath jq reports live; fall back to the newest cache dir by mtime if
# jq or the expected key is unavailable.
INSTALLED_HOOKS=""
if command -v jq >/dev/null 2>&1 && [ -f "$INSTALLED_PLUGINS_JSON" ]; then
  install_path=$(jq -r '.plugins["coderails@coderails"][0].installPath // empty' "$INSTALLED_PLUGINS_JSON" 2>/dev/null)
  if [ -n "$install_path" ] && [ -d "$install_path/hooks/scripts" ]; then
    INSTALLED_HOOKS="$install_path/hooks/scripts"
  fi
fi
if [ -z "$INSTALLED_HOOKS" ] && [ -d "$CACHE_ROOT" ]; then
  newest=$(ls -t "$CACHE_ROOT" 2>/dev/null | head -1)
  if [ -n "$newest" ] && [ -d "$CACHE_ROOT/$newest/hooks/scripts" ]; then
    INSTALLED_HOOKS="$CACHE_ROOT/$newest/hooks/scripts"
  fi
fi
SOURCE_HOOKS="$HOME/Github/coderails/hooks/scripts"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export CLAUDE_DISCIPLINE_LOG="$TMP/discipline.log"
fails=0

check() { # desc expected actual
  if [ "$2" = "$3" ]; then printf 'ok   - %s\n' "$1"
  else printf 'FAIL - %s (expected %s, got %s)\n' "$1" "$2" "$3"; fails=$((fails+1)); fi
}

# ── Finding 1 & 3: installed plugin cache has no_edit_on_main.sh ────────────
# Originally documented the 1.0.0 gap (MISSING) that was the root cause of
# live-probe result #2 above (code-arm-on-main not blocked). The plugin
# auto-updated to 1.1.0 on 2026-07-07, which closed the gap — flipped to
# PRESENT accordingly. If this ever flips back to MISSING, re-run the live
# probe (steps 3/4 of plan.md Task 1) to confirm the code-arm-on-main and
# tasks/*.md cases still behave as documented.
if [ -f "$INSTALLED_HOOKS/no_edit_on_main.sh" ]; then
  installed_state="PRESENT"
else
  installed_state="MISSING"
fi
check "installed plugin (active cache) has no_edit_on_main.sh" "PRESENT" "$installed_state"

if [ -f "$INSTALLED_HOOKS/enforce_pr_workflow.sh" ]; then
  installed_pr_state="PRESENT"
else
  installed_pr_state="MISSING"
fi
check "installed plugin (active cache) has enforce_pr_workflow.sh" "PRESENT" "$installed_pr_state"

# ── Finding 3 (contrast): the coderails SOURCE checkout DOES have it ─────────
if [ -f "$SOURCE_HOOKS/no_edit_on_main.sh" ]; then
  source_state="PRESENT"
else
  source_state="MISSING"
fi
check "coderails source checkout (~/Github/coderails) has no_edit_on_main.sh" "PRESENT" "$source_state"

# ── Finding 2, exercised directly against the SOURCE script (proves what it───
# WOULD do once the plugin is updated — the negative control that shows finding
# 1 is a real gap, not "the hook doesn't need to fire here anyway") ──────────
if [ -f "$SOURCE_HOOKS/no_edit_on_main.sh" ]; then
  REPO="$TMP/repo"
  mkdir -p "$REPO"
  git -C "$REPO" init -q
  git -C "$REPO" config user.email t@t.t
  git -C "$REPO" config user.name t
  git -C "$REPO" commit -q --allow-empty -m init
  git -C "$REPO" branch -M main

  payload() { printf '{"tool_name":"%s","tool_input":{"file_path":"%s"},"cwd":"%s"}' "$1" "$2" "$REPO"; }
  run_source_hook() {
    local out
    out=$(printf '%s' "$1" | bash "$SOURCE_HOOKS/no_edit_on_main.sh" 2>/dev/null)
    if printf '%s' "$out" | grep -q '"permissionDecision": *"deny"'; then echo DENY; else echo ALLOW; fi
  }

  check "source hook: main, tasks/*.md Write -> allow (matches live probe #1)" \
    ALLOW "$(run_source_hook "$(payload Write tasks/2026-07-06-hook-probe.md)")"
  check "source hook: main, secretary.ts Edit -> deny (contradicts live probe #2 — the gap)" \
    DENY "$(run_source_hook "$(payload Edit secretary.ts)")"
  check "source hook: main, .claude/test_command Edit -> deny (finding 5)" \
    DENY "$(run_source_hook "$(payload Edit .claude/test_command)")"
else
  # Don't let a missing source checkout silently drop these three behavioral
  # checks — record the loss as a failure rather than a quiet no-op, even
  # though the PRESENT/MISSING check above would already fail the suite.
  check "source hook: main, tasks/*.md Write -> allow (matches live probe #1)" ALLOW "SKIPPED-no-source-checkout"
  check "source hook: main, secretary.ts Edit -> deny (contradicts live probe #2 — the gap)" DENY "SKIPPED-no-source-checkout"
  check "source hook: main, .claude/test_command Edit -> deny (finding 5)" DENY "SKIPPED-no-source-checkout"
fi

# ── Finding 4: test_gate.sh IS present and installed, fires correctly ────────
if [ -f "$INSTALLED_HOOKS/test_gate.sh" ]; then
  tg_state="PRESENT"
else
  tg_state="MISSING"
fi
check "installed plugin (active cache) has test_gate.sh" "PRESENT" "$tg_state"

if [ -f "$INSTALLED_HOOKS/test_gate.sh" ]; then
  PROJ_PASS="$TMP/proj_pass"
  mkdir -p "$PROJ_PASS/.claude"
  printf 'true\n' > "$PROJ_PASS/.claude/test_command"
  PROJ_FAIL="$TMP/proj_fail"
  mkdir -p "$PROJ_FAIL/.claude"
  printf 'false\n' > "$PROJ_FAIL/.claude/test_command"

  tg_payload() { jq -n --arg cmd "$1" '{"tool_name":"Bash","tool_input":{"command":$cmd}}'; }
  run_test_gate() { # dir json -> DENY|ALLOW
    local dir="$1" json="$2" out
    out=$(cd "$dir" && printf '%s' "$json" | bash "$INSTALLED_HOOKS/test_gate.sh" 2>/dev/null)
    if printf '%s' "$out" | grep -q '"permissionDecision": *"deny"'; then echo DENY; else echo ALLOW; fi
  }

  check "installed test_gate: passing test_command, git commit -> allow" \
    ALLOW "$(run_test_gate "$PROJ_PASS" "$(tg_payload "git commit -m 'x'")")"
  check "installed test_gate: FAILING test_command, git commit -> deny (negative control)" \
    DENY "$(run_test_gate "$PROJ_FAIL" "$(tg_payload "git commit -m 'x'")")"
else
  # Same discipline as the no_edit_on_main block above: record the loss
  # explicitly rather than letting the check count silently shrink.
  check "installed test_gate: passing test_command, git commit -> allow" ALLOW "SKIPPED-no-installed-test-gate"
  check "installed test_gate: FAILING test_command, git commit -> deny (negative control)" DENY "SKIPPED-no-installed-test-gate"
fi

[ "$fails" -eq 0 ] && { echo "PASS"; exit 0; } || { echo "FAILED ($fails)"; exit 1; }
