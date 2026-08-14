import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TelegramApiError, createTelegramApi } from "./api.ts";

test("a 5xx response with a non-JSON body still surfaces its HTTP status", async () => {
  const fetchFn = (async () => new Response("<html>Bad Gateway</html>", { status: 502 })) as typeof fetch;
  const api = createTelegramApi({ token: "t", chatId: "1" }, fetchFn);
  await assert.rejects(() => api.getUpdates(), (error: unknown) => {
    assert.ok(error instanceof TelegramApiError);
    assert.equal(error.status, 502);
    return true;
  });
});

test("a 409 conflict response surfaces its error_code from the JSON body", async () => {
  const fetchFn = (async () => new Response(
    JSON.stringify({ ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" }),
    { status: 409 },
  )) as typeof fetch;
  const api = createTelegramApi({ token: "t", chatId: "1" }, fetchFn);
  await assert.rejects(() => api.getUpdates(), (error: unknown) => {
    assert.ok(error instanceof TelegramApiError);
    assert.equal(error.status, 409);
    return true;
  });
});

test("a 429 rate-limit response surfaces retry_after converted from seconds to milliseconds", async () => {
  const fetchFn = (async () => new Response(
    JSON.stringify({
      ok: false,
      error_code: 429,
      description: "Too Many Requests: retry after 5",
      parameters: { retry_after: 5 },
    }),
    { status: 429 },
  )) as typeof fetch;
  const api = createTelegramApi({ token: "t", chatId: "1" }, fetchFn);
  await assert.rejects(() => api.getUpdates(), (error: unknown) => {
    assert.ok(error instanceof TelegramApiError);
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, 5_000);
    return true;
  });
});

test("a 429 rate-limit response without parameters leaves retryAfterMs undefined", async () => {
  const fetchFn = (async () => new Response(
    JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests" }),
    { status: 429 },
  )) as typeof fetch;
  const api = createTelegramApi({ token: "t", chatId: "1" }, fetchFn);
  await assert.rejects(() => api.getUpdates(), (error: unknown) => {
    assert.ok(error instanceof TelegramApiError);
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, undefined);
    return true;
  });
});

test("sendVoice uploads the file as multipart form data with a chat_id and voice field", async () => {
  const root = await mkdtemp(join(tmpdir(), "rachel-voice-"));
  const filePath = join(root, "reply.ogg");
  await writeFile(filePath, "ogg bytes");
  let requestUrl = "";
  let requestBody: FormData | undefined;
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    requestUrl = String(url);
    requestBody = init?.body as FormData;
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  }) as typeof fetch;
  const api = createTelegramApi({ token: "t", chatId: "1" }, fetchFn);
  await api.sendVoice("1", filePath);
  assert.match(requestUrl, /\/sendVoice$/);
  assert.ok(requestBody instanceof FormData);
  assert.equal(requestBody.get("chat_id"), "1");
  const voice = requestBody.get("voice");
  assert.ok(voice instanceof Blob);
});

test("sendVoice throws a TelegramApiError when the upload fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "rachel-voice-"));
  const filePath = join(root, "reply.ogg");
  await writeFile(filePath, "ogg bytes");
  const fetchFn = (async () => new Response(
    JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: voice_note invalid" }),
    { status: 400 },
  )) as typeof fetch;
  const api = createTelegramApi({ token: "t", chatId: "1" }, fetchFn);
  await assert.rejects(() => api.sendVoice("1", filePath), (error: unknown) => {
    assert.ok(error instanceof TelegramApiError);
    assert.equal(error.status, 400);
    return true;
  });
});
