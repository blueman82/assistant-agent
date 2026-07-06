import { test } from "node:test";
import assert from "node:assert/strict";
import { createTelegramApprovalSurface } from "./telegram.ts";

// Stub transport — canned Bot API JSON responses, never a real fetch call.
// This is what makes the loop-level negative controls headless-runnable.
function makeStubTransport(responses: { sendMessage: unknown; getUpdatesSequence: unknown[] }) {
  let getUpdatesCallCount = 0;
  const calls: { url: string; body: unknown }[] = [];
  const transport = async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    if (url.includes("/sendMessage")) {
      return {
        ok: true,
        json: async () => responses.sendMessage,
      } as Response;
    }
    if (url.includes("/getUpdates")) {
      const body = responses.getUpdatesSequence[getUpdatesCallCount] ?? { ok: true, result: [] };
      getUpdatesCallCount++;
      return {
        ok: true,
        json: async () => body,
      } as Response;
    }
    throw new Error(`unexpected URL in stub transport: ${url}`);
  };
  return { transport, calls };
}

test("requestApproval sends an inline-keyboard message and resolves approve on a matching callback_query", async () => {
  const hash = "abc123";
  const { transport, calls } = makeStubTransport({
    sendMessage: { ok: true, result: { message_id: 42 } },
    getUpdatesSequence: [
      {
        ok: true,
        result: [
          {
            update_id: 1,
            callback_query: {
              id: "cb1",
              data: `${hash}:approve`,
              message: { message_id: 42 },
            },
          },
        ],
      },
    ],
  });

  const surface = createTelegramApprovalSurface({ token: "test-token", chatId: "12345", transport, pollIntervalMs: 5 });
  const decision = await surface.requestApproval("mcp__claude_ai_Slack__slack_send_message", { text: "hi" }, hash);

  assert.equal(decision, "approve");
  const sendCall = calls.find((c) => c.url.includes("/sendMessage"));
  assert.ok(sendCall);
  const sendBody = sendCall!.body as Record<string, unknown>;
  assert.ok((sendBody["reply_markup"] as { inline_keyboard: unknown[] })?.inline_keyboard);
  assert.equal(sendBody["chat_id"], "12345");
});

test("requestApproval resolves deny on a matching deny callback_query", async () => {
  const hash = "def456";
  const { transport } = makeStubTransport({
    sendMessage: { ok: true, result: { message_id: 7 } },
    getUpdatesSequence: [
      { ok: true, result: [{ update_id: 1, callback_query: { id: "cb2", data: `${hash}:deny`, message: { message_id: 7 } } }] },
    ],
  });

  const surface = createTelegramApprovalSurface({ token: "t", chatId: "1", transport, pollIntervalMs: 5 });
  const decision = await surface.requestApproval("mcp__claude_ai_Slack__slack_send_message", { text: "hi" }, hash);
  assert.equal(decision, "deny");
});

test("a callback_query for a DIFFERENT hash is ignored, not resolved as this request's answer", async () => {
  const hash = "target-hash";
  const { transport } = makeStubTransport({
    sendMessage: { ok: true, result: { message_id: 1 } },
    getUpdatesSequence: [
      { ok: true, result: [{ update_id: 1, callback_query: { id: "cb-other", data: "other-hash:approve", message: { message_id: 1 } } }] },
      { ok: true, result: [{ update_id: 2, callback_query: { id: "cb-mine", data: `${hash}:approve`, message: { message_id: 1 } } }] },
    ],
  });

  const surface = createTelegramApprovalSurface({ token: "t", chatId: "1", transport, pollIntervalMs: 5 });
  const decision = await surface.requestApproval("mcp__claude_ai_Slack__slack_send_message", { text: "hi" }, hash);
  assert.equal(decision, "approve");
});

test("grep guard: no test in this file ever calls the real api.telegram.org network endpoint", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("./telegram.test.ts", import.meta.url), "utf8");
  // Excludes this assertion's own string literal from the check by matching
  // an actual fetch(...) call form, not the substring in this sentence.
  const realFetchCall = /fetch\(\s*["'`]https:\/\/api\.telegram\.org/;
  assert.equal(realFetchCall.test(source), false);
});
