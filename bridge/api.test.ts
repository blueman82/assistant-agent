import { test } from "node:test";
import assert from "node:assert/strict";
import { tg, sendChunked, sendTyping, setMyCommands } from "./api.ts";

function makeStubTransport(handler: (url: string, body: unknown) => unknown) {
  const calls: { url: string; body: unknown }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    return { ok: true, json: async () => handler(url, body) } as Response;
  };
  return { transport, calls };
}

test("tg() posts to the method URL and returns the parsed body on ok:true", async () => {
  const { transport, calls } = makeStubTransport(() => ({ ok: true, result: { foo: "bar" } }));
  const result = await tg({ token: "t", chatId: "1", transport }, "sendMessage", { chat_id: "1", text: "hi" });
  assert.deepEqual(result, { foo: "bar" });
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.url.includes("/sendMessage"));
});

test("tg() throws when the HTTP response is not ok", async () => {
  const transport: typeof fetch = async () => ({ ok: false, json: async () => ({ ok: false, description: "boom" }) } as Response);
  await assert.rejects(() => tg({ token: "t", chatId: "1", transport }, "sendMessage", {}), /boom/);
});

test("tg() throws when the Telegram body reports ok:false", async () => {
  const transport: typeof fetch = async () => ({ ok: true, json: async () => ({ ok: false, description: "Bad Request: nope" }) } as Response);
  await assert.rejects(() => tg({ token: "t", chatId: "1", transport }, "sendMessage", {}), /Bad Request: nope/);
});

test("tg() redacts the bot token from any thrown error message", async () => {
  const transport: typeof fetch = async () => ({ ok: false, json: async () => ({ ok: false, description: "fail" }) } as Response);
  await assert.rejects(
    () => tg({ token: "SECRET-TOKEN-123", chatId: "1", transport }, "sendMessage", {}),
    (err: Error) => {
      assert.ok(!err.message.includes("SECRET-TOKEN-123"), `error message leaked the token: ${err.message}`);
      return true;
    },
  );
});

test("sendChunked sends the whole text in one call when under 4096 chars", async () => {
  const { transport, calls } = makeStubTransport(() => ({ ok: true, result: {} }));
  await sendChunked({ token: "t", chatId: "1", transport }, "hello world");
  const sendCalls = calls.filter((c) => c.url.includes("/sendMessage"));
  assert.equal(sendCalls.length, 1);
  assert.equal((sendCalls[0]!.body as Record<string, unknown>)["text"], "hello world");
});

test("sendChunked splits text over 4096 chars into multiple calls, each <= 4096, reconstructing the original", async () => {
  const { transport, calls } = makeStubTransport(() => ({ ok: true, result: {} }));
  const text = "x".repeat(5000);
  await sendChunked({ token: "t", chatId: "1", transport }, text);
  const sendCalls = calls.filter((c) => c.url.includes("/sendMessage"));
  assert.ok(sendCalls.length > 1);
  const texts = sendCalls.map((c) => (c.body as Record<string, unknown>)["text"] as string);
  for (const t of texts) {
    assert.ok(t.length <= 4096);
  }
  assert.equal(texts.join("").length, 5000);
});

test("sendChunked splits at the last newline before the 4096 boundary when one exists", async () => {
  const { transport, calls } = makeStubTransport(() => ({ ok: true, result: {} }));
  // Construct text with a newline just before the 4096 boundary so the
  // splitter should prefer breaking there over a mid-word cut.
  const before = "a".repeat(4000) + "\n" + "b".repeat(50);
  const after = "c".repeat(200);
  const text = before + after;
  await sendChunked({ token: "t", chatId: "1", transport }, text);
  const sendCalls = calls.filter((c) => c.url.includes("/sendMessage"));
  const firstChunk = (sendCalls[0]!.body as Record<string, unknown>)["text"] as string;
  assert.ok(firstChunk.endsWith("a".repeat(1)) || firstChunk.length <= 4000, "first chunk should break at/before the newline, not mid-word past it");
  const rejoined = sendCalls.map((c) => (c.body as Record<string, unknown>)["text"] as string).join("");
  assert.equal(rejoined.length, text.length);
});

test("sendTyping calls sendChatAction with action 'typing'", async () => {
  const { transport, calls } = makeStubTransport(() => ({ ok: true, result: true }));
  await sendTyping({ token: "t", chatId: "1", transport });
  const call = calls.find((c) => c.url.includes("/sendChatAction"));
  assert.ok(call);
  assert.equal((call!.body as Record<string, unknown>)["action"], "typing");
  assert.equal((call!.body as Record<string, unknown>)["chat_id"], "1");
});

test("setMyCommands posts the given command list", async () => {
  const { transport, calls } = makeStubTransport(() => ({ ok: true, result: true }));
  await setMyCommands({ token: "t", chatId: "1", transport }, [
    { command: "reset", description: "Reset session" },
    { command: "status", description: "Show status" },
    { command: "stop", description: "Abort in-flight turn" },
  ]);
  const call = calls.find((c) => c.url.includes("/setMyCommands"));
  assert.ok(call);
  const body = call!.body as Record<string, unknown>;
  assert.equal((body["commands"] as unknown[]).length, 3);
});

test("grep guard: no test in this file ever calls the real api.telegram.org network endpoint", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("./api.test.ts", import.meta.url), "utf8");
  const realFetchCall = /fetch\(\s*["'`]https:\/\/api\.telegram\.org/;
  assert.equal(realFetchCall.test(source), false);
});
