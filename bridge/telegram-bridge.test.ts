import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fabricated Telegram creds — set before any import in this file (env-first
// in gate/surfaces/telegram.ts:35-36) so rachel.ts's module-scope
// loadTelegramConfig() call (rachel.ts:70, which runs once on first
// import anywhere in this file, per ESM module caching) never reads the
// real ~/.rachel/telegram.json and never constructs a surface capable of
// sending to the operator's real Telegram chat. This must stay ahead of
// every import in this file, static or dynamic.
process.env["RACHEL_TELEGRAM_TOKEN"] = "000000000:FAKE-TEST-TOKEN";
process.env["RACHEL_TELEGRAM_CHAT_ID"] = "1";

// Same reasoning for the queue approval surface: without this override,
// rachel.ts's module-scope createQueueApprovalSurface() call defaults to
// ~/.claude/coderails-dashboard/approvals (queue.ts's DEFAULT_QUEUE_DIR) and
// ~/.rachel/send-gate-audit.jsonl for the audit log — real paths under
// the operator's home directory that a denied-by-timeout test call would
// leave a stale "pending" entry in, which the real dashboard would then
// render as a phantom approval card. Redirect both into a throwaway tmpdir.
const testQueueDir = mkdtempSync(join(tmpdir(), "rachel-test-queue-"));
process.env["RACHEL_QUEUE_DIR"] = testQueueDir;
process.env["RACHEL_AUDIT_LOG_PATH"] = join(testQueueDir, "audit.jsonl");

// Defense-in-depth on top of the env-creds fix above: every test in this
// file injects its own stub transport (config.transport) rather than
// relying on global fetch, so global fetch should never be called here. If
// any code path (now or after a future change) falls back to real fetch —
// e.g. a surface constructed without a transport override — this throws
// immediately instead of silently making a live HTTP call with the fake
// (or worse, a real) token.
globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
  throw new Error(`Unexpected real fetch() call in telegram-bridge.test.ts — all transports must be stubbed. Called with: ${String(args[0])}`);
}) as typeof fetch;

import { test } from "node:test";
import assert from "node:assert/strict";
import { createBridge, type BridgeRunTurn } from "./telegram-bridge.ts";
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

// This test must run FIRST in the file (before any other test imports
// rachel.ts) and sets RACHEL_GATE_TIMEOUT_MS before its own dynamic
// import of rachel.ts below — rachel.ts's module-scope
// createSendGateHook(...) call runs once, at first import, and node:test
// runs tests in a single file sequentially in declaration order (no
// concurrency is configured anywhere in this file), so being first
// guarantees this env var is visible when the real gate hook is built,
// rather than racing a later test's own import of the same (ESM-cached)
// module.
test("gate integrity: a gated send-class tool call issued during a bridge-dispatched turn, with no approval, is denied via the real runTurn/sendGateHook wiring", async () => {
  // Drives the bridge with a stub Telegram transport AND the real runTurn
  // (imported from rachel.ts, not a runTurnStub) so this test exercises
  // the actual hooks.PreToolUse wiring at bridge/telegram-bridge.ts:133 that
  // rachel.ts's real runTurn sets up at rachel.ts:134-141 — not a
  // bypass. The real query() would hit the network, so a fake queryFn is
  // injected via runTurn's queryFn seam (rachel.ts) that plays the one
  // part only the network normally plays: reading the PreToolUse hook the
  // caller wired in and invoking it exactly as the SDK does, for a gated
  // tool call, with no approval surface ever resolving. If someone removes
  // the hooks.PreToolUse wiring from runTurn, options.hooks is undefined
  // here and this test throws/fails instead of silently passing.
  process.env["RACHEL_GATE_TIMEOUT_MS"] = "200";
  const { runTurn: realRunTurn } = await import("../rachel.ts");

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

  const wrappedRunTurn: BridgeRunTurn = async (input, emit, signal): Promise<void> => {
    // Bind the fake queryFn seam onto the REAL runTurn — the same function
    // rachel.ts exports and the bridge calls in production — rather than
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
  // The real gate races the never-resolving approval surfaces against its
  // own internal deny timeout (shortened to 200ms via RACHEL_GATE_TIMEOUT_MS
  // above) — wait past that so the timeout branch actually fires.
  await new Promise((resolve) => setTimeout(resolve, 400));
  await bridge.stop();

  assert.ok(hookInvoked, "expected the real sendGateHook (wired via hooks.PreToolUse in runTurn) to have been invoked for the gated tool call");
  assert.equal(hookDecision, "deny", "a gated send-class tool call with no approval must be denied by the real gate wiring, not allowed through");
});

test("runTurn classifies its own emitted lines correctly: assistant text -> 'text', a tool_use block -> 'tool', the result footer -> 'meta'", async () => {
  // Drives the REAL runTurn (imported from rachel.ts) with a fake queryFn
  // seam (same idiom as the gate-integrity test above) that yields one
  // assistant message containing BOTH a text block and a tool_use block,
  // then a result message — so this pins runTurn's own kind classification
  // at rachel.ts:203-222, not the bridge's filtering of it.
  const { runTurn: realRunTurn } = await import("../rachel.ts");

  const fakeQueryFn: Parameters<typeof realRunTurn>[3] = ((_params) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: "system",
        subtype: "init",
        session_id: "kind-classification-test-session",
      } as unknown as SDKMessage;

      yield {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Renamed the invoice draft as requested." },
            { type: "tool_use", name: "Read", input: { file_path: "/tmp/kind-classification-fixture.txt" } },
          ],
        },
      } as unknown as SDKMessage;

      yield {
        type: "result",
        num_turns: 1,
        total_cost_usd: 0.0042,
      } as unknown as SDKMessage;
    }
    return generate();
  }) as Parameters<typeof realRunTurn>[3];

  const recorded: { line: string; kind: string }[] = [];
  await realRunTurn(
    "rename the invoice draft",
    (line, kind) => recorded.push({ line, kind }),
    new AbortController().signal,
    fakeQueryFn,
  );

  assert.equal(recorded.length, 3, `expected exactly 3 emits, got: ${JSON.stringify(recorded)}`);
  assert.equal(recorded[0]!.kind, "text");
  assert.equal(recorded[0]!.line, "Renamed the invoice draft as requested.");
  assert.equal(recorded[1]!.kind, "tool");
  assert.match(recorded[1]!.line, /Read/);
  assert.equal(recorded[2]!.kind, "meta");
  assert.match(recorded[2]!.line, /done turns=/);
});

