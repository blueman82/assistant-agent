import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Synthesizer, Transcriber } from "./types.ts";

export type SpeechExec = (
  command: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const python = join(homedir(), ".rachel", "venvs", "speech", "bin", "python");
const transcribeScript = join(root, "scripts", "speech", "transcribe.py");
const synthesizeScript = join(root, "scripts", "speech", "synthesize.py");

export function defaultSpeechExec(
  command: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, ...(env ? { env } : {}) },
      (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: 0 });
        return;
      }
        resolve({
          stdout: String(stdout),
          stderr: String(stderr || error.message),
          exitCode: typeof error.code === "number" ? error.code : 1,
        });
      },
    );
  });
}

export function synthesizeTimeoutMs(length: number): number {
  return Math.min(300_000, 30_000 + Math.max(0, length) * 10);
}

function offlineEnv(): NodeJS.ProcessEnv {
  return { ...process.env, HF_HUB_OFFLINE: "1" };
}

export class LocalSpeech implements Transcriber, Synthesizer {
  private readonly execFn: SpeechExec;

  constructor(execFn: SpeechExec = defaultSpeechExec) {
    this.execFn = execFn;
  }

  async transcribe(audioPath: string): Promise<string> {
    const result = await this.execFn(python, [transcribeScript, audioPath], 120_000, offlineEnv());
    if (result.exitCode !== 0) throw new Error(`transcription failed: ${result.stderr.trim() || "process failed"}`);
    const text = result.stdout.trim();
    if (!text) throw new Error("transcription produced no text");
    return text;
  }

  async synthesize(text: string, outputPath: string): Promise<void> {
    const result = await this.execFn(
      python,
      [synthesizeScript, text, outputPath],
      synthesizeTimeoutMs(text.length),
      offlineEnv(),
    );
    if (result.exitCode !== 0) {
      const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join(" | ");
      throw new Error(`speech synthesis failed: ${detail || "process failed"}`);
    }
  }
}
