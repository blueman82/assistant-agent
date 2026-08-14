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
    async sendVoice() {},
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

test("a worker error is logged server-side via stderr, not just replied to the user", async () => {
  const api = stubApi();
  const runtime = createTelegramRuntime(
    { token: "t", chatId: "1" },
    async () => { throw new Error("provider exploded"); },
    { api },
  );
  const originalWrite = process.stderr.write.bind(process.stderr);
  const written: string[] = [];
  process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    runtime.queue.add({ message_id: 1, chat: { id: 1 }, text: "hi" });
    await waitUntilIdle(runtime.queue);
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.ok(written.some((line) => line.includes("provider exploded")), "expected the real error to be logged to stderr");
});

test("a message from a mismatched chat ID is dropped and logged without its text", async () => {
  const turns: string[] = [];
  const api = stubApi();
  api.getUpdates = async () => [
    { update_id: 1, message: { message_id: 1, chat: { id: 999 }, text: "secret payload" } },
  ];
  const runtime = createTelegramRuntime(
    { token: "t", chatId: "1" },
    async (text) => { turns.push(text); },
    { api },
  );
  const originalWrite = process.stdout.write.bind(process.stdout);
  const written: string[] = [];
  process.stdout.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    await runtime.poller.pollOnce();
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.deepEqual(turns, []);
  assert.ok(written.some((line) => line.includes("message dropped") && line.includes("999")), "expected the drop to be logged with the mismatched chat ID");
  assert.ok(!written.some((line) => line.includes("secret payload")), "message text must not be logged");
});

test("text-triggered turn replies immediately per event, never buffered (regression)", async () => {
  const replies: string[] = [];
  const api = stubApi();
  api.call = async (method, body) => {
    if (method === "sendMessage") replies.push((body as { text: string }).text);
    return {};
  };
  const sent: string[] = [];
  api.sendVoice = async (_chatId, filePath) => { sent.push(filePath); };
  const runtime = createTelegramRuntime(
    { token: "t", chatId: "1" },
    async (_text, reply) => { await reply("first"); await reply("second"); },
    { api, mediaDirectory: "/tmp", synthesizer: { async synthesize() {} } },
  );
  runtime.queue.add({ message_id: 1, chat: { id: 1 }, text: "hi" });
  await waitUntilIdle(runtime.queue);
  assert.deepEqual(replies, ["first", "second"]);
  assert.deepEqual(sent, []);
});

test("plain-text turn completion is logged with a reply flush line", async () => {
  const api = stubApi();
  const runtime = createTelegramRuntime(
    { token: "t", chatId: "1" },
    async (_text, reply) => { await reply("hello back"); },
    { api },
  );
  const originalWrite = process.stdout.write.bind(process.stdout);
  const written: string[] = [];
  process.stdout.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    runtime.queue.add({ message_id: 1, chat: { id: 1 }, text: "hi" });
    await waitUntilIdle(runtime.queue);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.ok(written.some((line) => line.includes("reply flush outcome=text")), "expected a reply flush completion line for the plain-text path");
});

test("memory commands are handled before the provider turn", async () => {
  const turns: string[] = [];
  const replies: string[] = [];
  const api = stubApi();
  api.call = async (method, body) => {
    if (method === "sendMessage") replies.push((body as { text: string }).text);
    return {};
  };
  const remembered: string[] = [];
  const runtime = createTelegramRuntime(
    { token: "t", chatId: "1" },
    async (text) => { turns.push(text); },
    {
      api,
      memory: {
        async remember(text) { remembered.push(text); },
        async forget() {},
        async resetConversation() {},
      },
    },
  );
  runtime.queue.add({ message_id: 1, chat: { id: 1 }, text: "/remember Gary likes concise answers" });
  await waitUntilIdle(runtime.queue);
  assert.deepEqual(remembered, ["Gary likes concise answers"]);
  assert.deepEqual(turns, []);
  assert.deepEqual(replies, ["Remembered."]);
});

