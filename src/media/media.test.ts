import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as media from "./index.ts";
import { LocalMediaStorage } from "./storage.ts";
import { defaultAudioExec, encodeTelegramAudio, type AudioExec } from "./telegram-audio.ts";
import { TelegramMediaDownloader, type TelegramFileClient } from "./telegram.ts";

test("LocalMediaStorage writes bytes below its root and rejects traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "rachel-media-"));
  const storage = new LocalMediaStorage(root);
  const saved = await storage.save("voice.ogg", new Uint8Array([1, 2]), "audio/ogg");
  assert.deepEqual([...await readFile(saved.path)], [1, 2]);
  await assert.rejects(() => storage.save("../escape", new Uint8Array()), /plain file name/);
});

test("TelegramMediaDownloader keeps the Telegram client behind a typed boundary", async () => {
  const calls: string[] = [];
  const client: TelegramFileClient = {
    async getFile(fileId) { calls.push(`get:${fileId}`); return { filePath: "files/voice" }; },
    async downloadFile(filePath) { calls.push(`download:${filePath}`); return new Uint8Array([3]); },
  };
  const root = await mkdtemp(join(tmpdir(), "rachel-media-"));
  const result = await new TelegramMediaDownloader(client, new LocalMediaStorage(root)).download({
    fileId: "telegram-id",
    fileName: "voice.ogg",
  });
  assert.equal(result.fileName, "voice.ogg");
  assert.deepEqual(calls, ["get:telegram-id", "download:files/voice"]);
});

test("encodeTelegramAudio invokes ffmpeg with the expected arguments and succeeds on exit 0", async () => {
  const calls: Array<{ command: string; args: string[]; timeoutMs: number }> = [];
  const execFn: AudioExec = async (command, args, timeoutMs) => {
    calls.push({ command, args, timeoutMs });
    return { stderr: "", exitCode: 0 };
  };
  await encodeTelegramAudio("/tmp/in.wav", "/tmp/out.ogg", execFn);
  assert.deepEqual(calls, [{
    command: "ffmpeg",
    args: ["-y", "-i", "/tmp/in.wav", "-c:a", "libopus", "-b:a", "32k", "-ac", "1", "/tmp/out.ogg"],
    timeoutMs: 15_000,
  }]);
});

test("encodeTelegramAudio throws with ffmpeg's stderr on a non-zero exit", async () => {
  const execFn: AudioExec = async () => ({ stderr: "no such filter: libopus", exitCode: 1 });
  await assert.rejects(
    () => encodeTelegramAudio("/tmp/in.wav", "/tmp/out.ogg", execFn),
    /no such filter: libopus/,
  );
});

test("encodeTelegramAudio falls back to a generic message when ffmpeg reports no stderr", async () => {
  const execFn: AudioExec = async () => ({ stderr: "   ", exitCode: 1 });
  await assert.rejects(
    () => encodeTelegramAudio("/tmp/in.wav", "/tmp/out.ogg", execFn),
    /ffmpeg failed/,
  );
});

test("defaultAudioExec runs a real subprocess and reports its exit code and stderr", async () => {
  const ok = await defaultAudioExec("node", ["-e", "process.exit(0)"], 5000);
  assert.deepEqual(ok, { stderr: "", exitCode: 0 });
  const failed = await defaultAudioExec("node", ["-e", "process.stderr.write('boom'); process.exit(3);"], 5000);
  assert.equal(failed.exitCode, 3);
  assert.match(failed.stderr, /boom/);
});

test("media's barrel exports resolve to the same implementations as their source modules", async () => {
  assert.equal(typeof media.LocalMediaStorage, "function");
  assert.equal(typeof media.TelegramMediaDownloader, "function");
  assert.equal(typeof media.defaultAudioExec, "function");
  assert.equal(typeof media.encodeTelegramAudio, "function");
  const root = await mkdtemp(join(tmpdir(), "rachel-media-"));
  const saved = await new media.LocalMediaStorage(root).save("clip.ogg", new Uint8Array([9]), "audio/ogg");
  assert.equal(saved.fileName, "clip.ogg");
  const calls: string[] = [];
  const execFn: media.AudioExec = async (command) => { calls.push(command); return { stderr: "", exitCode: 0 }; };
  await media.encodeTelegramAudio("/tmp/a.wav", "/tmp/a.ogg", execFn);
  assert.deepEqual(calls, ["ffmpeg"]);
});
