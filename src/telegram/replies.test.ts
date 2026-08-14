import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { flushVoiceReply } from "./replies.ts";
import type { TelegramApi } from "./api.ts";

function stubApi(): TelegramApi {
  return {
    async call() { return {}; },
    async getUpdates() { return []; },
    async download() {},
    async sendVoice() {},
  };
}

test("flushVoiceReply sends a voice note and cleans up the temp wav and ogg files", async () => {
  const sent: Array<{ chatId: string; filePath: string }> = [];
  const api = stubApi();
  api.sendVoice = async (chatId, filePath) => { sent.push({ chatId, filePath }); };
  const paths: { wavPath?: string; oggPath?: string } = {};
  await flushVoiceReply("hello there", api, "1", {
    synthesizer: { async synthesize(_text, outputPath) { paths.wavPath = outputPath; await writeFile(outputPath, "wav"); } },
    encode: async (wavPath, oggPath) => { paths.oggPath = oggPath; await writeFile(oggPath, "ogg"); void wavPath; },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.chatId, "1");
  assert.match(sent[0]!.filePath, /\.ogg$/);
  await assert.rejects(() => access(sent[0]!.filePath));
  assert.ok(paths.wavPath);
  await assert.rejects(() => access(paths.wavPath!));
});

test("flushVoiceReply falls back to text when synthesis fails", async () => {
  const replies: string[] = [];
  const api = stubApi();
  api.call = async (method, body) => {
    if (method === "sendMessage") replies.push((body as { text: string }).text);
    return {};
  };
  await flushVoiceReply("hello there", api, "1", {
    synthesizer: { async synthesize() { throw new Error("tts unavailable"); } },
  });
  assert.deepEqual(replies, ["hello there"]);
});

test("flushVoiceReply falls back to text when the voice upload fails", async () => {
  const replies: string[] = [];
  const api = stubApi();
  api.call = async (method, body) => {
    if (method === "sendMessage") replies.push((body as { text: string }).text);
    return {};
  };
  api.sendVoice = async () => { throw new Error("upload failed"); };
  await flushVoiceReply("hello there", api, "1", {
    synthesizer: { async synthesize(_text, outputPath) { await writeFile(outputPath, "wav"); } },
    encode: async (_wavPath, oggPath) => { await writeFile(oggPath, "ogg"); },
  });
  assert.deepEqual(replies, ["hello there"]);
});

test("flushVoiceReply does nothing for empty or whitespace-only text", async () => {
  const api = stubApi();
  let sendCalled = false;
  api.sendVoice = async () => { sendCalled = true; };
  let synthesizeCalled = false;
  await flushVoiceReply("   ", api, "1", {
    synthesizer: { async synthesize() { synthesizeCalled = true; } },
  });
  assert.equal(sendCalled, false);
  assert.equal(synthesizeCalled, false);
});
