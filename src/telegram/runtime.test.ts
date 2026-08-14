import assert from "node:assert/strict";
import { test } from "node:test";
import { createTelegramRuntime } from "./runtime.ts";
import type { TelegramApi } from "./api.ts";
import type { Queue } from "./queue.ts";
import type { TelegramMessage } from "./types.ts";

function stubApi(): TelegramApi {
  return {
    async call() { return {}; },
    async getUpdates() { return []; },
    async download() {},
  };
}

function voiceMessage(): TelegramMessage {
  return { message_id: 1, chat: { id: 1 }, voice: { file_id: "abc", duration: 3 } };
}

async function waitUntilIdle(queue: Queue<TelegramMessage>): Promise<void> {
  while (queue.size > 0) await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("voice message is transcribed and the transcript is sent to turn", async () => {
  const turns: string[] = [];
  const runtime = createTelegramRuntime(
    { token: "t", chatId: "1" },
    async (text) => { turns.push(text); },
    {
      api: stubApi(),
      mediaDirectory: "/tmp",
      transcriber: { async transcribe() { return "hello from voice"; } },
    },
  );
  runtime.queue.add(voiceMessage());
  await waitUntilIdle(runtime.queue);
  assert.deepEqual(turns, ["hello from voice"]);
});

test("transcription failure sends a visible reply and does not call turn", async () => {
  const turns: string[] = [];
  const replies: string[] = [];
  const api = stubApi();
  api.call = async (method, body) => {
    if (method === "sendMessage") replies.push((body as { text: string }).text);
    return {};
  };
  const runtime = createTelegramRuntime(
    { token: "t", chatId: "1" },
    async (text) => { turns.push(text); },
    {
      api,
      mediaDirectory: "/tmp",
      transcriber: { async transcribe() { throw new Error("stt down"); } },
    },
  );
  runtime.queue.add(voiceMessage());
  await waitUntilIdle(runtime.queue);
  assert.deepEqual(turns, []);
  assert.equal(replies.length, 1);
  assert.match(replies[0]!, /couldn't transcribe/);
});

test("voice message with no transcriber configured sends a visible reply and does not call turn", async () => {
  const turns: string[] = [];
  const replies: string[] = [];
  const api = stubApi();
  api.call = async (method, body) => {
    if (method === "sendMessage") replies.push((body as { text: string }).text);
    return {};
  };
  const runtime = createTelegramRuntime(
    { token: "t", chatId: "1" },
    async (text) => { turns.push(text); },
    { api, mediaDirectory: "/tmp" },
  );
  runtime.queue.add(voiceMessage());
  await waitUntilIdle(runtime.queue);
  assert.deepEqual(turns, []);
  assert.equal(replies.length, 1);
  assert.match(replies[0]!, /aren't supported/);
});

test("a worker error (e.g. turn() throwing) is surfaced as a visible reply", async () => {
  const replies: string[] = [];
  const api = stubApi();
  api.call = async (method, body) => {
    if (method === "sendMessage") replies.push((body as { text: string }).text);
    return {};
  };
  const runtime = createTelegramRuntime(
    { token: "t", chatId: "1" },
    async () => { throw new Error("provider exploded"); },
    { api },
  );
  runtime.queue.add({ message_id: 1, chat: { id: 1 }, text: "hi" });
  await waitUntilIdle(runtime.queue);
  assert.equal(replies.length, 1);
  assert.match(replies[0]!, /Something went wrong/);
  assert.match(replies[0]!, /provider exploded/);
});
