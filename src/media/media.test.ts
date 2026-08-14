import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalMediaStorage } from "./storage.ts";
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
