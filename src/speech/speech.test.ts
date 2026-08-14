import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeTelegramAudio } from "../media/telegram-audio.ts";
import { voiceOrText } from "./fallback.ts";
import { LocalSpeech, type SpeechExec } from "./local.ts";

test("LocalSpeech rejects empty transcription and retains stdout synthesis errors", async () => {
  const calls: Array<{ args: string[]; timeout: number }> = [];
  const execFn: SpeechExec = async (_command, args, timeout) => {
    calls.push({ args, timeout });
    return args[0]!.endsWith("transcribe.py")
      ? { stdout: " ", stderr: "", exitCode: 0 }
      : { stdout: "model missing", stderr: "", exitCode: 1 };
  };
  const speech = new LocalSpeech(execFn);
  await assert.rejects(() => speech.transcribe("voice.ogg"), /no text/);
  await assert.rejects(() => speech.synthesize("hello", "reply.wav"), /model missing/);
  assert.equal(calls.length, 2);
});

test("Telegram audio encoding uses the libopus command", async () => {
  let args: string[] = [];
  await encodeTelegramAudio("reply.wav", "reply.ogg", async (_command, received) => {
    args = received;
    return { stderr: "", exitCode: 0 };
  });
  assert.deepEqual(args.slice(0, 8), ["-y", "-i", "reply.wav", "-c:a", "libopus", "-b:a", "32k", "-ac"]);
  assert.equal(args.at(-1), "reply.ogg");
});

test("voiceOrText falls back to text when synthesis or encoding fails", async () => {
  const text = await voiceOrText("hello", "reply.ogg", {
    async synthesize() { throw new Error("unavailable"); },
  }, async () => {});
  assert.deepEqual(text, { kind: "text", text: "hello" });
});
