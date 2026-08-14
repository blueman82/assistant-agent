import assert from "node:assert/strict";
import { test } from "node:test";
import { TelegramApiError, type TelegramApi } from "./api.ts";
import { createPoller } from "./polling.ts";
import type { TelegramEvent } from "./types.ts";

function stubApi(getUpdates: TelegramApi["getUpdates"]): TelegramApi {
  return {
    async call() { return {}; },
    getUpdates,
    async download() {},
    async sendVoice() {},
  };
}

function recordingSleep(): { sleep: (ms: number, signal: AbortSignal) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return { sleep: async (ms: number) => { calls.push(ms); }, calls };
}

test("network error retries and eventually succeeds", async () => {
  let attempts = 0;
  const api = stubApi(async () => {
    attempts++;
    if (attempts < 3) throw new TypeError("fetch failed");
    return [];
  });
  const { sleep, calls } = recordingSleep();
  const poller = createPoller(api, async () => {}, sleep);
  const offset = await poller.pollOnce();
  assert.equal(attempts, 3);
  assert.deepEqual(calls, [5_000, 5_000]);
  assert.equal(offset, undefined);
});

test("HTTP 5xx failure retries with backoff", async () => {
  let attempts = 0;
  const api = stubApi(async () => {
    attempts++;
    if (attempts < 2) throw new TelegramApiError("Telegram getUpdates failed: HTTP 502", 502);
    return [];
  });
  const { sleep, calls } = recordingSleep();
  const poller = createPoller(api, async () => {}, sleep);
  await poller.pollOnce();
  assert.equal(attempts, 2);
  assert.deepEqual(calls, [5_000]);
});

test("HTTP 409 conflict uses a longer backoff than a generic 5xx", async () => {
  let attempts = 0;
  const api = stubApi(async () => {
    attempts++;
    if (attempts < 2) throw new TelegramApiError("Telegram getUpdates failed: Conflict", 409);
    return [];
  });
  const { sleep, calls } = recordingSleep();
  const poller = createPoller(api, async () => {}, sleep);
  await poller.pollOnce();
  assert.equal(attempts, 2);
  assert.deepEqual(calls, [60_000]);
  assert.ok(calls[0] > 5_000, "409 backoff should exceed the generic transient backoff");
});

test("HTTP 429 with a retry_after value backs off using that exact server-supplied delay", async () => {
  let attempts = 0;
  const api = stubApi(async () => {
    attempts++;
    if (attempts < 2) {
      throw new TelegramApiError("Telegram getUpdates failed: Too Many Requests", 429, 8_000);
    }
    return [];
  });
  const { sleep, calls } = recordingSleep();
  const poller = createPoller(api, async () => {}, sleep);
  await poller.pollOnce();
  assert.equal(attempts, 2);
  assert.deepEqual(calls, [8_000]);
});

test("HTTP 429 without a retry_after value falls back to the default transient backoff", async () => {
  let attempts = 0;
  const api = stubApi(async () => {
    attempts++;
    if (attempts < 2) {
      throw new TelegramApiError("Telegram getUpdates failed: Too Many Requests", 429);
    }
    return [];
  });
  const { sleep, calls } = recordingSleep();
  const poller = createPoller(api, async () => {}, sleep);
  await poller.pollOnce();
  assert.equal(attempts, 2);
  assert.deepEqual(calls, [5_000]);
});

test("HTTP 429 with a malformed (zero/negative/absurd) retry_after falls back to the default backoff", async () => {
  const cases = [0, -5_000, 999_999_999];
  for (const retryAfterMs of cases) {
    let attempts = 0;
    const api = stubApi(async () => {
      attempts++;
      if (attempts < 2) {
        throw new TelegramApiError("Telegram getUpdates failed: Too Many Requests", 429, retryAfterMs);
      }
      return [];
    });
    const { sleep, calls } = recordingSleep();
    const poller = createPoller(api, async () => {}, sleep);
    await poller.pollOnce();
    assert.equal(attempts, 2);
    assert.deepEqual(calls, [5_000], `retryAfterMs=${retryAfterMs} should fall back to the default backoff`);
  }
});