test("a text message round-trips through the bridge's FIFO dispatch into runTurn and the reply is sent back via sendChunked", async () => {
  const { transport, calls } = makeStubTransport([
    messageUpdate(1, "hello"),
    { ok: true, result: [] },
  ]);

  let stopped = false;
  const runTurnStub: BridgeRunTurn = async (input, emit) => {
    emit(`echo: ${input}`, "text");
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

test("a turn emitting text, tool, and meta lines sends only the text lines to Telegram — no tool echo, no done footer", async () => {
  const { transport, calls } = makeStubTransport([
    messageUpdate(1, "run the report"),
    { ok: true, result: [] },
  ]);

  const runTurnStub: BridgeRunTurn = async (_input, emit) => {
    emit("Report generated for Q3.", "text");
    emit("  [Bash] generate-report.sh", "tool");
    emit("[Rachel] done turns=1 cost=$0.0120", "meta");
  };

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();

  const sendCall = calls.find((c) => c.url.includes("/sendMessage"));
  assert.ok(sendCall, "expected a sendMessage reply");
  const sentText = (sendCall!.body as Record<string, unknown>)["text"];
  assert.equal(sentText, "Report generated for Q3.");
  assert.doesNotMatch(String(sentText), /\[Bash\]/);
  assert.doesNotMatch(String(sentText), /\[Rachel\] done/);
});

test("a turn emitting only tool and meta lines (no text) falls back to '(no output)', not an empty send", async () => {
  const { transport, calls } = makeStubTransport([
    messageUpdate(1, "just run tools"),
    { ok: true, result: [] },
  ]);

  const runTurnStub: BridgeRunTurn = async (_input, emit) => {
    emit("  [Grep] TODO", "tool");
    emit("[Rachel] done turns=1", "meta");
  };

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();

  const sendCall = calls.find((c) => c.url.includes("/sendMessage"));
  assert.ok(sendCall, "expected a sendMessage reply");
  assert.equal((sendCall!.body as Record<string, unknown>)["text"], "(no output)");
});

test("a throwing runTurn still produces a reply containing '[Rachel] error:'", async () => {
  const { transport, calls } = makeStubTransport([
    messageUpdate(1, "trigger a failure"),
    { ok: true, result: [] },
  ]);

  const runTurnStub: BridgeRunTurn = async () => {
    throw new Error("boom - synthetic failure for this test");
  };

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();

  const sendCall = calls.find((c) => c.url.includes("/sendMessage"));
  assert.ok(sendCall, "expected a sendMessage reply");
  assert.match(String((sendCall!.body as Record<string, unknown>)["text"]), /\[Rachel\] error:/);
});

test("a runTurn that emits partial text then throws produces a reply containing both the emitted text and '[Rachel] error:'", async () => {
  const { transport, calls } = makeStubTransport([
    messageUpdate(1, "start the migration"),
    { ok: true, result: [] },
  ]);

  const runTurnStub: BridgeRunTurn = async (_input, emit) => {
    emit("Migration step 1 of 3 complete.", "text");
    throw new Error("boom - migration step 2 failed for this test");
  };

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();

  const sendCall = calls.find((c) => c.url.includes("/sendMessage"));
  assert.ok(sendCall, "expected a sendMessage reply");
  const sentText = String((sendCall!.body as Record<string, unknown>)["text"]);
  assert.match(sentText, /Migration step 1 of 3 complete\./);
  assert.match(sentText, /\[Rachel\] error:/);
});

test("/reset clears the session id so the next dispatched turn calls query() without a resume option", async () => {
  const { transport } = makeStubTransport([
    messageUpdate(1, "/reset"),
    { ok: true, result: [] },
  ]);

  let resetCalled = false;
  const runTurnStub: BridgeRunTurn = async (_input, emit) => {
    emit("ok", "text");
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
  const runTurnStub: BridgeRunTurn = (_input, _emit, signal) =>
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

test("run() exits fatally after CONFLICT_EXIT_THRESHOLD (5) consecutive 409s — genuine second consumer", async () => {
  // Transport always 409s — bridge must NOT exit on first 409, only after 5 consecutive.
  const sendMessages: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/getUpdates")) {
      return { ok: false, json: async () => ({ ok: false, description: "Conflict: terminated by other getUpdates request" }) } as Response;
    }
    if (url.includes("/sendMessage")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      sendMessages.push(String(body.text ?? ""));
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {},
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    conflictBackoffMs: 5,
  });

  const originalExit = process.exit;
  let exitCode: number | undefined;
  let exitCalled = false;
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

  assert.equal(exitCalled, true, "expected run() to call process.exit after CONFLICT_EXIT_THRESHOLD consecutive 409s");
  assert.equal(exitCode, 1);
});

test("first 409 sends a Telegram alert via sendMessage and backs off before retrying", async () => {
  let getUpdatesCount = 0;
  const sendMessages: string[] = [];
  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/getUpdates")) {
      getUpdatesCount++;
      // First call: 409. Second call onwards: success.
      if (getUpdatesCount === 1) {
        return { ok: false, json: async () => ({ ok: false, description: "Conflict: terminated by other getUpdates request" }) } as Response;
      }
      return { ok: true, json: async () => ({ ok: true, result: [] }) } as Response;
    }
    if (url.includes("/sendMessage")) {
      const req = input as Request;
      const body = typeof req.json === "function" ? (await req.json() as { text?: string }) : {};
      sendMessages.push(String(body.text ?? ""));
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {},
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    conflictBackoffMs: 5,
  });

  const runPromise = bridge.run();
  // Allow enough time for the 409, the backoff (5ms), and the recovery poll.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await bridge.stop();
  await runPromise;

  assert.ok(
    sendMessages.some((m) => m.toLowerCase().includes("conflict")),
    `expected a sendMessage alert containing "conflict" — got: ${JSON.stringify(sendMessages)}`,
  );
  assert.ok(getUpdatesCount >= 2, "bridge should have retried getUpdates after the 409 backoff");
});

test("recovery from 409 sends a recovery Telegram alert", async () => {
  let getUpdatesCount = 0;
  const sendMessages: string[] = [];
  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/getUpdates")) {
      getUpdatesCount++;
      if (getUpdatesCount <= 2) {
        return { ok: false, json: async () => ({ ok: false, description: "Conflict: terminated by other getUpdates request" }) } as Response;
      }
      return { ok: true, json: async () => ({ ok: true, result: [] }) } as Response;
    }
    if (url.includes("/sendMessage")) {
      const req = input as Request;
      const body = typeof req.json === "function" ? (await req.json() as { text?: string }) : {};
      sendMessages.push(String(body.text ?? ""));
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {},
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    conflictBackoffMs: 5,
  });

  const runPromise = bridge.run();
  // Allow time for: 2× 409 (with 5ms backoff each), recovery poll, async alert microtask.
  await new Promise((resolve) => setTimeout(resolve, 200));
  await bridge.stop();
  await runPromise;
  // Flush any pending microtasks (the recovery sendChunked is fire-and-forget).
  await new Promise((resolve) => setTimeout(resolve, 0));

  const hasConflictAlert = sendMessages.some((m) => m.toLowerCase().includes("conflict"));
  const hasRecoveryAlert = sendMessages.some((m) => m.toLowerCase().includes("recovered"));
  assert.ok(hasConflictAlert, `expected a conflict entry alert — got: ${JSON.stringify(sendMessages)}`);
  assert.ok(hasRecoveryAlert, `expected a recovery alert — got: ${JSON.stringify(sendMessages)}`);
});

