// bridge/speech.ts — local STT/TTS subprocess wrappers. Shells out to the
// dedicated Python 3.12 venv (scripts/speech/setup.sh) via execFile with a
// timeout, mirroring proactive/sweep.ts's execFn pattern: never let a hung
// or missing subprocess wedge the caller. Exec function is injectable
// (execFileFn) so tests never spawn a real process.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const VENV_PYTHON = join(homedir(), ".rachel", "venvs", "speech", "bin", "python");
const TRANSCRIBE_SCRIPT = join(REPO_DIR, "scripts", "speech", "transcribe.py");
const SYNTHESIZE_SCRIPT = join(REPO_DIR, "scripts", "speech", "synthesize.py");

// A human may legitimately send a long voice note, and transcription cost
// scales with audio length. The old 30s budget was sized for the compute
// alone; it SIGTERMed five real transcriptions on 2026-07-23 when a stalled
// HuggingFace hub check ate the whole budget before the audio was touched.
// HF_HUB_OFFLINE (below) removes that stall; 2 minutes covers the audio.
const TRANSCRIBE_TIMEOUT_MS = 120_000;
const CONVERT_TIMEOUT_MS = 15_000;

// Both mlx-whisper and mlx-audio perform a HuggingFace Hub freshness check on
// every call even when the model is fully cached locally. Measured 2026-07-23:
// 12.2s with the check ("Fetching 4 files" on stderr) vs 4.3s with it off, and
// with the HF endpoint unreachable it hung past 45s before touching the audio
// at all. HF_HUB_OFFLINE=1 tells huggingface_hub to use the local cache only.
// scripts/speech/setup.sh pre-fetches and verifies both models so offline mode
// can never meet a cold cache — that pre-fetch is this flag's safety net.
//
// Built per call and spread over process.env deliberately: node's execFile
// REPLACES the child environment rather than merging it, and huggingface_hub
// locates its cache via HOME. A bare { HF_HUB_OFFLINE: "1" } would strip HOME
// and turn offline mode into a guaranteed cache miss.
function hfOfflineEnv(): NodeJS.ProcessEnv {
  return { ...process.env, HF_HUB_OFFLINE: "1" };
}

// Synthesis cost scales with text length, so a flat budget is a cliff, not a
// limit. Measured on host against the real venv: 210 chars -> 6s (dominated by
// cold model load), 9800 chars -> 25s, 9696 chars of prose with paths and
// punctuation -> 30s. The old flat 20s therefore failed every long reply; the
// 2026-07-22 incident hit it at 9696 chars.
//
// Floor covers cold model load with headroom. Per-char rate is ~3x the
// measured worst case (30s/9696 chars ~= 3.1ms/char) so normal variance never
// trips it. Ceiling bounds a runaway reply — the bridge must not hang.
const SYNTHESIZE_FLOOR_MS = 30_000;
const SYNTHESIZE_MS_PER_CHAR = 10;
const SYNTHESIZE_CEILING_MS = 300_000;

// Exported so callers and tests assert the budget for a given length rather
// than pinning a constant that would have to change with every retune.
export function synthesizeTimeoutMs(textLength: number): number {
  const scaled = SYNTHESIZE_FLOOR_MS + Math.max(0, textLength) * SYNTHESIZE_MS_PER_CHAR;
  return Math.min(scaled, SYNTHESIZE_CEILING_MS);
}

// env is optional and, when given, is the COMPLETE child environment (node's
// execFile replaces rather than merges) — callers that need one variable must
// spread process.env themselves. Omitted means "inherit the parent env".
export type ExecFileFn = (
  cmd: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

// Default execFileFn: never throws on non-zero exit — the exit code is
// data, callers decide what a failure means. Mirrors proactive/sweep.ts's
// defaultExecFn shape (ENOENT/timeout fold into exitCode:1 with descriptive
// stderr, since node's err.code for ENOENT is a string, not a number).
export function defaultExecFileFn(
  cmd: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, ...(env ? { env } : {}) },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: 0 });
          return;
        }
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null };
        if (typeof e.code === "number") {
          resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: e.code });
          return;
        }
        const detail = [e.message, e.killed ? "(killed)" : "", e.signal ? `signal=${e.signal}` : ""]
          .filter(Boolean)
          .join(" ");
        const errText = String(stderr).trim() === "" ? detail : `${String(stderr)}\n${detail}`;
        resolve({ stdout: String(stdout), stderr: errText, exitCode: 1 });
      },
    );
  });
}

// Transcribes the given audio file path via the local mlx-whisper venv.
// Throws on nonzero exit, timeout, or an empty transcript — callers catch
// and fall back to a text reply asking Gary to retry or type it (never
// silently drop a voice message).
export async function transcribe(audioPath: string, execFileFn: ExecFileFn = defaultExecFileFn): Promise<string> {
  const { stdout, stderr, exitCode } = await execFileFn(
    VENV_PYTHON,
    [TRANSCRIBE_SCRIPT, audioPath],
    TRANSCRIBE_TIMEOUT_MS,
    hfOfflineEnv(),
  );
  if (exitCode !== 0) {
    throw new Error(`transcribe failed (exit ${exitCode}): ${stderr.trim() || "no stderr output"}`);
  }
  const text = stdout.trim();
  if (!text) {
    throw new Error("transcribe produced an empty transcript");
  }
  return text;
}

// Synthesizes speech for the given text via the local mlx-audio/Kokoro
// venv, writing a WAV file to outPath. Throws on nonzero exit or timeout —
// callers catch and fall back to sending the reply as text instead of
// voice.
export async function synthesize(text: string, outPath: string, execFileFn: ExecFileFn = defaultExecFileFn): Promise<void> {
  const { stdout, stderr, exitCode } = await execFileFn(
    VENV_PYTHON,
    [SYNTHESIZE_SCRIPT, text, outPath],
    synthesizeTimeoutMs(text.length),
  );
  if (exitCode !== 0) {
    // stdout matters here, and is not redundant with stderr. mlx-audio's
    // generate_audio catches every exception, prints the reason with a bare
    // print() — stdout — and returns normally without writing a file.
    // synthesize.py then reports the no-output condition on stderr, but the
    // *reason* is only ever on stdout. Reading stderr alone left the
    // 2026-07-22 failure logged as a bare progress bar and undiagnosable.
    const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join(" | ");
    throw new Error(`synthesize failed (exit ${exitCode}): ${detail || "no output"}`);
  }
}

// Converts a WAV file to Telegram-compatible OGG/Opus via ffmpeg (already
// installed on host). Throws on nonzero exit or timeout — same fallback
// contract as synthesize().
export async function convertToOgg(wavPath: string, oggPath: string, execFileFn: ExecFileFn = defaultExecFileFn): Promise<void> {
  const { stderr, exitCode } = await execFileFn(
    "ffmpeg",
    ["-y", "-i", wavPath, "-c:a", "libopus", "-b:a", "32k", "-ac", "1", oggPath],
    CONVERT_TIMEOUT_MS,
  );
  if (exitCode !== 0) {
    throw new Error(`ffmpeg conversion failed (exit ${exitCode}): ${stderr.trim() || "no stderr output"}`);
  }
}