test("HTTP 401 (non-429 client error) is still fatal and propagates immediately without retrying", async () => {
  let attempts = 0;
  const api = stubApi(async () => {
    attempts++;
    throw new TelegramApiError("Telegram getUpdates failed: Unauthorized", 401);
  });
  const { sleep, calls } = recordingSleep();
  const poller = createPoller(api, async () => {}, sleep);
  await assert.rejects(() => poller.pollOnce(), /Unauthorized/);
  assert.equal(attempts, 1);
  assert.equal(calls.length, 0);
});

test("stop() during a 429 backoff wait prevents further retries", async () => {
  let attempts = 0;
  const api = stubApi(async () => {
    attempts++;
    throw new TelegramApiError("Telegram getUpdates failed: Too Many Requests", 429, 8_000);
  });
  let sleepCalls = 0;
  const sleep = async (_ms: number) => {
    sleepCalls++;
    poller.stop();
  };
  const poller = createPoller(api, async () => {}, sleep);
  const offset = await poller.pollOnce();
  assert.equal(offset, undefined);
  assert.equal(sleepCalls, 1);
  assert.equal(attempts, 1, "must not retry again after stop() is called mid-429-backoff");
});

test("non-transient error propagates immediately without retrying", async () => {
  let attempts = 0;
  const api = stubApi(async () => {
    attempts++;
    throw new TelegramApiError("Telegram getUpdates failed: Unauthorized", 401);
  });
  const { sleep, calls } = recordingSleep();
  const poller = createPoller(api, async () => {}, sleep);
  await assert.rejects(() => poller.pollOnce(), /Unauthorized/);
  assert.equal(attempts, 1);
  assert.equal(calls.length, 0);
});

test("stop() during backoff prevents further retries", async () => {
  let attempts = 0;
  const api = stubApi(async () => {
    attempts++;
    throw new TelegramApiError("Telegram getUpdates failed: Conflict", 409);
  });
  let sleepCalls = 0;
  const sleep = async (_ms: number) => {
    sleepCalls++;
    poller.stop();
  };
  const poller = createPoller(api, async () => {}, sleep);
  const offset = await poller.pollOnce();
  assert.equal(offset, undefined);
  assert.equal(sleepCalls, 1);
  assert.equal(attempts, 1, "must not retry again after stop() is called mid-backoff");
});

test("stop() aborts the signal passed to an in-flight backoff wait", async () => {
  const api = stubApi(async () => {
    throw new TelegramApiError("Telegram getUpdates failed: Conflict", 409);
  });
  let observedSignal: AbortSignal | undefined;
  const sleep = async (_ms: number, signal: AbortSignal) => {
    observedSignal = signal;
    poller.stop();
  };
  const poller = createPoller(api, async () => {}, sleep);
  await poller.pollOnce();
  assert.ok(observedSignal?.aborted, "stop() must abort the signal handed to the injected sleep");
});

test("stopped poller returns immediately without calling the API", async () => {
  let attempts = 0;
  const api = stubApi(async () => { attempts++; return []; });
  const poller = createPoller(api, async () => {});
  poller.stop();
  const offset = await poller.pollOnce();
  assert.equal(attempts, 0);
  assert.equal(offset, undefined);
});

test("successful poll routes events through onEvent and advances the offset", async () => {
  const events: TelegramEvent[] = [];
  const api = stubApi(async () => [
    { update_id: 5, message: { message_id: 1, chat: { id: 7 }, text: "hi" } },
  ]);
  const poller = createPoller(api, async (event) => { events.push(event); });
  const offset = await poller.pollOnce();
  assert.equal(offset, 6);
  assert.equal(events.length, 1);
});