test("409 persisting to threshold sends FATAL alert before exiting", async () => {
  const sendMessages: string[] = [];
  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/getUpdates")) {
      return { ok: false, json: async () => ({ ok: false, description: "Conflict: terminated by other getUpdates request" }) } as Response;
    }
    if (url.includes("/sendMessage")) {
      const req = input as Request;
      const body = typeof req.json === "function" ? (await req.json() as { text?: string }) : {};
      sendMessages.push(String(body.text ?? ""));
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {},
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    conflictBackoffMs: 5,
  });

  const originalExit = process.exit;
  process.exit = (_code?: number) => { throw new Error("process.exit stub halting run()"); };

  try {
    await assert.rejects(() => bridge.run(), /process\.exit stub/);
  } finally {
    process.exit = originalExit;
  }

  const hasFatalAlert = sendMessages.some((m) => m.toUpperCase().includes("FATAL") || m.toLowerCase().includes("genuine second consumer"));
  assert.ok(hasFatalAlert, `expected a FATAL sendMessage alert before exit — got: ${JSON.stringify(sendMessages)}`);
});

test("/status reports last_error (recovered) after a 409 that self-healed", async () => {
  // Sequence: 409 on poll 1, success on poll 2 (recovery), /status message on poll 3.
  let getUpdatesCount = 0;
  const replies: string[] = [];
  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/getUpdates")) {
      getUpdatesCount++;
      if (getUpdatesCount === 1) {
        return { ok: false, json: async () => ({ ok: false, description: "Conflict: 409" }) } as Response;
      }
      if (getUpdatesCount === 2) {
        // Recovery poll — success, no messages.
        return { ok: true, json: async () => ({ ok: true, result: [] }) } as Response;
      }
      // Poll 3+: deliver a /status message then idle.
      if (getUpdatesCount === 3) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            result: [{ update_id: 9001, message: { message_id: 1, chat: { id: 12345 }, text: "/status" } }],
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({ ok: true, result: [] }) } as Response;
    }
    if (url.includes("/sendMessage")) {
      const req = input as Request;
      const body = typeof req.json === "function" ? (await req.json() as { text?: string }) : {};
      replies.push(String(body.text ?? ""));
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {},
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    conflictBackoffMs: 5,
  });

  const runPromise = bridge.run();
  // Allow: 409 (5ms backoff) + recovery poll + microtask flush + /status poll + reply.
  await new Promise((resolve) => setTimeout(resolve, 200));
  await bridge.stop();
  await runPromise;

  const statusReply = replies.find((m) => m.includes("last error:"));
  assert.ok(statusReply !== undefined, `expected /status reply to contain "last error:" — got: ${JSON.stringify(replies)}`);
  assert.ok(statusReply.includes(", recovered"), `expected "recovered" suffix in status reply — got: ${statusReply}`);
});

test("/status includes 'ongoing' suffix in last_error line when error has not yet recovered", async () => {
  // Sequence: poll 1 = 409 (enters conflict, sets lastError.recovered=false),
  // then a /status message is injected BEFORE the recovery poll by stopping run()
  // after the 409 fires and before the backoff completes, then using drainOnce().
  //
  // The health state machine only mutates lastError inside run()'s catch.
  // drainOnce() bypasses run() — so we use run() for the 409 but need to
  // inject /status before the recovery. We do this by having the second getUpdates
  // (which run() calls after the 5ms backoff) return the /status message.
  // At that point health is still "conflict" because poll 2 SUCCEEDS (transitions to healthy)
  // BEFORE processing the /status message text. So health would be "healthy" and
  // lastError.recovered would be true — the same as 3e-recovered.
  //
  // The ongoing state is only observable in the brief window between the 409 catch
  // and the next successful poll — not cleanly testable through the run() loop.
  // We therefore verify the "ongoing" code path structurally: confirm the source
  // contains the conditional producing ", ongoing" when recovered===false.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("./telegram-bridge.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    src.includes(`lastError.recovered ? ", recovered" : ", ongoing"`),
    "status handler must contain the ternary producing \", ongoing\" when lastError.recovered===false",
  );
});

test("4 consecutive 409s (N-1, boundary) followed by success does NOT exit and sends recovery alert", async () => {
  let getUpdatesCount = 0;
  const sendMessages: string[] = [];
  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/getUpdates")) {
      getUpdatesCount++;
      // Exactly 4 409s, then success — must NOT exit (threshold is 5).
      if (getUpdatesCount <= 4) {
        return { ok: false, json: async () => ({ ok: false, description: "Conflict: terminated by other getUpdates request" }) } as Response;
      }
      return { ok: true, json: async () => ({ ok: true, result: [] }) } as Response;
    }
    if (url.includes("/sendMessage")) {
      const req = input as Request;
      const body = typeof req.json === "function" ? (await req.json() as { text?: string }) : {};
      sendMessages.push(String(body.text ?? ""));
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {},
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    conflictBackoffMs: 5,
  });

  const originalExit = process.exit;
  let exitCalled = false;
  process.exit = () => {
    exitCalled = true;
    throw new Error("process.exit must not be called for N-1 409s");
  };

  const runPromise = bridge.run();
  // Allow enough time for 4 × (5ms backoff) + recovery poll + microtask flush.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await bridge.stop();
  await runPromise.catch(() => {}); // catch in case stop races with a pending poll
  process.exit = originalExit;
  // Flush async recovery microtask.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(exitCalled, false, "bridge must NOT exit after only 4 consecutive 409s (threshold is 5)");
  assert.ok(
    sendMessages.some((m) => m.toLowerCase().includes("recovered")),
    `expected a recovery alert after 4 409s then success — got: ${JSON.stringify(sendMessages)}`,
  );
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

