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
#   4. pip install mlx-whisper mlx-audio "misaki[en]" into that venv — the
#      [en] extra pulls in num2words/phonemizer-fork/espeakng-loader/spacy,
#      which Kokoro's English G2P needs at runtime; bare `misaki` installs
#      without them and fails with "ModuleNotFoundError: num2words" the
#      first time synthesize.py actually runs.
#   5. Pre-fetch and verify both HuggingFace models into the local cache:
#      mlx-community/whisper-small.en-mlx (scripts/speech/transcribe.py) and
#      mlx-community/Kokoro-82M-bf16 (scripts/speech/synthesize.py). This is
#      the safety net for bridge/speech.ts's HF_HUB_OFFLINE=1: with offline
#      mode on, a cold cache stops being a slow download and becomes a hard
#      failure at voice time, so setup must guarantee the cache is warm. The
#      verify pass re-resolves each model with HF_HUB_OFFLINE=1 — exactly the
#      condition the bridge runs under — so a partial download fails here
#      rather than on Gary's next voice note.
#   6. Print PASS/FAIL and exit nonzero on any step failure — a partial venv
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
"$VENV_DIR/bin/pip" install mlx-whisper mlx-audio "misaki[en]" || die "pip install mlx-whisper mlx-audio misaki[en] failed"
echo "PASS  packages installed: mlx-whisper mlx-audio misaki[en]"

# Model IDs must match the repo refs the wrapper scripts request exactly —
# scripts/speech/transcribe.py's path_or_hf_repo and scripts/speech/
# synthesize.py's model= argument. A typo here makes the whole pre-fetch inert
# because the bridge would ask offline mode for a repo nobody downloaded.
WHISPER_MODEL="mlx-community/whisper-small.en-mlx"
KOKORO_MODEL="mlx-community/Kokoro-82M-bf16"

echo "Pre-fetching models (first run downloads several hundred MB, later runs are no-ops)..."
"$VENV_DIR/bin/python" - "$WHISPER_MODEL" "$KOKORO_MODEL" <<'PY' || die "model pre-fetch failed — check network and HuggingFace availability"
import sys
from huggingface_hub import snapshot_download

for repo_id in sys.argv[1:]:
    path = snapshot_download(repo_id=repo_id)
    print(f"  fetched {repo_id} -> {path}")
PY
echo "PASS  models fetched: $WHISPER_MODEL $KOKORO_MODEL"

# Verify under the exact condition the bridge runs in: HF_HUB_OFFLINE=1 makes
# snapshot_download resolve from the local cache only, raising if anything is
# missing. A download that half-completed above fails here, not at voice time.
HF_HUB_OFFLINE=1 "$VENV_DIR/bin/python" - "$WHISPER_MODEL" "$KOKORO_MODEL" <<'PY' || die "offline model verification failed — cache is incomplete; re-run setup with network access"
import sys
from huggingface_hub import snapshot_download

for repo_id in sys.argv[1:]:
    snapshot_download(repo_id=repo_id)
    print(f"  verified offline: {repo_id}")
PY
echo "PASS  models resolve with HF_HUB_OFFLINE=1 (cache is warm)"

echo ""
echo "PASS: speech venv ready at $VENV_DIR"
exit 0
