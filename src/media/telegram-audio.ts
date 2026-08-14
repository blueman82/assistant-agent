import { execFile } from "node:child_process";

export type AudioExec = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ readonly stderr: string; readonly exitCode: number }>;

const DEFAULT_TIMEOUT_MS = 15_000;

export function defaultAudioExec(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ readonly stderr: string; readonly exitCode: number }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs }, (error, _stdout, stderr) => {
      if (!error) {
        resolve({ stderr: String(stderr), exitCode: 0 });
        return;
      }
      const code = typeof error.code === "number" ? error.code : 1;
      resolve({ stderr: String(stderr || error.message), exitCode: code });
    });
  });
}

export async function encodeTelegramAudio(
  wavPath: string,
  oggPath: string,
  execFn: AudioExec = defaultAudioExec,
): Promise<void> {
  const result = await execFn(
    "ffmpeg",
    ["-y", "-i", wavPath, "-c:a", "libopus", "-b:a", "32k", "-ac", "1", oggPath],
    DEFAULT_TIMEOUT_MS,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Telegram audio encoding failed: ${result.stderr.trim() || "ffmpeg failed"}`);
  }
}