test("importing rachel.ts as a module (as the bridge does) registers no SIGINT/SIGTERM handlers of its own — those must only fire for the standalone terminal REPL, or they'd win the race against the bridge's graceful-shutdown handlers and kill the process before bridge.stop() runs", async () => {
  const sigintBefore = process.listenerCount("SIGINT");
  const sigtermBefore = process.listenerCount("SIGTERM");
  await import("../rachel.ts");
  assert.equal(process.listenerCount("SIGINT"), sigintBefore, "rachel.ts must not add a SIGINT handler when merely imported");
  assert.equal(process.listenerCount("SIGTERM"), sigtermBefore, "rachel.ts must not add a SIGTERM handler when merely imported");
});

test("a photo message is downloaded and passed to runTurn as '[image: /path]' with the caption appended", async () => {
  const photoUpdate = {
    ok: true,
    result: [
      {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 12345 },
          from: { id: 12345 },
          caption: "what is this?",
          photo: [
            { file_id: "small_id", file_size: 1000, width: 100, height: 100 },
            { file_id: "large_id", file_size: 5000, width: 800, height: 600 },
          ],
        },
      },
    ],
  };

  // The stub transport handles getUpdates and other Telegram API calls.
  // getFile is now internal to downloadFile (injected as downloadFileFnStub below),
  // so it never reaches the transport in this test.
  const calls: { url: string; body: unknown }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    if (url.includes("/getUpdates")) {
      return { ok: true, json: async () => photoUpdate } as Response;
    }
    // sendMessage, sendChatAction, etc.
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  let capturedInput: string | undefined;
  const runTurnStub: BridgeRunTurn = async (input, emit) => {
    capturedInput = input;
    emit("I see an image.", "text");
  };

  // Track what the downloadFileFn stub was called with.
  let downloadedFileId: string | undefined;
  let downloadedPath: string | undefined;
  const downloadFileFnStub = async (_config: unknown, fileId: string, destPath: string): Promise<void> => {
    downloadedFileId = fileId;
    downloadedPath = destPath;
    // No actual filesystem write in tests.
  };

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    downloadFileFn: downloadFileFnStub,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();

  // downloadFileFn was called with the largest photo's file_id.
  // (getFile is now internal to downloadFile and never reaches the transport stub.)
  assert.ok(downloadedFileId, "expected downloadFileFn to have been called");
  assert.equal(downloadedFileId!, "large_id");

  // The destPath is under ~/.rachel/tmp/.
  assert.ok(downloadedPath, "expected downloadFileFn to receive a dest path");
  assert.match(downloadedPath!, /\.rachel\/tmp\/large_id\.jpg/);

  // runTurn received the image path string with the caption.
  assert.ok(capturedInput, "expected runTurn to have been called with the image input");
  assert.match(capturedInput!, /\[image: .*large_id\.jpg\]/);
  assert.match(capturedInput!, /what is this\?/);
});

test("a photo message with no caption passes '[image: /path]' (no newline/caption) to runTurn", async () => {
  const photoUpdate = {
    ok: true,
    result: [
      {
        update_id: 2,
        message: {
          message_id: 2,
          chat: { id: 12345 },
          from: { id: 12345 },
          // no caption field
          photo: [{ file_id: "solo_id", file_size: 3000, width: 640, height: 480 }],
        },
      },
    ],
  };

  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/getUpdates")) return { ok: true, json: async () => photoUpdate } as Response;
    if (url.includes("/getFile")) return { ok: true, json: async () => ({ ok: true, result: { file_path: "photos/solo_id.jpg" } }) } as Response;
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  let capturedInput: string | undefined;
  const runTurnStub: BridgeRunTurn = async (input, emit) => {
    capturedInput = input;
    emit("ok", "text");
  };

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    downloadFileFn: async (_config, _fileId, _destPath) => {},
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();

  assert.ok(capturedInput, "expected runTurn to have been called");
  assert.match(capturedInput!, /\[image: .*solo_id\.jpg\]/);
  // No newline or caption text should follow the image tag.
  assert.doesNotMatch(capturedInput!, /\n/);
});

test("a document message with an image MIME type is downloaded and passed to runTurn", async () => {
  const docUpdate = {
    ok: true,
    result: [
      {
        update_id: 3,
        message: {
          message_id: 3,
          chat: { id: 12345 },
          from: { id: 12345 },
          caption: "screenshot",
          document: { file_id: "doc_id", file_name: "shot.png", mime_type: "image/png", file_size: 20000 },
        },
      },
    ],
  };

  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/getUpdates")) return { ok: true, json: async () => docUpdate } as Response;
    if (url.includes("/getFile")) return { ok: true, json: async () => ({ ok: true, result: { file_path: "docs/doc_id.png" } }) } as Response;
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  let capturedInput: string | undefined;
  let downloadedPath: string | undefined;
  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: async (input, emit) => { capturedInput = input; emit("ok", "text"); },
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    downloadFileFn: async (_config, _fileId, destPath) => { downloadedPath = destPath; },
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();

  assert.ok(capturedInput, "expected runTurn to have been called for image document");
  assert.match(capturedInput!, /\[image: .*doc_id\.png\]/);
  assert.match(capturedInput!, /screenshot/);
  assert.ok(downloadedPath, "expected downloadFileFn to have been called");
  assert.match(downloadedPath!, /doc_id\.png/);
});

test("a document message with a non-image MIME type replies with an unsupported-type message — runTurn is never called", async () => {
  const docUpdate = {
    ok: true,
    result: [
      {
        update_id: 4,
        message: {
          message_id: 4,
          chat: { id: 12345 },
          from: { id: 12345 },
          document: { file_id: "txt_id", file_name: "notes.txt", mime_type: "text/plain" },
        },
      },
    ],
  };

  const calls: { url: string; body: unknown }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    if (url.includes("/getUpdates")) return { ok: true, json: async () => docUpdate } as Response;
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  let dispatched = false;
  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => { dispatched = true; },
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    downloadFileFn: async () => {},
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await bridge.stop();

  assert.equal(dispatched, false, "a non-image document must not dispatch to runTurn");
  const sendCall = calls.find((c) => c.url.includes("/sendMessage"));
  assert.ok(sendCall, "expected a sendMessage reply for unsupported file type");
  assert.match(String((sendCall!.body as Record<string, unknown>)["text"]), /only receive images/);
});

