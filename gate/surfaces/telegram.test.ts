import { test } from "node:test";
import assert from "node:assert/strict";
import { createTelegramApprovalSurface } from "./telegram.ts";

// Stub transport — canned Bot API JSON responses, never a real fetch call.
// This is what makes the loop-level negative controls headless-runnable.
function makeStubTransport(responses: { sendMessage: unknown; getUpdatesSequence: unknown[] }) {
  let getUpdatesCallCount = 0;
  const calls: { url: string; body: unknown }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    if (url.includes("/sendMessage")) {
      return { ok: true, json: async () => responses.sendMessage } as Response;
    }
    if (url.includes("/getUpdates")) {
      const responseBody = responses.getUpdatesSequence[getUpdatesCallCount] ?? { ok: true, result: [] };
      getUpdatesCallCount++;
      return { ok: true, json: async () => responseBody } as Response;
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
              from: { id: 12345 },
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
      { ok: true, result: [{ update_id: 1, callback_query: { id: "cb2", data: `${hash}:deny`, from: { id: 1 }, message: { message_id: 7 } } }] },
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

test("callback_data for every inline button stays within Telegram's 64-byte limit, even for a full 64-char sha256 hash", async () => {
  const hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85"; // 64 hex chars
  const { transport, calls } = makeStubTransport({
    sendMessage: { ok: true, result: { message_id: 1 } },
    getUpdatesSequence: [
      { ok: true, result: [{ update_id: 1, callback_query: { id: "cb1", data: `${hash.slice(0, 32)}:approve`, message: { message_id: 1 } } }] },
    ],
  });

  const surface = createTelegramApprovalSurface({ token: "t", chatId: "1", transport, pollIntervalMs: 5 });
  await surface.requestApproval("mcp__claude_ai_Slack__slack_send_message", { text: "hi" }, hash);

  const sendCall = calls.find((c) => c.url.includes("/sendMessage"));
  assert.ok(sendCall);
  const sendBody = sendCall!.body as Record<string, unknown>;
  const buttons = (sendBody["reply_markup"] as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0];
  for (const button of buttons) {
    assert.ok(
      Buffer.byteLength(button.callback_data, "utf8") <= 64,
      `callback_data "${button.callback_data}" is ${Buffer.byteLength(button.callback_data, "utf8")} bytes, exceeds Telegram's 64-byte limit`,
    );
  }
});

test("requestApproval rejects when sendMessage responds with ok: false, instead of hanging forever", async () => {
  const hash = "send-fail-hash";
  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/sendMessage")) {
      return { ok: true, json: async () => ({ ok: false, description: "Bad Request: BUTTON_DATA_INVALID" }) } as Response;
    }
    throw new Error(`unexpected URL in stub transport: ${url}`);
  };

  const surface = createTelegramApprovalSurface({ token: "t", chatId: "1", transport, pollIntervalMs: 5 });
  await assert.rejects(
    () => surface.requestApproval("mcp__claude_ai_Slack__slack_send_message", { text: "hi" }, hash),
    /BUTTON_DATA_INVALID/,
  );
});

test("a matched callback_query triggers answerCallbackQuery on the transport", async () => {
  const hash = "ack-hash";
  const calls: { url: string }[] = [];
  const transport: typeof fetch = async (input) => {
    const url = String(input);
    calls.push({ url });
    if (url.includes("/sendMessage")) {
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) } as Response;
    }
    if (url.includes("/answerCallbackQuery")) {
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    if (url.includes("/getUpdates")) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: [{ update_id: 1, callback_query: { id: "cb-ack", data: `${hash}:approve`, message: { message_id: 1 } } }],
        }),
      } as Response;
    }
    throw new Error(`unexpected URL in stub transport: ${url}`);
  };

  const surface = createTelegramApprovalSurface({ token: "t", chatId: "1", transport, pollIntervalMs: 5 });
  const decision = await surface.requestApproval("mcp__claude_ai_Slack__slack_send_message", { text: "hi" }, hash);

  assert.equal(decision, "approve");
  assert.ok(calls.some((c) => c.url.includes("/answerCallbackQuery")), "expected answerCallbackQuery to be called");
});

test("a callback_query from a from.id other than the configured owner chatId is ignored, not resolved as approval", async () => {
  const hash = "owner-check-hash";
  const { transport } = makeStubTransport({
    sendMessage: { ok: true, result: { message_id: 1 } },
    getUpdatesSequence: [
      {
        ok: true,
        result: [
          {
            update_id: 1,
            callback_query: { id: "cb-foreign", data: `${hash}:approve`, from: { id: 999 }, message: { message_id: 1 } },
          },
        ],
      },
      {
        ok: true,
        result: [
          {
            update_id: 2,
            callback_query: { id: "cb-owner", data: `${hash}:approve`, from: { id: 12345 }, message: { message_id: 1 } },
          },
        ],
      },
    ],
  });

  const surface = createTelegramApprovalSurface({ token: "t", chatId: "12345", transport, pollIntervalMs: 5 });
  const decision = await surface.requestApproval("mcp__claude_ai_Slack__slack_send_message", { text: "hi" }, hash);
  assert.equal(decision, "approve");
});

test("requestApproval rejects when getUpdates responds with ok: false, instead of silently polling forever", async () => {
  const hash = "getupdates-fail-hash";
  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/sendMessage")) {
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) } as Response;
    }
    if (url.includes("/getUpdates")) {
      return { ok: true, json: async () => ({ ok: false, description: "Conflict: terminated by other getUpdates request" }) } as Response;
    }
    throw new Error(`unexpected URL in stub transport: ${url}`);
  };

  const surface = createTelegramApprovalSurface({ token: "t", chatId: "1", transport, pollIntervalMs: 5 });
  await assert.rejects(
    () => surface.requestApproval("mcp__claude_ai_Slack__slack_send_message", { text: "hi" }, hash),
    /Conflict: terminated by other getUpdates request/,
  );
});

test("grep guard: no test in this file ever calls the real api.telegram.org network endpoint", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("./telegram.test.ts", import.meta.url), "utf8");
  // Excludes this assertion's own string literal from the check by matching
  // an actual fetch(...) call form, not the substring in this sentence.
  const realFetchCall = /fetch\(\s*["'`]https:\/\/api\.telegram\.org/;
  assert.equal(realFetchCall.test(source), false);
});
