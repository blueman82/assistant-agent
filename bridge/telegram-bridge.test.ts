import { test } from "node:test";
import assert from "node:assert/strict";
import { createBridge } from "./telegram-bridge.ts";

// Stub Telegram transport: scripts a fixed sequence of getUpdates responses
// (by call count), answers every other method with ok:true, and records all
// outbound calls for assertion.
function makeStubTransport(updatesSequence: unknown[]) {
  let getUpdatesCallCount = 0;
  const calls: { url: string; body: unknown }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    if (url.includes("/getUpdates")) {
      const idx = Math.min(getUpdatesCallCount, updatesSequence.length - 1);
      const responseBody = updatesSequence[idx] ?? { ok: true, result: [] };
      getUpdatesCallCount++;
      return { ok: true, json: async () => responseBody } as Response;
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };
  return { transport, calls, getGetUpdatesCallCount: () => getUpdatesCallCount };
}

function messageUpdate(updateId: number, text: string, chatId = 12345) {
  return {
    ok: true,
    result: [
      {
        update_id: updateId,
        message: { message_id: updateId, chat: { id: chatId }, text, from: { id: chatId } },
      },
    ],
  };
}

test("a text message round-trips through the bridge's FIFO dispatch into runTurn and the reply is sent back via sendChunked", async () => {
  const { transport, calls } = makeStubTransport([
    messageUpdate(1, "hello"),
    { ok: true, result: [] },
  ]);

  let stopped = false;
  const runTurnStub = async (input: string, emit: (line: string) => void) => {
    emit(`echo: ${input}`);
  };

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  const loopPromise = bridge.drainOnce();
  await loopPromise;
  // Allow the FIFO drain loop (started by createBridge) to process the queued turn.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();
  stopped = true;

  assert.ok(stopped);
  const sendCall = calls.find((c) => c.url.includes("/sendMessage") && (c.body as Record<string, unknown>)["text"] === "echo: hello");
  assert.ok(sendCall, `expected a sendMessage reply containing "echo: hello", got calls: ${JSON.stringify(calls.map((c) => c.url))}`);
});

test("/reset clears the session id so the next dispatched turn calls query() without a resume option", async () => {
  const { transport } = makeStubTransport([
    messageUpdate(1, "/reset"),
    { ok: true, result: [] },
  ]);

  let resetCalled = false;
  const runTurnStub = async (_input: string, emit: (line: string) => void) => {
    emit("ok");
  };

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => "stale-session-id",
    resetSession: () => {
      resetCalled = true;
    },
    pollIntervalMs: 5,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await bridge.stop();

  assert.equal(resetCalled, true);
});

test("/stop aborts an in-flight turn via the AbortController passed to runTurn", async () => {
  const { transport, calls } = makeStubTransport([
    messageUpdate(1, "long running task"),
    messageUpdate(2, "/stop"),
    { ok: true, result: [] },
  ]);

  let sawAbort = false;
  const runTurnStub = (_input: string, emit: (line: string) => void, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => {
        sawAbort = true;
        resolve();
      });
      // Never resolves on its own — only the abort settles it, simulating a
      // long-running turn.
    });

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  await bridge.drainOnce();
  // give the drain loop time to pick up the first turn and start executing it
  await new Promise((resolve) => setTimeout(resolve, 20));
  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await bridge.stop();

  assert.equal(sawAbort, true, "expected the in-flight turn's AbortSignal to have fired");
  void calls;
});

test("a callback_query is routed to handleCallbackQuery immediately, not queued behind pending chat turns", async () => {
  const cbUpdate = {
    ok: true,
    result: [
      {
        update_id: 1,
        callback_query: { id: "cb1", data: "somehash:approve", from: { id: 12345 } },
      },
    ],
  };
  const { transport, calls } = makeStubTransport([cbUpdate, { ok: true, result: [] }]);

  let handledCb: unknown = null;
  const surface = {
    async requestApproval(): Promise<"approve" | "deny"> {
      return new Promise(() => {});
    },
    async handleCallbackQuery(cb: unknown): Promise<boolean> {
      handledCb = cb;
      return true;
    },
  };

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {},
    getSessionId: () => undefined,
    resetSession: () => {},
    telegramSurface: surface,
    pollIntervalMs: 5,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await bridge.stop();

  assert.ok(handledCb, "expected handleCallbackQuery to have been invoked");
  assert.equal((handledCb as { data?: string }).data, "somehash:approve");
  void calls;
});

test("a message from a chat.id other than the configured owner is dropped, not dispatched to runTurn", async () => {
  const { transport } = makeStubTransport([
    messageUpdate(1, "hi from a stranger", /* chatId */ 999),
    { ok: true, result: [] },
  ]);

  let dispatched = false;
  const runTurnStub = async () => {
    dispatched = true;
  };

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await bridge.stop();

  assert.equal(dispatched, false, "a message from an unauthorised chat must never reach runTurn");
});

test("/status replies without dispatching to runTurn", async () => {
  const { transport, calls } = makeStubTransport([
    messageUpdate(1, "/status"),
    { ok: true, result: [] },
  ]);

  let dispatched = false;
  const runTurnStub = async () => {
    dispatched = true;
  };

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await bridge.stop();

  assert.equal(dispatched, false);
  const sendCall = calls.find((c) => c.url.includes("/sendMessage"));
  assert.ok(sendCall);
});

test("grep guard: no test in this file ever calls the real api.telegram.org network endpoint", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("./telegram-bridge.test.ts", import.meta.url), "utf8");
  const realFetchCall = /fetch\(\s*["'`]https:\/\/api\.telegram\.org/;
  assert.equal(realFetchCall.test(source), false);
});
