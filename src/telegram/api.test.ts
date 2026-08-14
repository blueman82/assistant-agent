import assert from "node:assert/strict";
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
