#!/usr/bin/env python3
"""Thin wrapper: transcribes a single audio file with mlx-whisper and prints
the transcript to stdout. English-only model
(mlx-community/whisper-small.en-mlx) — faster and more accurate than
multilingual variants for English/Irish speech. Invoked by
bridge/speech.ts's transcribe() via execFile; stdout is the ONLY contract
callers rely on (no other output format).
"""
import sys

import mlx_whisper


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: transcribe.py <audio-path>", file=sys.stderr)
        return 2
    audio_path = sys.argv[1]
    result = mlx_whisper.transcribe(audio_path, path_or_hf_repo="mlx-community/whisper-small.en-mlx")
    text = result["text"].strip()
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