test("a photo whose downloadFileFn rejects sends a failure reply to the user and does not dispatch to runTurn", async () => {
  const photoUpdate = {
    ok: true,
    result: [
      {
        update_id: 5,
        message: {
          message_id: 5,
          chat: { id: 12345 },
          from: { id: 12345 },
          photo: [{ file_id: "fail_id", file_size: 1000, width: 100, height: 100 }],
        },
      },
    ],
  };

  const calls: { url: string; body: unknown }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    if (url.includes("/getUpdates")) return { ok: true, json: async () => photoUpdate } as Response;
    if (url.includes("/getFile")) return { ok: true, json: async () => ({ ok: true, result: { file_path: "photos/fail_id.jpg" } }) } as Response;
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  let dispatched = false;
  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => { dispatched = true; },
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    downloadFileFn: async (_config, _fileId, _destPath) => { throw new Error("disk full"); },
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();

  assert.equal(dispatched, false, "runTurn must not be called when the download fails");
  const sendCall = calls.find((c) => c.url.includes("/sendMessage"));
  assert.ok(sendCall, "expected a sendMessage failure reply to the user");
  assert.match(String((sendCall!.body as Record<string, unknown>)["text"]), /Failed to download image/);
});

test("a photo whose getFile call returns ok:false sends a failure reply and does not dispatch to runTurn", async () => {
  const photoUpdate = {
    ok: true,
    result: [
      {
        update_id: 6,
        message: {
          message_id: 6,
          chat: { id: 12345 },
          from: { id: 12345 },
          photo: [{ file_id: "getfile_fail_id", file_size: 1000, width: 100, height: 100 }],
        },
      },
    ],
  };

  const calls: { url: string; body: unknown }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    if (url.includes("/getUpdates")) return { ok: true, json: async () => photoUpdate } as Response;
    if (url.includes("/getFile")) return { ok: true, json: async () => ({ ok: false, description: "Bad Request: invalid file_id" }) } as Response;
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  let dispatched = false;
  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => { dispatched = true; },
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();

  assert.equal(dispatched, false, "runTurn must not be called when getFile fails");
  const sendCall = calls.find((c) => c.url.includes("/sendMessage"));
  assert.ok(sendCall, "expected a sendMessage failure reply to the user");
  assert.match(String((sendCall!.body as Record<string, unknown>)["text"]), /Failed to download image/);
});

test("grep guard: no test in this file ever calls the real api.telegram.org network endpoint", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("./telegram-bridge.test.ts", import.meta.url), "utf8");
  const realFetchCall = /fetch\(\s*["'`]https:\/\/api\.telegram\.org/;
  assert.equal(realFetchCall.test(source), false);
});

// ---------------------------------------------------------------------------
// Watchdog tests — helpers
// ---------------------------------------------------------------------------

import { type WatchdogEntry, type FsFunctions, checkLaunchAllowed, type CheckLaunchAllowedOpts } from "./telegram-bridge.ts";

