#!/bin/bash
# scripts/speech/setup.sh — one-shot setup for the local STT/TTS venv used by
# bridge/speech.ts. Idempotent: safe to re-run after the venv already exists.
#
#   ./scripts/speech/setup.sh            create/update the venv, print PASS/FAIL
#
# Steps:
#   1. Verify Python 3.12 is on the machine (via `python3.12` on PATH). If
#      not, `brew install python@3.12` (mlx-audio/Kokoro does not yet support
#      3.13 — Blaizzy/mlx-audio#452 — so 3.12 is pinned deliberately, not the
#      host's system 3.13).
#   2. Verify ffmpeg is on the machine (via `command -v ffmpeg`). If not,
#      `brew install ffmpeg` — the spec assumes ffmpeg is "already installed
#      on host", but nothing else in this plan checks that before Task 8's
#      convertToOgg() and Task 10's live run depend on it, so it's checked
#      here, at setup time, instead of surfacing as a surprise later.
#   3. Create ~/.rachel/venvs/speech with python3.12 -m venv if it doesn't
#      already exist.
#   4. pip install mlx-whisper mlx-audio misaki into that venv.
#   5. Print PASS/FAIL and exit nonzero on any step failure — a partial venv
#      must never look like a working one.
set -u

HOME_DIR="${INSTALL_HOME:-$HOME}"
VENV_DIR="$HOME_DIR/.rachel/venvs/speech"

die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

echo "Speech venv setup"
echo "  venv: $VENV_DIR"

if ! command -v python3.12 >/dev/null 2>&1; then
  echo "python3.12 not found — installing via brew..."
  command -v brew >/dev/null 2>&1 || die "brew not found on PATH — install Homebrew first, then re-run"
  brew install python@3.12 || die "brew install python@3.12 failed"
  command -v python3.12 >/dev/null 2>&1 || die "python3.12 still not on PATH after brew install — check brew's shellenv/PATH setup"
fi
echo "PASS  python3.12 present: $(command -v python3.12)"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found — installing via brew..."
  command -v brew >/dev/null 2>&1 || die "brew not found on PATH — install Homebrew first, then re-run"
  brew install ffmpeg || die "brew install ffmpeg failed"
  command -v ffmpeg >/dev/null 2>&1 || die "ffmpeg still not on PATH after brew install — check brew's shellenv/PATH setup"
fi
echo "PASS  ffmpeg present: $(command -v ffmpeg)"

if [ ! -x "$VENV_DIR/bin/python" ]; then
  mkdir -p "$(dirname "$VENV_DIR")" || die "could not create $(dirname "$VENV_DIR")"
  python3.12 -m venv "$VENV_DIR" || die "python3.12 -m venv $VENV_DIR failed"
fi
echo "PASS  venv present: $VENV_DIR"

"$VENV_DIR/bin/pip" install --upgrade pip >/dev/null 2>&1 || die "pip upgrade failed in $VENV_DIR"
"$VENV_DIR/bin/pip" install mlx-whisper mlx-audio misaki || die "pip install mlx-whisper mlx-audio misaki failed"
echo "PASS  packages installed: mlx-whisper mlx-audio misaki"

echo ""
echo "PASS: speech venv ready at $VENV_DIR"
exit 0