test("Telegram reset runs the session hook and shared conversation reset", async () => {
  const calls: string[] = [];
  const api = stubApi();
  api.call = async (method, body) => {
    if (method === "sendMessage") assert.equal((body as { text: string }).text, "Session reset.");
    return {};
  };
  const runtime = createTelegramRuntime(
    { token: "t", chatId: "1" },
    async () => { throw new Error("reset must not reach provider"); },
    {
      api,
      memory: { async remember() {}, async forget() {}, async resetConversation() { calls.push("conversation"); } },
      commandContext: { reset: async () => { calls.push("session"); }, stop: () => false, status: () => "" },
    },
  );
  runtime.queue.add({ message_id: 1, chat: { id: 1 }, text: "/reset" });
  await waitUntilIdle(runtime.queue);
  assert.deepEqual(calls, ["session", "conversation"]);
});

test("voice-in with a synthesizer sends a voice note built from all buffered replies, joined with newlines", async () => {
  const sent: Array<{ chatId: string; filePath: string }> = [];
  const api = stubApi();
  api.sendVoice = async (chatId, filePath) => { sent.push({ chatId, filePath }); };
  const synthesizedText: string[] = [];
  const runtime = createTelegramRuntime(
    { token: "t", chatId: "1" },
    async (_text, reply) => { await reply("first chunk"); await reply("second chunk"); },
    {
      api,
      mediaDirectory: "/tmp",
      transcriber: { async transcribe() { return "hello from voice"; } },
      synthesizer: { async synthesize(text) { synthesizedText.push(text); } },
      encodeAudio: async () => {},
    },
  );
  runtime.queue.add(voiceMessage());
  await waitUntilIdle(runtime.queue);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.chatId, "1");
  assert.deepEqual(synthesizedText, ["first chunk\nsecond chunk"]);
});

test("voice-in when turn throws after one buffered reply still flushes the buffered content and the generic error reply", async () => {
  const replies: string[] = [];
  const api = stubApi();
  api.call = async (method, body) => {
    if (method === "sendMessage") replies.push((body as { text: string }).text);
    return {};
  };
  const sent: string[] = [];
  api.sendVoice = async () => { sent.push("voice"); };
  const runtime = createTelegramRuntime(
    { token: "t", chatId: "1" },
    async (_text, reply) => { await reply("partial answer"); throw new Error("provider exploded"); },
    {
      api,
      mediaDirectory: "/tmp",
      transcriber: { async transcribe() { return "hello from voice"; } },
      synthesizer: { async synthesize() {} },
      encodeAudio: async () => {},
    },
  );
  runtime.queue.add(voiceMessage());
  await waitUntilIdle(runtime.queue);
  assert.deepEqual(sent, ["voice"]);
  assert.equal(replies.length, 1);
  assert.match(replies[0]!, /Something went wrong/);
  assert.match(replies[0]!, /provider exploded/);
});

test("voice-in with zero buffered replies sends neither voice nor text", async () => {
  const replies: string[] = [];
  const api = stubApi();
  api.call = async (method, body) => {
    if (method === "sendMessage") replies.push((body as { text: string }).text);
    return {};
  };
  const sent: string[] = [];
  api.sendVoice = async () => { sent.push("voice"); };
  const runtime = createTelegramRuntime(
    { token: "t", chatId: "1" },
    async () => {},
    {
      api,
      mediaDirectory: "/tmp",
      transcriber: { async transcribe() { return "hello from voice"; } },
      synthesizer: { async synthesize() {} },
      encodeAudio: async () => {},
    },
  );
  runtime.queue.add(voiceMessage());
  await waitUntilIdle(runtime.queue);
  assert.deepEqual(sent, []);
  assert.deepEqual(replies, []);
});

test("voice-in without a synthesizer configured falls back to a plain text reply", async () => {
  const replies: string[] = [];
  const api = stubApi();
  api.call = async (method, body) => {
    if (method === "sendMessage") replies.push((body as { text: string }).text);
    return {};
  };
  const sent: string[] = [];
  api.sendVoice = async () => { sent.push("voice"); };
  const runtime = createTelegramRuntime(
    { token: "t", chatId: "1" },
    async (_text, reply) => { await reply("plain text answer"); },
    {
      api,
      mediaDirectory: "/tmp",
      transcriber: { async transcribe() { return "hello from voice"; } },
    },
  );
  runtime.queue.add(voiceMessage());
  await waitUntilIdle(runtime.queue);
  assert.deepEqual(sent, []);
  assert.deepEqual(replies, ["plain text answer"]);
});
