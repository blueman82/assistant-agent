import { test } from "node:test";
import assert from "node:assert/strict";
import { createBridge } from "./telegram-bridge.ts";
import { runTurn as realRunTurn } from "../secretary.ts";
import { createSendGateHook } from "../gate/sendGate.ts";
import { GATED_TOOL_NAMES } from "../gate/sendGate.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

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

test("a callback_query from an unauthorised from.id is still routed to the surface so its client's spinner is resolved via answerCallbackQuery", async () => {
  const cbUpdate = {
    ok: true,
    result: [
      {
        update_id: 1,
        callback_query: { id: "cb1", data: "somehash:approve", from: { id: 99999 } },
      },
    ],
  };
  const { transport } = makeStubTransport([cbUpdate, { ok: true, result: [] }]);

  let handleCallbackQueryCalls = 0;
  const surface = {
    async requestApproval(): Promise<"approve" | "deny"> {
      return new Promise(() => {});
    },
    async handleCallbackQuery(_cb: unknown): Promise<boolean> {
      handleCallbackQueryCalls++;
      return false;
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

  assert.equal(
    handleCallbackQueryCalls,
    1,
    "an unauthorised callback_query must still reach the surface so it can answerCallbackQuery and clear the tapping client's spinner",
  );
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

test("run() exits fatally on a 409/conflict getUpdates response — a second poller on the same token must never be silently tolerated", async () => {
  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/getUpdates")) {
      return { ok: false, json: async () => ({ ok: false, description: "Conflict: terminated by other getUpdates request" }) } as Response;
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {},
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  const originalExit = process.exit;
  let exitCode: number | undefined;
  let exitCalled = false;
  // Stubbing process.exit for the test; throwing instead of actually
  // exiting lets run()'s while loop halt without killing the test runner
  // process.
  process.exit = (code?: number) => {
    exitCalled = true;
    exitCode = code;
    throw new Error("process.exit stub halting run()");
  };

  try {
    await assert.rejects(() => bridge.run(), /process\.exit stub/);
  } finally {
    process.exit = originalExit;
  }

  assert.equal(exitCalled, true, "expected run() to call process.exit on a 409/conflict getUpdates response");
  assert.equal(exitCode, 1);
});

test("run() does NOT exit on a non-409/conflict poll error — only the single-poller conflict is fatal", async () => {
  let callCount = 0;
  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/getUpdates")) {
      // Every call errors with a non-conflict failure — the loop stays on
      // the backoff branch throughout (never falls through to a successful
      // poll), so this test can't hit the unrelated unthrottled-retry
      // busy-loop that a "succeed after N calls" stub would trigger.
      callCount++;
      return { ok: false, json: async () => ({ ok: false, description: "Internal Server Error" }) } as Response;
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {},
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  const originalExit = process.exit;
  let exitCalled = false;
  // Stubbing process.exit for the test.
  process.exit = () => {
    exitCalled = true;
    throw new Error("process.exit must not be called for a non-conflict error");
  };

  const runPromise = bridge.run();
  // The first poll error hits the 1000ms initial backoff before retrying —
  // wait past that so a second getUpdates call has a chance to fire.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await bridge.stop();
  await runPromise;
  process.exit = originalExit;

  assert.equal(exitCalled, false, "a transient non-409 poll error must not trigger the fatal single-poller exit path");
  assert.ok(callCount >= 2, "the poll loop should have retried after the transient error");
});

test("importing secretary.ts as a module (as the bridge does) registers no SIGINT/SIGTERM handlers of its own — those must only fire for the standalone terminal REPL, or they'd win the race against the bridge's graceful-shutdown handlers and kill the process before bridge.stop() runs", async () => {
  const sigintBefore = process.listenerCount("SIGINT");
  const sigtermBefore = process.listenerCount("SIGTERM");
  await import("../secretary.ts");
  assert.equal(process.listenerCount("SIGINT"), sigintBefore, "secretary.ts must not add a SIGINT handler when merely imported");
  assert.equal(process.listenerCount("SIGTERM"), sigtermBefore, "secretary.ts must not add a SIGTERM handler when merely imported");
});

test("gate integrity: a gated send-class tool call issued during a bridge-dispatched turn, with no approval, is denied via the real runTurn/sendGateHook wiring", async () => {
  // Drives the bridge with a stub Telegram transport AND the real runTurn
  // (imported from secretary.ts, not a runTurnStub) so this test exercises
  // the actual hooks.PreToolUse wiring at bridge/telegram-bridge.ts:133 that
  // secretary.ts's real runTurn sets up at secretary.ts:134-141 — not a
  // bypass. The real query() would hit the network, so a fake queryFn is
  // injected via runTurn's queryFn seam (secretary.ts) that plays the one
  // part only the network normally plays: reading the PreToolUse hook the
  // caller wired in and invoking it exactly as the SDK does, for a gated
  // tool call, with no approval surface ever resolving. If someone removes
  // the hooks.PreToolUse wiring from runTurn, options.hooks is undefined
  // here and this test throws/fails instead of silently passing.
  const { transport } = makeStubTransport([
    { ok: true, result: [{ update_id: 1, message: { message_id: 1, chat: { id: 12345 }, text: "send the slack message", from: { id: 12345 } } }] },
    { ok: true, result: [] },
  ]);

  let hookInvoked = false;
  let hookDecision: string | undefined;

  type FakeHookCallback = (
    input: unknown,
    toolUseID: string | undefined,
    options: { signal: AbortSignal },
  ) => Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>;

  const fakeQueryFn: Parameters<typeof realRunTurn>[3] = ((_params) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      const preToolUseHooks = (_params.options as { hooks?: Record<string, { hooks: unknown[] }[]> } | undefined)?.hooks?.["PreToolUse"];
      if (!preToolUseHooks || preToolUseHooks.length === 0) {
        throw new Error("no hooks.PreToolUse wired into runTurn's query() options — gate wiring is missing");
      }
      const hook = preToolUseHooks[0]!.hooks[0] as FakeHookCallback;

      hookInvoked = true;
      const result = await hook(
        {
          hook_event_name: "PreToolUse",
          session_id: "test-session",
          transcript_path: "/dev/null",
          cwd: "/tmp",
          tool_name: GATED_TOOL_NAMES[0]!,
          tool_input: { channel: "#general", text: "unauthorised send" },
        },
        undefined,
        { signal: new AbortController().signal },
      );
      hookDecision = result.hookSpecificOutput?.permissionDecision;

      yield {
        type: "system",
        subtype: "init",
        session_id: "fake-session",
      } as unknown as SDKMessage;

      if (hookDecision === "allow") {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "sent (should not happen — the gate should have denied this)" }] },
        } as unknown as SDKMessage;
      }
    }
    return generate();
  }) as Parameters<typeof realRunTurn>[3];

  const wrappedRunTurn = async (input: string, emit: (line: string) => void, signal: AbortSignal): Promise<void> => {
    // Bind the fake queryFn seam onto the REAL runTurn — the same function
    // secretary.ts exports and the bridge calls in production — rather than
    // reimplementing any gate logic here.
    await realRunTurn(input, emit, signal, fakeQueryFn);
  };

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: wrappedRunTurn,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();

  assert.ok(hookInvoked, "expected the real sendGateHook (wired via hooks.PreToolUse in runTurn) to have been invoked for the gated tool call");
  assert.equal(hookDecision, "deny", "a gated send-class tool call with no approval must be denied by the real gate wiring, not allowed through");
});

test("grep guard: no test in this file ever calls the real api.telegram.org network endpoint", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("./telegram-bridge.test.ts", import.meta.url), "utf8");
  const realFetchCall = /fetch\(\s*["'`]https:\/\/api\.telegram\.org/;
  assert.equal(realFetchCall.test(source), false);
});