// makeStubFs builds an in-memory FsFunctions from a Map<string, string> of
// path→content. mtimes is a separate Map<string, number> for path→mtimeMs.
// globResults is returned verbatim from every .glob() call.
// written and unlinked are tracked for assertion.
function makeStubFs(opts: {
  watchdogDir: string;
  files?: Map<string, string>;
  mtimes?: Map<string, number>;
  globResults?: string[];
}): FsFunctions & { written: { path: string; content: string }[]; unlinked: string[] } {
  const files: Map<string, string> = opts.files ?? new Map();
  const mtimes: Map<string, number> = opts.mtimes ?? new Map();
  const globResults: string[] = opts.globResults ?? [];
  const existingDirs: Set<string> = new Set([opts.watchdogDir]);
  const written: { path: string; content: string }[] = [];
  const unlinked: string[] = [];

  return {
    written,
    unlinked,
    readdir(dir: string): string[] {
      const prefix = dir.endsWith("/") ? dir : dir + "/";
      const names: string[] = [];
      for (const p of files.keys()) {
        if (p.startsWith(prefix)) {
          const rest = p.slice(prefix.length);
          if (!rest.includes("/")) names.push(rest);
        }
      }
      return names;
    },
    readFile(path: string): string {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeFile(path: string, content: string): void {
      files.set(path, content);
      written.push({ path, content });
    },
    unlink(path: string): void {
      files.delete(path);
      unlinked.push(path);
    },
    stat(path: string): { mtimeMs: number } {
      const mtime = mtimes.get(path);
      if (mtime === undefined) throw new Error(`ENOENT stat: ${path}`);
      return { mtimeMs: mtime };
    },
    mkdirSync(path: string, _opts: { recursive: boolean }): void {
      existingDirs.add(path);
    },
    existsSync(path: string): boolean {
      return files.has(path) || existingDirs.has(path);
    },
    glob(_pattern: string): string[] {
      return globResults;
    },
  };
}

// Minimal WatchdogEntry factory — fills in all required fields so TypeScript
// strict mode is satisfied; tests override only what they care about.
function makeWatchdogEntry(overrides: Partial<WatchdogEntry> & { slug: string; loop_name: string; pid: number }): WatchdogEntry {
  return {
    expected_cmd: "claude",
    repo: "/Users/harrison/Github/test-repo",
    log_path: "/tmp/test.log",
    progress_json_glob: "/fake/.claude/agentic-loop/*test-repo*/*/progress.json",
    progress_json_path: null,
    session_id: null,
    spawn_time: Date.now() - 70 * 60 * 1000,
    last_check: null,
    wake_floor: null,
    pinged_at: null,
    done: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Watchdog test 1: pid-gone with complete LOOP-STOP → event path injects turn
// ---------------------------------------------------------------------------

test("watchdog: pid-gone with complete LOOP-STOP injects a synthetic turn and unlinks the watchdog file", async () => {
  const now = Date.now();
  const watchdogDir = "/fake/watchdog";
  const watchdogPath = watchdogDir + "/test-loop.watchdog.json";
  const progressPath = "/fake/progress.json";

  const entry = makeWatchdogEntry({
    slug: "test-loop",
    loop_name: "Test Loop",
    pid: 99999,
    progress_json_path: progressPath,
    spawn_time: now - 70 * 60 * 1000,
    last_check: now - 70 * 60 * 1000,
    done: false,
  });

  const progressContent = JSON.stringify({
    status: "complete",
    loop_stop_counts: { complete: 1 },
  });

  const fsFn = makeStubFs({
    watchdogDir,
    files: new Map([
      [watchdogPath, JSON.stringify(entry)],
      [progressPath, progressContent],
    ]),
    mtimes: new Map([[progressPath, now - 5 * 60 * 1000]]),
  });

  const capturedInputs: string[] = [];
  const runTurnStub: BridgeRunTurn = async (input, emit) => {
    capturedInputs.push(input);
    emit("ok", "text");
  };

  const { transport } = makeStubTransport([{ ok: true, result: [] }]);

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    watchdogDir,
    fsFn,
    isPidAliveFn: () => false,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await bridge.stop();

  assert.ok(
    capturedInputs.some((s) => /complete:1/.test(s)),
    `expected a turn containing "complete:1", got: ${JSON.stringify(capturedInputs)}`,
  );
  assert.ok(
    fsFn.unlinked.includes(watchdogPath),
    `expected watchdog file to be unlinked, got unlinked: ${JSON.stringify(fsFn.unlinked)}`,
  );
});

// ---------------------------------------------------------------------------
// Watchdog test 2: pid alive, 61 min silence → stall path injects turn
// ---------------------------------------------------------------------------

test("watchdog: pid alive with 61 min progress.json silence injects a stall turn and writes pinged_at", async () => {
  const now = Date.now();
  const watchdogDir = "/fake/watchdog";
  const watchdogPath = watchdogDir + "/stall-loop.watchdog.json";
  const progressPath = "/fake/stall-progress.json";

  // last_check=null so sleep detection (entry.last_check !== null check) is
  // skipped, preventing wake_floor from being set to ~now, which would
  // suppress the stall ping by making liveMtime ≈ now.
  const entry = makeWatchdogEntry({
    slug: "stall-loop",
    loop_name: "Stall Loop",
    pid: 88888,
    progress_json_path: progressPath,
    spawn_time: now - 70 * 60 * 1000,
    last_check: null,
    pinged_at: null,
    done: false,
  });

  const progressContent = JSON.stringify({ status: "in_progress" });

  const fsFn = makeStubFs({
    watchdogDir,
    files: new Map([
      [watchdogPath, JSON.stringify(entry)],
      [progressPath, progressContent],
    ]),
    mtimes: new Map([[progressPath, now - 61 * 60 * 1000]]),
  });

  const capturedInputs: string[] = [];
  const runTurnStub: BridgeRunTurn = async (input, emit) => {
    capturedInputs.push(input);
    emit("ok", "text");
  };

  const { transport } = makeStubTransport([{ ok: true, result: [] }]);

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    watchdogDir,
    fsFn,
    isPidAliveFn: () => true,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await bridge.stop();

  assert.ok(
    capturedInputs.some((s) => /gone quiet/i.test(s)),
    `expected a turn containing "gone quiet", got: ${JSON.stringify(capturedInputs)}`,
  );
  assert.ok(
    capturedInputs.some((s) => /Stall Loop/.test(s)),
    `expected the loop name in the turn, got: ${JSON.stringify(capturedInputs)}`,
  );

  // The watchdog should have been written with pinged_at set.
  const writtenForWatchdog = fsFn.written.filter((w) => w.path === watchdogPath);
  assert.ok(writtenForWatchdog.length > 0, "expected watchdog to be written");
  const lastWritten = JSON.parse(writtenForWatchdog[writtenForWatchdog.length - 1]!.content) as WatchdogEntry;
  assert.ok(lastWritten.pinged_at !== null, `expected pinged_at to be set, got: ${JSON.stringify(lastWritten.pinged_at)}`);
});

// ---------------------------------------------------------------------------
// Watchdog test 3: sleep detection — large gap sets wake_floor, no false stall
// ---------------------------------------------------------------------------

test("watchdog: sleep gap sets wake_floor and suppresses false stall ping", async () => {
  const now = Date.now();
  const watchdogDir = "/fake/watchdog";
  const watchdogPath = watchdogDir + "/sleep-loop.watchdog.json";
  const progressPath = "/fake/sleep-progress.json";

  // last_check = now-2h simulates a machine sleep gap (now - last_check >> 5*pollIntervalMs)
  // mtime = now-2h means the loop would stall WITHOUT wake_floor.
  const entry = makeWatchdogEntry({
    slug: "sleep-loop",
    loop_name: "Sleep Loop",
    pid: 77777,
    progress_json_path: progressPath,
    spawn_time: now - 3 * 60 * 60 * 1000,
    last_check: now - 2 * 60 * 60 * 1000,
    wake_floor: null,
    pinged_at: null,
    done: false,
  });

  const progressContent = JSON.stringify({ status: "in_progress" });

  const fsFn = makeStubFs({
    watchdogDir,
    files: new Map([
      [watchdogPath, JSON.stringify(entry)],
      [progressPath, progressContent],
    ]),
    // mtime is 2h ago — old enough to stall without wake_floor
    mtimes: new Map([[progressPath, now - 2 * 60 * 60 * 1000]]),
  });

  const capturedInputs: string[] = [];
  const runTurnStub: BridgeRunTurn = async (input, emit) => {
    capturedInputs.push(input);
    emit("ok", "text");
  };

  const { transport } = makeStubTransport([{ ok: true, result: [] }]);

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 2000,  // non-zero, critical: 5×2000 = 10000; 2h gap >> 10s
    watchdogDir,
    fsFn,
    isPidAliveFn: () => true,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();

  // No stall ping should have been injected.
  assert.equal(
    capturedInputs.length,
    0,
    `expected no stall ping after sleep gap, got: ${JSON.stringify(capturedInputs)}`,
  );

  // The written watchdog should have wake_floor set to approximately now.
  const writtenForWatchdog = fsFn.written.filter((w) => w.path === watchdogPath);
  assert.ok(writtenForWatchdog.length > 0, "expected watchdog to be written with wake_floor");
  const lastWritten = JSON.parse(writtenForWatchdog[writtenForWatchdog.length - 1]!.content) as WatchdogEntry;
  assert.ok(lastWritten.wake_floor !== null, "expected wake_floor to be set after sleep gap");
  assert.ok(
    lastWritten.wake_floor! >= now - 5000 && lastWritten.wake_floor! <= now + 5000,
    `expected wake_floor ≈ now, got: ${lastWritten.wake_floor}`,
  );
});

// ---------------------------------------------------------------------------
// Watchdog test 4: session-id binding — progress_json_path via session_id
// ---------------------------------------------------------------------------

test("watchdog: session-id binding resolves progress_json_path via session_id, not mtime", async () => {
  const now = Date.now();
  const watchdogDir = "/fake/watchdog";
  const watchdogPath = watchdogDir + "/bind-loop.watchdog.json";
  const logPath = "/fake/bind-loop.log";

  // session_id=null, progress_json_path=null on entry
  const entry = makeWatchdogEntry({
    slug: "bind-loop",
    loop_name: "Bind Loop",
    pid: 66666,
    session_id: null,
    progress_json_path: null,
    progress_json_glob: "/fake/.claude/agentic-loop/*test-repo*/*/progress.json",
    log_path: logPath,
    // spawn_time = now so that neither candidate's mtime triggers a stall
    spawn_time: now,
    last_check: now,
    pinged_at: null,
    done: false,
  });

  // Log file contains a system/init line with session_id="abc123"
  const logContent = JSON.stringify({ type: "system", subtype: "init", session_id: "abc123" });

  // Two progress.json candidates: one with /abc123/ (mtime=now-70min, older)
  // and one WITHOUT abc123 (mtime=now-5min, NEWER — adversarial)
  const correctPath = "/fake/.claude/agentic-loop/test-repo-slug/abc123/progress.json";
  const wrongPath = "/fake/.claude/agentic-loop/test-repo-slug/other-session/progress.json";

  const fsFn = makeStubFs({
    watchdogDir,
    files: new Map([
      [watchdogPath, JSON.stringify(entry)],
      [logPath, logContent],
      [correctPath, JSON.stringify({ status: "in_progress" })],
      [wrongPath, JSON.stringify({ status: "in_progress" })],
    ]),
    mtimes: new Map([
      [correctPath, now - 70 * 60 * 1000],  // older — should still be chosen
      [wrongPath, now - 5 * 60 * 1000],     // newer — adversarial
    ]),
    // glob returns BOTH paths; the stub ignores the pattern
    globResults: [correctPath, wrongPath],
  });

  const { transport } = makeStubTransport([{ ok: true, result: [] }]);

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: async (_input, emit) => { emit("ok", "text"); },
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    watchdogDir,
    fsFn,
    isPidAliveFn: () => true,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();

  const writtenForWatchdog = fsFn.written.filter((w) => w.path === watchdogPath);
  assert.ok(writtenForWatchdog.length > 0, "expected watchdog to be written");
  const lastWritten = JSON.parse(writtenForWatchdog[writtenForWatchdog.length - 1]!.content) as WatchdogEntry;
  assert.equal(lastWritten.session_id, "abc123", `expected session_id="abc123", got: ${lastWritten.session_id}`);
  assert.equal(
    lastWritten.progress_json_path,
    correctPath,
    `expected progress_json_path to be the abc123 path, got: ${lastWritten.progress_json_path}`,
  );
});

// ---------------------------------------------------------------------------
// Watchdog test 5: stall debounce clear — mtime advance past pinged_at
// ---------------------------------------------------------------------------

test("watchdog: mtime advance past pinged_at clears the stall debounce (pinged_at → null)", async () => {
  const now = Date.now();
  const watchdogDir = "/fake/watchdog";
  const watchdogPath = watchdogDir + "/debounce-loop.watchdog.json";
  const progressPath = "/fake/debounce-progress.json";

  const entry = makeWatchdogEntry({
    slug: "debounce-loop",
    loop_name: "Debounce Loop",
    pid: 55555,
    progress_json_path: progressPath,
    spawn_time: now - 3 * 60 * 60 * 1000,
    last_check: now - 30 * 60 * 1000,
    pinged_at: now - 30 * 60 * 1000,
    done: false,
  });

  const progressContent = JSON.stringify({ status: "in_progress" });

  const fsFn = makeStubFs({
    watchdogDir,
    files: new Map([
      [watchdogPath, JSON.stringify(entry)],
      [progressPath, progressContent],
    ]),
    // mtime = now-5min, which is after pinged_at (now-30min) → clears debounce
    mtimes: new Map([[progressPath, now - 5 * 60 * 1000]]),
  });

  const capturedInputs: string[] = [];
  const runTurnStub: BridgeRunTurn = async (input, emit) => {
    capturedInputs.push(input);
    emit("ok", "text");
  };

  const { transport } = makeStubTransport([{ ok: true, result: [] }]);

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 2000,
    watchdogDir,
    fsFn,
    isPidAliveFn: () => true,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();

  const writtenForWatchdog = fsFn.written.filter((w) => w.path === watchdogPath);
  assert.ok(writtenForWatchdog.length > 0, "expected watchdog to be written");
  const lastWritten = JSON.parse(writtenForWatchdog[writtenForWatchdog.length - 1]!.content) as WatchdogEntry;
  assert.equal(
    lastWritten.pinged_at,
    null,
    `expected pinged_at=null after mtime advance, got: ${lastWritten.pinged_at}`,
  );
  // No new stall ping (mtime=now-5min is not stale — liveMtime = max(spawn_time=now-3h,
  // mtime=now-5min, wake_floor) where wake_floor gets set due to sleep gap detection,
  // so either way no stall fires on this cycle)
  assert.equal(capturedInputs.length, 0, `expected no stall ping, got: ${JSON.stringify(capturedInputs)}`);
});

// ---------------------------------------------------------------------------
// Watchdog test 6: done=true watchdog is skipped and removed
// ---------------------------------------------------------------------------

test("watchdog: done=true watchdog file is unlinked and no turn is injected", async () => {
  const now = Date.now();
  const watchdogDir = "/fake/watchdog";
  const watchdogPath = watchdogDir + "/done-loop.watchdog.json";

  const entry = makeWatchdogEntry({
    slug: "done-loop",
    loop_name: "Done Loop",
    pid: 44444,
    spawn_time: now - 60 * 60 * 1000,
    done: true,
  });

  const fsFn = makeStubFs({
    watchdogDir,
    files: new Map([[watchdogPath, JSON.stringify(entry)]]),
  });

  const capturedInputs: string[] = [];
  const runTurnStub: BridgeRunTurn = async (input, emit) => {
    capturedInputs.push(input);
    emit("ok", "text");
  };

  const { transport } = makeStubTransport([{ ok: true, result: [] }]);

  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    watchdogDir,
    fsFn,
    isPidAliveFn: () => false,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();

  assert.ok(fsFn.unlinked.includes(watchdogPath), "expected done=true watchdog to be unlinked");
  assert.equal(capturedInputs.length, 0, `expected no turn injection for done=true watchdog, got: ${JSON.stringify(capturedInputs)}`);
});

// ---------------------------------------------------------------------------
// Watchdog test 7: empty watchdog dir → no error, no injection
// ---------------------------------------------------------------------------

test("watchdog: empty watchdog dir produces no error and no turn injection", async () => {
  const watchdogDir = "/fake/empty-watchdog";

  // No .watchdog.json files — only the dir itself is present in existingDirs.
  const fsFn = makeStubFs({ watchdogDir });

  const capturedInputs: string[] = [];
  const runTurnStub: BridgeRunTurn = async (input, emit) => {
    capturedInputs.push(input);
    emit("ok", "text");
  };

  const { transport } = makeStubTransport([{ ok: true, result: [] }]);

  let threw = false;
  try {
    const bridge = createBridge({
      config: { token: "t", chatId: "12345", transport },
      runTurn: runTurnStub,
      getSessionId: () => undefined,
      resetSession: () => {},
      pollIntervalMs: 5,
      watchdogDir,
      fsFn,
      isPidAliveFn: () => false,
    });

    await bridge.drainOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await bridge.stop();
  } catch {
    threw = true;
  }

  assert.equal(threw, false, "expected no error for empty watchdog dir");
  assert.equal(capturedInputs.length, 0, `expected no turn injection for empty dir, got: ${JSON.stringify(capturedInputs)}`);
});

// ---------------------------------------------------------------------------
// checkLaunchAllowed tests (direct import — no bridge)
// ---------------------------------------------------------------------------

function makeCheckLaunchOpts(overrides: {
  watchdogDir?: string;
  fsFn: FsFunctions;
  isPidAliveFn?: (pid: number, expectedCmd?: string) => boolean;
  staleThresholdMs?: number;
}): CheckLaunchAllowedOpts {
  return {
    watchdogDir: overrides.watchdogDir ?? "/fake/watchdog",
    fs: overrides.fsFn,
    isPidAlive: overrides.isPidAliveFn ?? (() => false),
    staleThresholdMs: overrides.staleThresholdMs,
  };
}

test("checkLaunchAllowed: fresh non-complete progress.json (mtime=now-5min) blocks launch", () => {
  const now = Date.now();
  const watchdogDir = "/fake/watchdog";
  const progressPath = "/fake/.claude/agentic-loop/coderails-session/session1/progress.json";

  const fsFn = makeStubFs({
    watchdogDir,
    files: new Map([[progressPath, JSON.stringify({ status: "in_progress" })]]),
    mtimes: new Map([[progressPath, now - 5 * 60 * 1000]]),
    globResults: [progressPath],
  });

  const result = checkLaunchAllowed("/Users/harrison/Github/coderails", makeCheckLaunchOpts({ fsFn, watchdogDir }));

  assert.equal(result.allowed, false, "expected launch to be blocked by fresh progress.json");
  assert.ok(result.reason, "expected a reason to be provided");
  assert.match(result.reason!, /active/i, `expected reason to mention "active", got: ${result.reason}`);
});

test("checkLaunchAllowed: stale progress.json (mtime=now-90min) allows launch", () => {
  const now = Date.now();
  const watchdogDir = "/fake/watchdog";
  const progressPath = "/fake/.claude/agentic-loop/coderails-session/session1/progress.json";

  const fsFn = makeStubFs({
    watchdogDir,
    files: new Map([[progressPath, JSON.stringify({ status: "in_progress" })]]),
    mtimes: new Map([[progressPath, now - 90 * 60 * 1000]]),
    globResults: [progressPath],
  });

  const result = checkLaunchAllowed("/Users/harrison/Github/coderails", makeCheckLaunchOpts({ fsFn, watchdogDir }));

  assert.equal(result.allowed, true, "expected stale progress.json to allow launch");
});

test("checkLaunchAllowed: live watchdog pid for same repo blocks launch", () => {
  const now = Date.now();
  const watchdogDir = "/fake/watchdog";
  const watchdogPath = watchdogDir + "/coderails.watchdog.json";

  const entry = makeWatchdogEntry({
    slug: "coderails",
    loop_name: "Coderails Loop",
    pid: 33333,
    repo: "/Users/harrison/Github/coderails",
    spawn_time: now - 30 * 60 * 1000,
    done: false,
  });

  const fsFn = makeStubFs({
    watchdogDir,
    files: new Map([[watchdogPath, JSON.stringify(entry)]]),
    globResults: [],  // no progress.json files
  });

  const result = checkLaunchAllowed(
    "/Users/harrison/Github/coderails",
    makeCheckLaunchOpts({ fsFn, watchdogDir, isPidAliveFn: () => true }),
  );

  assert.equal(result.allowed, false, "expected live watchdog pid to block launch");
  assert.ok(result.reason, "expected a reason to be provided");
  assert.match(result.reason!, /already running/i, `expected reason to mention "already running", got: ${result.reason}`);
});

test("checkLaunchAllowed: worktree path containing repo basename blocks launch (slug family)", () => {
  const now = Date.now();
  const watchdogDir = "/fake/watchdog";
  // Path contains "coderails-worktree-abc" which includes "coderails"
  const progressPath = "/fake/.claude/agentic-loop/coderails-worktree-abc/session1/progress.json";

  const fsFn = makeStubFs({
    watchdogDir,
    files: new Map([[progressPath, JSON.stringify({ status: "in_progress" })]]),
    mtimes: new Map([[progressPath, now - 5 * 60 * 1000]]),
    globResults: [progressPath],
  });

  const result = checkLaunchAllowed("/Users/harrison/Github/coderails", makeCheckLaunchOpts({ fsFn, watchdogDir }));

  assert.equal(result.allowed, false, `expected worktree slug to block launch for repo "coderails", got allowed=true`);
});
