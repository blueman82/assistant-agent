import { test } from "node:test";
import assert from "node:assert/strict";
import { createTelegramApprovalSurface } from "./telegram.ts";

// Stub transport — canned Bot API JSON responses, never a real fetch call.
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

test("requestApproval sends an inline-keyboard message and resolves approve when a matching callback is injected via handleCallbackQuery", async () => {
  const hash = "abc123";
  const { transport, calls } = makeStubTransport(() => ({ ok: true, result: { message_id: 42 } }));

  const surface = createTelegramApprovalSurface({ token: "test-token", chatId: "12345", transport });
  const decisionPromise = surface.requestApproval("mcp__claude_ai_Slack__slack_send_message", { text: "hi" }, hash);

  // Give requestApproval a tick to send the message and register the pending hash.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const consumed = await surface.handleCallbackQuery({ id: "cb1", data: `${hash}:approve`, from: { id: 12345 } });
  assert.equal(consumed, true);

  const decision = await decisionPromise;
  assert.equal(decision, "approve");

  const sendCall = calls.find((c) => c.url.includes("/sendMessage"));
  assert.ok(sendCall);
  const sendBody = sendCall!.body as Record<string, unknown>;
  assert.ok((sendBody["reply_markup"] as { inline_keyboard: unknown[] })?.inline_keyboard);
  assert.equal(sendBody["chat_id"], "12345");
});

test("requestApproval resolves deny when a matching deny callback is injected", async () => {
  const hash = "def456";
  const { transport } = makeStubTransport(() => ({ ok: true, result: { message_id: 7 } }));

  const surface = createTelegramApprovalSurface({ token: "t", chatId: "1", transport });
  const decisionPromise = surface.requestApproval("mcp__claude_ai_Slack__slack_send_message", { text: "hi" }, hash);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await surface.handleCallbackQuery({ id: "cb2", data: `${hash}:deny`, from: { id: 1 } });

  const decision = await decisionPromise;
  assert.equal(decision, "deny");
});

test("a callback_query for a DIFFERENT hash prefix is not consumed by this request's answer", async () => {
  const hash = "target-hash";
  const { transport } = makeStubTransport(() => ({ ok: true, result: { message_id: 1 } }));

  const surface = createTelegramApprovalSurface({ token: "t", chatId: "1", transport });
  const decisionPromise = surface.requestApproval("mcp__claude_ai_Slack__slack_send_message", { text: "hi" }, hash);
  await new Promise((resolve) => setTimeout(resolve, 5));

  const consumedOther = await surface.handleCallbackQuery({ id: "cb-other", data: "other-hash:approve", from: { id: 1 } });
  assert.equal(consumedOther, false, "unmatched hash prefix must not be reported as consumed");

  const consumedMine = await surface.handleCallbackQuery({ id: "cb-mine", data: `${hash}:approve`, from: { id: 1 } });
  assert.equal(consumedMine, true);

  const decision = await decisionPromise;
  assert.equal(decision, "approve");
});

test("callback_data for every inline button stays within Telegram's 64-byte limit, even for a full 64-char sha256 hash", async () => {
  const hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85"; // 64 hex chars
  const { transport, calls } = makeStubTransport(() => ({ ok: true, result: { message_id: 1 } }));

  const surface = createTelegramApprovalSurface({ token: "t", chatId: "1", transport });
  const decisionPromise = surface.requestApproval("mcp__claude_ai_Slack__slack_send_message", { text: "hi" }, hash);
  await new Promise((resolve) => setTimeout(resolve, 5));

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

  await surface.handleCallbackQuery({ id: "cb1", data: `${hash.slice(0, 32)}:approve`, from: { id: 1 } });
  await decisionPromise;
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

  const surface = createTelegramApprovalSurface({ token: "t", chatId: "1", transport });
  await assert.rejects(
    () => surface.requestApproval("mcp__claude_ai_Slack__slack_send_message", { text: "hi" }, hash),
    /BUTTON_DATA_INVALID/,
  );
});

test("a matched callback_query triggers answerCallbackQuery on the transport", async () => {
  const hash = "ack-hash";
  const { transport, calls } = makeStubTransport(() => ({ ok: true, result: { message_id: 1 } }));

  const surface = createTelegramApprovalSurface({ token: "t", chatId: "1", transport });
  const decisionPromise = surface.requestApproval("mcp__claude_ai_Slack__slack_send_message", { text: "hi" }, hash);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await surface.handleCallbackQuery({ id: "cb-ack", data: `${hash}:approve`, from: { id: 1 } });
  await decisionPromise;

  assert.ok(calls.some((c) => c.url.includes("/answerCallbackQuery")), "expected answerCallbackQuery to be called");
});

test("a callback_query from a from.id other than the configured owner chatId is not consumed", async () => {
  const hash = "owner-check-hash";
  const { transport } = makeStubTransport(() => ({ ok: true, result: { message_id: 1 } }));

  const surface = createTelegramApprovalSurface({ token: "t", chatId: "12345", transport });
  const decisionPromise = surface.requestApproval("mcp__claude_ai_Slack__slack_send_message", { text: "hi" }, hash);
  await new Promise((resolve) => setTimeout(resolve, 5));

  const consumedForeign = await surface.handleCallbackQuery({ id: "cb-foreign", data: `${hash}:approve`, from: { id: 999 } });
  assert.equal(consumedForeign, false, "a tap from a non-owner from.id must not resolve the approval");

  const consumedOwner = await surface.handleCallbackQuery({ id: "cb-owner", data: `${hash}:approve`, from: { id: 12345 } });
  assert.equal(consumedOwner, true);

  const decision = await decisionPromise;
  assert.equal(decision, "approve");
});

test("an unmatched callback_query is answered 'Expired' so the tapping client's spinner never hangs", async () => {
  const { transport, calls } = makeStubTransport(() => ({ ok: true, result: true }));
  const surface = createTelegramApprovalSurface({ token: "t", chatId: "1", transport });

  const consumed = await surface.handleCallbackQuery({ id: "cb-stray", data: "no-such-hash:approve", from: { id: 1 } });
  assert.equal(consumed, false);

  const ackCall = calls.find((c) => c.url.includes("/answerCallbackQuery"));
  assert.ok(ackCall);
  assert.equal((ackCall!.body as Record<string, unknown>)["text"], "Expired");
});

test("handleCallbackQuery with no pending requests at all still answers gracefully (no throw)", async () => {
  const { transport } = makeStubTransport(() => ({ ok: true, result: true }));
  const surface = createTelegramApprovalSurface({ token: "t", chatId: "1", transport });
  await assert.doesNotReject(() => surface.handleCallbackQuery({ id: "cb-x", data: "whatever:approve", from: { id: 1 } }));
});

test("the surface never calls getUpdates itself — that loop lives in the bridge now", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("./telegram.ts", import.meta.url), "utf8");
  assert.equal(/getUpdates/.test(source), false, "gate/surfaces/telegram.ts must not reference getUpdates");
});

test("grep guard: no test in this file ever calls the real api.telegram.org network endpoint", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("./telegram.test.ts", import.meta.url), "utf8");
  const realFetchCall = /fetch\(\s*["'`]https:\/\/api\.telegram\.org/;
  assert.equal(realFetchCall.test(source), false);
});
