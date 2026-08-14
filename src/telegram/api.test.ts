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
