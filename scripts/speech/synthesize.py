#!/usr/bin/env python3
"""Thin wrapper: synthesizes speech for the given text with mlx-audio/Kokoro
and writes a WAV file to the given output path. Voice preset bf_emma
(British English, female) — matches Rachel's persona. Invoked by
bridge/speech.ts's synthesize() via execFile.
"""
import sys
from pathlib import Path

from mlx_audio.tts.generate import generate_audio


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: synthesize.py <text> <out-wav-path>", file=sys.stderr)
        return 2
    text = sys.argv[1]
    out_path = Path(sys.argv[2])
    out_path.parent.mkdir(parents=True, exist_ok=True)

    generate_audio(
        text=text,
        model="mlx-community/Kokoro-82M-bf16",
        voice="bf_emma",
        lang_code="b",  # British English — matches the bf_emma voice prefix;
        # the default ("a"/American) triggers a language-mismatch warning and
        # phonemizes with the wrong accent rules for a "bf_" voice.
        file_prefix=str(out_path.with_suffix("")),
        audio_format="wav",
        join_audio=True,
        verbose=False,
    )

    if not out_path.exists():
        # mlx-audio's generate_audio names its own output file from
        # file_prefix (contract not pinned by upstream docs at time of
        # writing) — if it didn't land exactly at out_path, pick up
        # whatever it produced next to file_prefix and rename it there.
        # This is the one place the real API shape may need a fix — first
        # exercised for real by this task's own pipeline smoke check below,
        # not left until Task 10's live Telegram session.
        candidates = sorted(out_path.parent.glob(f"{out_path.stem}*.wav"))
        if not candidates:
            print(
                f"synthesize.py: mlx-audio produced no output file matching "
                f"{out_path.stem}*.wav in {out_path.parent}",
                file=sys.stderr,
            )
            return 1
        candidates[0].rename(out_path)

    return 0


if __name__ == "__main__":
    sys.exit(main())
