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

const TRANSCRIBE_TIMEOUT_MS = 30_000;
const SYNTHESIZE_TIMEOUT_MS = 20_000;
const CONVERT_TIMEOUT_MS = 15_000;

export type ExecFileFn = (
  cmd: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

// Default execFileFn: never throws on non-zero exit — the exit code is
// data, callers decide what a failure means. Mirrors proactive/sweep.ts's
// defaultExecFn shape (ENOENT/timeout fold into exitCode:1 with descriptive
// stderr, since node's err.code for ENOENT is a string, not a number).
export function defaultExecFileFn(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
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
  const { stdout, stderr, exitCode } = await execFileFn(VENV_PYTHON, [TRANSCRIBE_SCRIPT, audioPath], TRANSCRIBE_TIMEOUT_MS);
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
  const { stderr, exitCode } = await execFileFn(VENV_PYTHON, [SYNTHESIZE_SCRIPT, text, outPath], SYNTHESIZE_TIMEOUT_MS);
  if (exitCode !== 0) {
    throw new Error(`synthesize failed (exit ${exitCode}): ${stderr.trim() || "no stderr output"}`);
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
