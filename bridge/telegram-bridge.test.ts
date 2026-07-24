import { mkdtempSync, readFileSync, existsSync as realExistsSync } from "node:fs";
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
import { createBridge, type BridgeRunTurn, defaultFsFn } from "./telegram-bridge.ts";
import { GATED_TOOL_NAMES } from "../gate/sendGate.ts";
import { getModel, getEffort, setModel, setEffort, VALID_MODELS as VALID_MODELS_FOR_TEST, VALID_EFFORTS as VALID_EFFORTS_FOR_TEST } from "../proactive/modelConfig.ts";
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

// 12:00 Dublin in summer (IST = UTC+1) — outside the 22:30-08:00 quiet
// window, so normal-severity pushes send immediately unless a test injects
// its own quiet clock.
const DAYTIME = () => new Date("2026-07-15T11:00:00Z");
// 23:30 Dublin — inside the quiet window.
const QUIET_TIME = () => new Date("2026-07-15T22:30:00Z");

// Every createBridge call in this file spreads these seams in FIRST (explicit
// per-test values override them): the bridge's push() store and heartbeat
// file must always land in a throwaway tmpdir, never the operator's real
// ~/.rachel, and the clock must be pinned outside quiet hours so alert tests
// are deterministic regardless of when the suite runs.
function basePushOpts() {
  const dir = mkdtempSync(join(tmpdir(), "rachel-bridge-test-"));
  return {
    pushBaseDir: join(dir, "proactive"),
    heartbeatPath: join(dir, "bridge-heartbeat.json"),
    nowFn: DAYTIME,
  };
}

interface DeferredFileShape {
  schema_version: number;
  entries: Array<{ family: string; event_id: string; state: string; text: string; reason: string }>;
}

function readDeferred(pushBaseDir: string): DeferredFileShape {
  const path = join(pushBaseDir, "deferred.json");
  if (!realExistsSync(path)) return { schema_version: 1, entries: [] };
  return JSON.parse(readFileSync(path, "utf8")) as DeferredFileShape;
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
    ...basePushOpts(),
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

test("runTurn's query options consume the RACHEL_ALLOWED_TOOLS seam: set env narrows allowedTools, unset env yields the frozen 17-entry default list", async () => {
  // Drives the REAL runTurn (imported from rachel.ts) with a fake queryFn
  // that captures the options object the SDK would receive. This is the
  // regression pin for the tool-narrowing seam: a merge conflict reverting
  // rachel.ts's allowedTools line to an inline array keeps every pure
  // allowedTools.ts test green while one-shots silently regain the full
  // tool surface — THIS test is what fails in that world. The frozen
  // 17-entry literal lives HERE, deliberately not shared with rachel.ts,
  // so it pins the real thing rather than echoing it.
  const { runTurn: realRunTurn } = await import("../rachel.ts");

  const makeCapturingQueryFn = (captured: { allowedTools?: unknown }): Parameters<typeof realRunTurn>[3] =>
    ((params) => {
      captured.allowedTools = (params.options as { allowedTools?: unknown } | undefined)?.allowedTools;
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield { type: "result", num_turns: 1 } as unknown as SDKMessage;
      }
      return generate();
    }) as Parameters<typeof realRunTurn>[3];

  const originalEnv = process.env["RACHEL_ALLOWED_TOOLS"];
  try {
    process.env["RACHEL_ALLOWED_TOOLS"] = "Read,Bash";
    const narrowed: { allowedTools?: unknown } = {};
    await realRunTurn("probe", () => {}, new AbortController().signal, makeCapturingQueryFn(narrowed));
    assert.deepEqual(narrowed.allowedTools, ["Read", "Bash"], "set env must narrow the SDK options' allowedTools to exactly the listed tools");

    delete process.env["RACHEL_ALLOWED_TOOLS"];
    const unset: { allowedTools?: unknown } = {};
    await realRunTurn("probe", () => {}, new AbortController().signal, makeCapturingQueryFn(unset));
    assert.deepEqual(
      unset.allowedTools,
      [
        "Read", "Write", "Edit", "Glob", "Grep", "Bash",
        "WebSearch", "WebFetch",
        "ToolSearch", "Skill",
        "mcp__mcp-exec__execute_code_with_wrappers",
        "mcp__mcp-exec__list_available_mcp_servers",
        "mcp__mcp-exec__get_mcp_tool_schema",
        "mcp__claude-in-chrome__*",
        "mcp__claude_ai_Gmail__*",
        "mcp__claude_ai_Google_Calendar__*",
        "mcp__claude_ai_Slack__*",
      ],
      "unset env must yield the frozen 17-entry default list, byte-identical",
    );
  } finally {
    if (originalEnv === undefined) {
      delete process.env["RACHEL_ALLOWED_TOOLS"];
    } else {
      process.env["RACHEL_ALLOWED_TOOLS"] = originalEnv;
    }
  }
});

test("runTurn's query options read model/effort from proactive/modelConfig.ts's getters on every call, not a boot-time const", async () => {
  // Drives the REAL runTurn (imported from rachel.ts) with a fake queryFn
  // that captures the options object the SDK would receive — same idiom as
  // the RACHEL_ALLOWED_TOOLS pin above. This is the regression pin for the
  // model/effort wiring: reverting rachel.ts's `model: getModel()` /
  // `effort: getEffort()` lines back to captured consts keeps every pure
  // modelConfig.ts test green (they only exercise the module in isolation)
  // while runTurn silently stops picking up a /model or /effort switch —
  // THIS test is what fails in that world.
  const { runTurn: realRunTurn } = await import("../rachel.ts");

  const makeCapturingQueryFn = (captured: { model?: unknown; effort?: unknown }): Parameters<typeof realRunTurn>[3] =>
    ((params) => {
      const opts = params.options as { model?: unknown; effort?: unknown } | undefined;
      captured.model = opts?.model;
      captured.effort = opts?.effort;
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield { type: "result", num_turns: 1 } as unknown as SDKMessage;
      }
      return generate();
    }) as Parameters<typeof realRunTurn>[3];

  const originalModel = getModel();
  const originalEffort = getEffort();
  try {
    // Switch to non-default values first: asserting against the boot
    // default couldn't distinguish "reads the getter every turn" from
    // "captured the default at import time" — both would produce the same
    // value on a fresh process. A non-default switch is the only way to
    // prove runTurn re-reads state instead of a stale const.
    const modelSwitch = setModel("claude-opus-4-8");
    assert.equal(modelSwitch.ok, true, "test precondition: switching to claude-opus-4-8 must succeed");
    const effortSwitch = setEffort("xhigh");
    assert.equal(effortSwitch.ok, true, "test precondition: switching to xhigh must succeed");

    const captured: { model?: unknown; effort?: unknown } = {};
    await realRunTurn("probe", () => {}, new AbortController().signal, makeCapturingQueryFn(captured));

    assert.equal(captured.model, "claude-opus-4-8", "runTurn's options.model must reflect the NEW switched value, not a boot-time const");
    assert.equal(captured.effort, "xhigh", "runTurn's options.effort must reflect the NEW switched value, not a boot-time const");
  } finally {
    setModel(originalModel);
    setEffort(originalEffort);
  }
});

test("the sweep's calendar one-shot narrowing set is a subset of rachel.ts's default tool list", async () => {
  // Cross-producer pin: resolveAllowedTools silently drops entries outside
  // the default list, so an ONESHOT_TOOLS entry that drifts out of
  // DEFAULT_ALLOWED_TOOLS would quietly de-tool the calendar one-shot.
  const { DEFAULT_ALLOWED_TOOLS } = await import("../rachel.ts");
  const { ONESHOT_TOOLS } = await import("../proactive/sweep.ts");
  const defaults = new Set<string>(DEFAULT_ALLOWED_TOOLS);
  for (const entry of ONESHOT_TOOLS.split(",")) {
    assert.ok(defaults.has(entry), `ONESHOT_TOOLS entry ${JSON.stringify(entry)} is not in DEFAULT_ALLOWED_TOOLS`);
  }
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
    ...basePushOpts(),
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
    ...basePushOpts(),
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
    ...basePushOpts(),
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

test("a throwing runTurn still produces a reply containing '[Rachel] error:' and clears the heartbeat's turn_in_flight_since", async () => {
  const { transport, calls } = makeStubTransport([
    messageUpdate(1, "trigger a failure"),
    { ok: true, result: [] },
  ]);

  const runTurnStub: BridgeRunTurn = async () => {
    throw new Error("boom - synthetic failure for this test");
  };

  const pushSeams = basePushOpts();
  const bridge = createBridge({
    ...pushSeams,
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  // A second poll iteration writes the post-throw heartbeat — the finally in
  // drainFifo must have cleared turn_in_flight_since despite the throw.
  await bridge.drainOnce();
  await bridge.stop();

  const sendCall = calls.find((c) => c.url.includes("/sendMessage"));
  assert.ok(sendCall, "expected a sendMessage reply");
  assert.match(String((sendCall!.body as Record<string, unknown>)["text"]), /\[Rachel\] error:/);

  const heartbeat = JSON.parse(readFileSync(pushSeams.heartbeatPath, "utf8")) as Record<string, unknown>;
  assert.equal(heartbeat["turn_in_flight_since"], null, "a thrown turn must not leave turn_in_flight_since stuck (phantom drain-stall)");
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
    ...basePushOpts(),
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
    ...basePushOpts(),
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
    ...basePushOpts(),
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

test("/stop inoculates the next turn against ghost-rejection residue exactly like a deadline abort", async () => {
  // /stop aborts the same in-flight tool call a deadline timeout would,
  // producing the identical SDK rejection-residue string ("the user doesn't
  // want to proceed with this tool use") — so the next turn's input must
  // carry the same abort-artifact prefix the deadline path applies.
  const { transport } = makeStubTransport([
    messageUpdate(1, "long running task"),
    messageUpdate(2, "/stop"),
    messageUpdate(3, "follow up"),
    { ok: true, result: [] },
  ]);

  const seen: string[] = [];
  const runTurnStub: BridgeRunTurn = (input, emit, signal) => {
    seen.push(input);
    if (input === "long running task") {
      return new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve());
      });
    }
    emit("ok", "text");
    return Promise.resolve();
  };

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  await bridge.drainOnce();
  // give the drain loop time to pick up "long running task" and start it
  await new Promise((resolve) => setTimeout(resolve, 20));
  // fetches the /stop update — handled inline (aborts, replies "Stopped."),
  // not queued to the FIFO
  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 20));
  // fetches "follow up"
  await bridge.drainOnce();
  for (let i = 0; i < 100 && seen.length < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await bridge.stop();

  assert.equal(seen.length, 2);
  assert.equal(seen[0], "long running task");
  assert.notEqual(seen[1], "follow up", "the follow-up input should carry the abort-artifact prefix, not arrive unprefixed");
  assert.ok(seen[1]!.endsWith("follow up"), `expected the queued message to still run, got: ${JSON.stringify(seen[1])}`);
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
    ...basePushOpts(),
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
    ...basePushOpts(),
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
    ...basePushOpts(),
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
    ...basePushOpts(),
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

test("/model with no argument replies with the current model and the valid options, without dispatching to runTurn", async () => {
  const { transport, calls } = makeStubTransport([
    messageUpdate(1, "/model"),
    { ok: true, result: [] },
  ]);

  let dispatched = false;
  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {
      dispatched = true;
    },
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await bridge.stop();

  assert.equal(dispatched, false);
  const sendCall = calls.find((c) => c.url.includes("/sendMessage"));
  const text = String((sendCall?.body as { text?: string } | undefined)?.text ?? "");
  assert.ok(text.includes(getModel()), `expected the current model in the reply — got: ${text}`);
  for (const m of VALID_MODELS_FOR_TEST) {
    assert.ok(text.includes(m), `expected valid model ${m} listed in the no-arg reply — got: ${text}`);
  }
});

test("/model <valid-name> switches the model and confirms it takes effect on the next turn", async () => {
  const { transport, calls } = makeStubTransport([
    messageUpdate(1, "/model claude-opus-4-8"),
    { ok: true, result: [] },
  ]);

  const originalModel = getModel();
  try {
    const bridge = createBridge({
      ...basePushOpts(),
      config: { token: "t", chatId: "12345", transport },
      runTurn: async () => {},
      getSessionId: () => undefined,
      resetSession: () => {},
      pollIntervalMs: 5,
    });

    await bridge.drainOnce();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await bridge.stop();

    assert.equal(getModel(), "claude-opus-4-8", "setModel must have applied the switch");
    const sendCall = calls.find((c) => c.url.includes("/sendMessage"));
    const text = String((sendCall?.body as { text?: string } | undefined)?.text ?? "");
    assert.ok(text.includes("claude-opus-4-8"), `expected confirmation naming the new model — got: ${text}`);
  } finally {
    setModel(originalModel);
  }
});

test("/model <invalid-name> renders the rejection message and leaves the current model unchanged", async () => {
  const { transport, calls } = makeStubTransport([
    messageUpdate(1, "/model not-a-real-model"),
    { ok: true, result: [] },
  ]);

  const originalModel = getModel();
  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {},
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await bridge.stop();

  assert.equal(getModel(), originalModel, "an invalid /model value must not change current state");
  const sendCall = calls.find((c) => c.url.includes("/sendMessage"));
  const text = String((sendCall?.body as { text?: string } | undefined)?.text ?? "");
  assert.ok(text.includes("not-a-real-model"), `expected the rejection to name the bad value — got: ${text}`);
});

test("/effort with no argument replies with the current effort and the valid options, without dispatching to runTurn", async () => {
  const { transport, calls } = makeStubTransport([
    messageUpdate(1, "/effort"),
    { ok: true, result: [] },
  ]);

  let dispatched = false;
  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {
      dispatched = true;
    },
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await bridge.stop();

  assert.equal(dispatched, false);
  const sendCall = calls.find((c) => c.url.includes("/sendMessage"));
  const text = String((sendCall?.body as { text?: string } | undefined)?.text ?? "");
  assert.ok(text.includes(getEffort()), `expected the current effort in the reply — got: ${text}`);
  for (const e of VALID_EFFORTS_FOR_TEST) {
    assert.ok(text.includes(e), `expected valid effort ${e} listed in the no-arg reply — got: ${text}`);
  }
});

test("/effort <valid-level> switches the effort and confirms it takes effect on the next turn", async () => {
  const { transport, calls } = makeStubTransport([
    messageUpdate(1, "/effort xhigh"),
    { ok: true, result: [] },
  ]);

  const originalEffort = getEffort();
  try {
    const bridge = createBridge({
      ...basePushOpts(),
      config: { token: "t", chatId: "12345", transport },
      runTurn: async () => {},
      getSessionId: () => undefined,
      resetSession: () => {},
      pollIntervalMs: 5,
    });

    await bridge.drainOnce();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await bridge.stop();

    assert.equal(getEffort(), "xhigh", "setEffort must have applied the switch");
    const sendCall = calls.find((c) => c.url.includes("/sendMessage"));
    const text = String((sendCall?.body as { text?: string } | undefined)?.text ?? "");
    assert.ok(text.includes("xhigh"), `expected confirmation naming the new effort — got: ${text}`);
  } finally {
    setEffort(originalEffort);
  }
});

test("/effort <invalid-level> renders the rejection message and leaves the current effort unchanged", async () => {
  const { transport, calls } = makeStubTransport([
    messageUpdate(1, "/effort ultra"),
    { ok: true, result: [] },
  ]);

  const originalEffort = getEffort();
  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {},
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await bridge.stop();

  assert.equal(getEffort(), originalEffort, "an invalid /effort value must not change current state");
  const sendCall = calls.find((c) => c.url.includes("/sendMessage"));
  const text = String((sendCall?.body as { text?: string } | undefined)?.text ?? "");
  assert.ok(text.includes("ultra"), `expected the rejection to name the bad value — got: ${text}`);
});

test("/model with extra surrounding whitespace still parses the argument", async () => {
  const { transport } = makeStubTransport([
    messageUpdate(1, "  /model   claude-haiku-4-5  "),
    { ok: true, result: [] },
  ]);

  const originalModel = getModel();
  try {
    const bridge = createBridge({
      ...basePushOpts(),
      config: { token: "t", chatId: "12345", transport },
      runTurn: async () => {},
      getSessionId: () => undefined,
      resetSession: () => {},
      pollIntervalMs: 5,
    });

    await bridge.drainOnce();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await bridge.stop();

    assert.equal(getModel(), "claude-haiku-4-5", "whitespace around /model and its argument must not block parsing");
  } finally {
    setModel(originalModel);
  }
});

test("/status reports the live model and effort via modelConfig's getters, reflecting a switch made through /model — not a hardcoded default or the RACHEL_MODEL env var", async () => {
  const { transport, calls } = makeStubTransport([
    messageUpdate(1, "/model claude-fable-5"),
    messageUpdate(2, "/status"),
    { ok: true, result: [] },
  ]);

  const originalModel = getModel();
  const originalEnv = process.env["RACHEL_MODEL"];
  try {
    // Prove /status doesn't fall back to the stale hardcoded default by
    // making the env var (the OTHER wrong source) disagree with both.
    process.env["RACHEL_MODEL"] = "claude-sonnet-4-6";

    const bridge = createBridge({
      ...basePushOpts(),
      config: { token: "t", chatId: "12345", transport },
      runTurn: async () => {},
      getSessionId: () => undefined,
      resetSession: () => {},
      pollIntervalMs: 5,
    });

    await bridge.drainOnce();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await bridge.drainOnce();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await bridge.stop();

    assert.equal(getModel(), "claude-fable-5");
    const statusCall = calls.filter((c) => c.url.includes("/sendMessage")).at(-1);
    const text = String((statusCall?.body as { text?: string } | undefined)?.text ?? "");
    // "effort:" only appears in the /status reply, not the /model
    // confirmation — this line is what pins the assertion to the /status
    // reply specifically, not just the last sendMessage call generally.
    assert.ok(text.includes(`effort: ${getEffort()}`), `expected /status to include the current effort — got: ${text}`);
    assert.ok(text.includes("claude-fable-5"), `expected /status to reflect the switched model — got: ${text}`);
    assert.ok(!text.includes("claude-sonnet-4-6"), `/status must not fall back to the stale hardcoded default — got: ${text}`);
  } finally {
    setModel(originalModel);
    if (originalEnv === undefined) {
      delete process.env["RACHEL_MODEL"];
    } else {
      process.env["RACHEL_MODEL"] = originalEnv;
    }
  }
});

test("setMyCommands registers /model and /effort alongside the existing reset/status/stop commands", async () => {
  const { transport, calls } = makeStubTransport([
    { ok: true, result: [] },
  ]);

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {},
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  const runPromise = bridge.run();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();
  await runPromise.catch(() => {});

  const setCommandsCall = calls.find((c) => c.url.includes("/setMyCommands"));
  assert.ok(setCommandsCall, "expected a setMyCommands call");
  const commands = (setCommandsCall?.body as { commands?: Array<{ command: string }> } | undefined)?.commands ?? [];
  const names = commands.map((c) => c.command);
  assert.ok(names.includes("model"), `expected 'model' registered — got: ${JSON.stringify(names)}`);
  assert.ok(names.includes("effort"), `expected 'effort' registered — got: ${JSON.stringify(names)}`);
  assert.ok(names.includes("reset"), `existing 'reset' command must remain registered — got: ${JSON.stringify(names)}`);
  assert.ok(names.includes("status"), `existing 'status' command must remain registered — got: ${JSON.stringify(names)}`);
  assert.ok(names.includes("stop"), `existing 'stop' command must remain registered — got: ${JSON.stringify(names)}`);
});

test("run() exits fatally after CONFLICT_EXIT_THRESHOLD (5) consecutive 409s — genuine second consumer", async () => {
  // Transport always 409s — bridge must NOT exit on first 409, only after 5 consecutive.
  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/getUpdates")) {
      return { ok: false, json: async () => ({ ok: false, description: "Conflict: terminated by other getUpdates request" }) } as Response;
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  const bridge = createBridge({
    ...basePushOpts(),
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
  const transport: typeof fetch = async (input, init) => {
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
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      sendMessages.push(String(body.text ?? ""));
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  const bridge = createBridge({
    ...basePushOpts(),
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

test("run() sends a one-time 'started' alert on boot", async () => {
  // A non-409 death (OOM, uncaught exception, reboot, launchctl bootout) can't
  // alert itself — the FATAL 409 exit is the only exit that does. The next boot
  // announcing itself is the only signal a crash-restart loop leaves. Prove the
  // startup alert fires exactly once, and only startup (no poll error/conflict).
  const sendMessages: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/getUpdates")) {
      return { ok: true, json: async () => ({ ok: true, result: [] }) } as Response;
    }
    if (url.includes("/sendMessage")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      sendMessages.push(String(body.text ?? ""));
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {},
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  const runPromise = bridge.run();
  // Let a tick pass so the fire-and-forget startup alert lands, then stop.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await bridge.stop();
  await runPromise;
  // Flush the fire-and-forget sendChunked microtask.
  await new Promise((resolve) => setTimeout(resolve, 0));

  const startedAlerts = sendMessages.filter((m) => m.toLowerCase().includes("started"));
  assert.equal(startedAlerts.length, 1, `expected exactly one 'started' alert on boot — got: ${JSON.stringify(sendMessages)}`);
});

test("recovery from 409 sends a recovery Telegram alert", async () => {
  let getUpdatesCount = 0;
  const sendMessages: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/getUpdates")) {
      getUpdatesCount++;
      if (getUpdatesCount <= 2) {
        return { ok: false, json: async () => ({ ok: false, description: "Conflict: terminated by other getUpdates request" }) } as Response;
      }
      return { ok: true, json: async () => ({ ok: true, result: [] }) } as Response;
    }
    if (url.includes("/sendMessage")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      sendMessages.push(String(body.text ?? ""));
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  const bridge = createBridge({
    ...basePushOpts(),
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
    ...basePushOpts(),
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
  const transport: typeof fetch = async (input, init) => {
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
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      replies.push(String(body.text ?? ""));
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  const bridge = createBridge({
    ...basePushOpts(),
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
  // Sequence: poll 1 = 409 (enters conflict, sets lastError.recovered=false).
  // Poll 2 succeeds BUT carries a /status message in its result.
  // processUpdates() fires the /status handler BEFORE pollOnce() returns,
  // and lastError.recovered is set to true only AFTER pollOnce() returns in the
  // recovery block. So the /status reply is generated while recovered===false.
  const statusReplies: string[] = [];
  let getUpdatesCount = 0;
  const statusUpdate = {
    update_id: 2,
    message: { message_id: 2, chat: { id: 12345 }, from: { id: 12345 }, text: "/status", date: 0 },
  };
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/getUpdates")) {
      getUpdatesCount++;
      if (getUpdatesCount === 1) {
        // First poll: 409 conflict — sets lastError.recovered=false.
        return { ok: false, json: async () => ({ ok: false, description: "Conflict: terminated by other getUpdates request" }) } as Response;
      }
      // Second poll: success with a /status message embedded.
      return { ok: true, json: async () => ({ ok: true, result: [statusUpdate] }) } as Response;
    }
    if (url.includes("/sendMessage")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      statusReplies.push(String(body.text ?? ""));
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {},
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    conflictBackoffMs: 5,
  });

  const runPromise = bridge.run();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await bridge.stop();
  await runPromise.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 0));

  const statusReply = statusReplies.find((m) => m.includes("last error:"));
  assert.ok(statusReply !== undefined, `expected a /status reply containing "last error:" — got: ${JSON.stringify(statusReplies)}`);
  assert.ok(
    statusReply.includes(", ongoing"),
    `expected ", ongoing" suffix in /status reply while error not yet recovered — got: ${statusReply}`,
  );
});

test("4 consecutive 409s (N-1, boundary) followed by success does NOT exit and sends recovery alert", async () => {
  let getUpdatesCount = 0;
  const sendMessages: string[] = [];
  const transport: typeof fetch = async (input, init) => {
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
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      sendMessages.push(String(body.text ?? ""));
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  const bridge = createBridge({
    ...basePushOpts(),
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
  const conflictAlerts = sendMessages.filter((m) => m.toLowerCase().includes("conflict detected"));
  assert.equal(conflictAlerts.length, 1, `conflict entry alert must fire exactly once per episode — got ${conflictAlerts.length}: ${JSON.stringify(conflictAlerts)}`);
});

test("non-409 poll error sends a Telegram alert on first occurrence (healthy → failed) then recovery alert on success", async () => {
  // Sequence: poll 1 errors (healthy → failed, alert fires), poll 2 succeeds (failed → healthy, recovery alert).
  // backoffMs is not injectable and starts at 1000ms — one cycle costs ~1000ms total (acceptable for this test).
  let getUpdatesCount = 0;
  const sendMessages: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/getUpdates")) {
      getUpdatesCount++;
      if (getUpdatesCount === 1) {
        return { ok: false, json: async () => ({ ok: false, description: "Internal Server Error" }) } as Response;
      }
      return { ok: true, json: async () => ({ ok: true, result: [] }) } as Response;
    }
    if (url.includes("/sendMessage")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      sendMessages.push(String(body.text ?? ""));
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {},
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  const runPromise = bridge.run();
  // Poll 1 errors → 1000ms backoff → poll 2 succeeds → recovery alert (fire-and-forget).
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await bridge.stop();
  await runPromise.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 10));

  const errorAlerts = sendMessages.filter((m) => m.toLowerCase().includes("poll error") && !m.toLowerCase().includes("recovered"));
  assert.equal(errorAlerts.length, 1, `expected exactly 1 poll-error entry alert — got ${errorAlerts.length}: ${JSON.stringify(errorAlerts)}`);
  const recoveryAlerts = sendMessages.filter((m) => m.toLowerCase().includes("recovered from poll error"));
  assert.ok(recoveryAlerts.length >= 1, `expected a recovery alert after non-409 errors resolved — got: ${JSON.stringify(sendMessages)}`);
});

test("consecutive409 resets on non-409 error — mixed 409/non-409 streak does not trigger exit", async () => {
  // 4 × 409 (one short of threshold), then 1 non-409 error (resets counter), then 1 × 409.
  // Total 409s = 5, but they're not consecutive — must NOT exit.
  let getUpdatesCount = 0;
  let exitCalled = false;
  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/getUpdates")) {
      getUpdatesCount++;
      if (getUpdatesCount <= 4) {
        return { ok: false, json: async () => ({ ok: false, description: "Conflict: terminated by other getUpdates request" }) } as Response;
      }
      if (getUpdatesCount === 5) {
        return { ok: false, json: async () => ({ ok: false, description: "Internal Server Error" }) } as Response;
      }
      if (getUpdatesCount === 6) {
        return { ok: false, json: async () => ({ ok: false, description: "Conflict: terminated by other getUpdates request" }) } as Response;
      }
      return { ok: true, json: async () => ({ ok: true, result: [] }) } as Response;
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  const originalExit = process.exit;
  process.exit = () => {
    exitCalled = true;
    throw new Error("process.exit must not fire — consecutive409 should have reset on the non-409 error");
  };

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {},
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    conflictBackoffMs: 5,
  });

  try {
    const runPromise = bridge.run();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await bridge.stop();
    await runPromise.catch(() => {});
  } finally {
    process.exit = originalExit;
  }

  assert.equal(exitCalled, false, "bridge must NOT exit when a non-409 error interrupts the 409 streak (resets consecutive409)");
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
    ...basePushOpts(),
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
    ...basePushOpts(),
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
    ...basePushOpts(),
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
    ...basePushOpts(),
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
    ...basePushOpts(),
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
    ...basePushOpts(),
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
    ...basePushOpts(),
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

test("a document message with a PDF MIME type is downloaded and passed to runTurn as '[document: /path]' with the caption appended", async () => {
  const docUpdate = {
    ok: true,
    result: [
      {
        update_id: 7,
        message: {
          message_id: 7,
          chat: { id: 12345 },
          from: { id: 12345 },
          caption: "what does this say?",
          document: { file_id: "pdf_id", file_name: "invoice.pdf", mime_type: "application/pdf", file_size: 40000 },
        },
      },
    ],
  };

  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/getUpdates")) return { ok: true, json: async () => docUpdate } as Response;
    if (url.includes("/getFile")) return { ok: true, json: async () => ({ ok: true, result: { file_path: "docs/pdf_id.pdf" } }) } as Response;
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  let capturedInput: string | undefined;
  let downloadedPath: string | undefined;
  const bridge = createBridge({
    ...basePushOpts(),
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

  assert.ok(capturedInput, "expected runTurn to have been called for PDF document");
  assert.match(capturedInput!, /\[document: .*pdf_id\.pdf\]/);
  assert.match(capturedInput!, /what does this say\?/);
  assert.ok(downloadedPath, "expected downloadFileFn to have been called");
  assert.match(downloadedPath!, /pdf_id\.pdf/);
});

test("a PDF document with a dot-less filename still saves with a .pdf extension, not the image default", async () => {
  const docUpdate = {
    ok: true,
    result: [
      {
        update_id: 71,
        message: {
          message_id: 71,
          chat: { id: 12345 },
          from: { id: 12345 },
          document: { file_id: "pdf_nodot_id", file_name: "invoice", mime_type: "application/pdf", file_size: 15000 },
        },
      },
    ],
  };

  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/getUpdates")) return { ok: true, json: async () => docUpdate } as Response;
    if (url.includes("/getFile")) return { ok: true, json: async () => ({ ok: true, result: { file_path: "docs/pdf_nodot_id" } }) } as Response;
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  let capturedInput: string | undefined;
  let downloadedPath: string | undefined;
  const bridge = createBridge({
    ...basePushOpts(),
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

  assert.ok(capturedInput, "expected runTurn to have been called for the dot-less PDF document");
  assert.match(capturedInput!, /\[document: .*pdf_nodot_id\.pdf\]/);
  assert.ok(downloadedPath, "expected downloadFileFn to have been called");
  assert.match(downloadedPath!, /pdf_nodot_id\.pdf$/, "dot-less PDF filename must still save with a .pdf extension, not fall back to .jpg");
});

test("a PDF document message with no caption passes '[document: /path]' (no newline/caption) to runTurn", async () => {
  const docUpdate = {
    ok: true,
    result: [
      {
        update_id: 8,
        message: {
          message_id: 8,
          chat: { id: 12345 },
          from: { id: 12345 },
          // no caption field
          document: { file_id: "pdf_solo_id", file_name: "report.pdf", mime_type: "application/pdf", file_size: 10000 },
        },
      },
    ],
  };

  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/getUpdates")) return { ok: true, json: async () => docUpdate } as Response;
    if (url.includes("/getFile")) return { ok: true, json: async () => ({ ok: true, result: { file_path: "docs/pdf_solo_id.pdf" } }) } as Response;
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  let capturedInput: string | undefined;
  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async (input, emit) => { capturedInput = input; emit("ok", "text"); },
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    downloadFileFn: async (_config, _fileId, _destPath) => {},
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();

  assert.ok(capturedInput, "expected runTurn to have been called");
  assert.match(capturedInput!, /\[document: .*pdf_solo_id\.pdf\]/);
  // No newline or caption text should follow the document tag.
  assert.doesNotMatch(capturedInput!, /\n/);
});

test("a document message with an unsupported MIME type replies with an updated unsupported-type message — runTurn is never called", async () => {
  const docUpdate = {
    ok: true,
    result: [
      {
        update_id: 9,
        message: {
          message_id: 9,
          chat: { id: 12345 },
          from: { id: 12345 },
          document: { file_id: "txt_id2", file_name: "notes.txt", mime_type: "text/plain" },
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
    ...basePushOpts(),
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

  assert.equal(dispatched, false, "an unsupported document must not dispatch to runTurn");
  const sendCall = calls.find((c) => c.url.includes("/sendMessage"));
  assert.ok(sendCall, "expected a sendMessage reply for unsupported file type");
  assert.match(String((sendCall!.body as Record<string, unknown>)["text"]), /images or PDFs/);
});

test("a PDF document whose downloadFileFn rejects sends a failure reply to the user and does not dispatch to runTurn", async () => {
  const docUpdate = {
    ok: true,
    result: [
      {
        update_id: 10,
        message: {
          message_id: 10,
          chat: { id: 12345 },
          from: { id: 12345 },
          document: { file_id: "pdf_fail_id", file_name: "broken.pdf", mime_type: "application/pdf" },
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
    if (url.includes("/getFile")) return { ok: true, json: async () => ({ ok: true, result: { file_path: "docs/pdf_fail_id.pdf" } }) } as Response;
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  let dispatched = false;
  const bridge = createBridge({
    ...basePushOpts(),
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

  assert.equal(dispatched, false, "runTurn must not be called when the PDF download fails");
  const sendCall = calls.find((c) => c.url.includes("/sendMessage"));
  assert.ok(sendCall, "expected a sendMessage failure reply to the user");
  assert.match(String((sendCall!.body as Record<string, unknown>)["text"]), /Failed to download/);
});

test("a voice message is downloaded, transcribed, and pushed to runTurn as plain text", async () => {
  const voiceUpdate = {
    ok: true,
    result: [
      {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 12345 },
          from: { id: 12345 },
          voice: { file_id: "voice_id", duration: 3, mime_type: "audio/ogg" },
        },
      },
    ],
  };

  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/getUpdates")) return { ok: true, json: async () => voiceUpdate } as Response;
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  let downloadedFileId: string | undefined;
  let downloadedPath: string | undefined;
  const downloadFileFnStub = async (_config: unknown, fileId: string, destPath: string): Promise<void> => {
    downloadedFileId = fileId;
    downloadedPath = destPath;
  };

  let transcribedPath: string | undefined;
  const transcribeFnStub = async (audioPath: string): Promise<string> => {
    transcribedPath = audioPath;
    return "what's on my calendar today";
  };

  let capturedInput: string | undefined;
  const runTurnStub: BridgeRunTurn = async (input, emit) => {
    capturedInput = input;
    emit("Nothing on today.", "text");
  };

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    downloadFileFn: downloadFileFnStub,
    transcribeFn: transcribeFnStub,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();

  assert.equal(downloadedFileId, "voice_id");
  assert.match(downloadedPath!, /\.rachel\/tmp\/voice_id\.ogg$/);
  assert.equal(transcribedPath, downloadedPath);
  assert.equal(capturedInput, "what's on my calendar today");
});

test("a successfully transcribed inbound voice note logs a success line with the transcript's character count", async () => {
  const voiceUpdate = {
    ok: true,
    result: [
      { update_id: 1, message: { message_id: 1, chat: { id: 12345 }, from: { id: 12345 }, voice: { file_id: "voice_id", duration: 3 } } },
    ],
  };

  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/getUpdates")) return { ok: true, json: async () => voiceUpdate } as Response;
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  const logLines: string[] = [];
  const originalConsoleLog = console.log;
  console.log = (...args: unknown[]) => { logLines.push(args.map(String).join(" ")); };

  try {
    const bridge = createBridge({
      ...basePushOpts(),
      config: { token: "t", chatId: "12345", transport },
      runTurn: async (_input, emit) => emit("Nothing on today.", "text"),
      getSessionId: () => undefined,
      resetSession: () => {},
      pollIntervalMs: 5,
      downloadFileFn: async () => {},
      transcribeFn: async () => "what's on my calendar today",
    });

    await bridge.drainOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await bridge.stop();

    assert.ok(
      logLines.some((l) => l.includes("voice received") && l.includes("27 chars")),
      `expected a success log line with the transcript's char count, got: ${JSON.stringify(logLines)}`,
    );
  } finally {
    console.log = originalConsoleLog;
  }
});

test("a voice message whose downloadFileFn rejects sends a failure reply and never calls transcribeFn", async () => {
  const voiceUpdate = {
    ok: true,
    result: [
      { update_id: 1, message: { message_id: 1, chat: { id: 12345 }, from: { id: 12345 }, voice: { file_id: "bad_id", duration: 2 } } },
    ],
  };
  const calls: { url: string; body: unknown }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    if (url.includes("/getUpdates")) return { ok: true, json: async () => voiceUpdate } as Response;
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  let transcribeCalled = false;
  const runTurnStub: BridgeRunTurn = async () => { throw new Error("runTurn should not be called"); };

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    downloadFileFn: async () => { throw new Error("download failed"); },
    transcribeFn: async () => { transcribeCalled = true; return "should not run"; },
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();

  assert.equal(transcribeCalled, false);
  const sendCalls = calls.filter((c) => c.url.includes("/sendMessage"));
  assert.ok(sendCalls.some((c) => String((c.body as Record<string, unknown>)["text"]).includes("try again")));
});

test("a voice message whose transcribeFn rejects sends a text reply asking Gary to retry or type it, and never reaches runTurn", async () => {
  const voiceUpdate = {
    ok: true,
    result: [
      { update_id: 1, message: { message_id: 1, chat: { id: 12345 }, from: { id: 12345 }, voice: { file_id: "voice_id", duration: 2 } } },
    ],
  };
  const calls: { url: string; body: unknown }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    if (url.includes("/getUpdates")) return { ok: true, json: async () => voiceUpdate } as Response;
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  const runTurnStub: BridgeRunTurn = async () => { throw new Error("runTurn should not be called"); };

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    downloadFileFn: async () => {},
    transcribeFn: async () => { throw new Error("empty transcript"); },
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();

  const sendCalls = calls.filter((c) => c.url.includes("/sendMessage"));
  assert.ok(sendCalls.some((c) => /retry|type it/.test(String((c.body as Record<string, unknown>)["text"]))));
});

test("a voice message's temp file is cleaned up after transcription succeeds", async () => {
  const voiceUpdate = {
    ok: true,
    result: [
      { update_id: 1, message: { message_id: 1, chat: { id: 12345 }, from: { id: 12345 }, voice: { file_id: "voice_id", duration: 2 } } },
    ],
  };
  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/getUpdates")) return { ok: true, json: async () => voiceUpdate } as Response;
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  const unlinked: string[] = [];
  const fsFn = { ...defaultFsFn(), unlink: (path: string) => { unlinked.push(path); } };

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async (_input, emit) => emit("ok", "text"),
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    downloadFileFn: async () => {},
    transcribeFn: async () => "hi",
    fsFn,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();

  assert.ok(unlinked.some((p) => p.includes("voice_id.ogg")));
});

function voiceReplyUpdate(fileId: string) {
  return {
    ok: true,
    result: [
      { update_id: 1, message: { message_id: 1, chat: { id: 12345 }, from: { id: 12345 }, voice: { file_id: fileId, duration: 2 } } },
    ],
  };
}

test("a voice-origin turn synthesizes, converts, and sends the reply as a voice note instead of text", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    if (url.includes("/getUpdates")) return { ok: true, json: async () => voiceReplyUpdate("v1") } as Response;
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  let synthArgs: [string, string] | undefined;
  let convertArgs: [string, string] | undefined;
  let sendVoiceArgs: [unknown, string] | undefined;

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async (_input, emit) => emit("Nothing on today.", "text"),
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    downloadFileFn: async () => {},
    transcribeFn: async () => "what's on today",
    synthesizeFn: async (text, outPath) => { synthArgs = [text, outPath]; },
    convertToOggFn: async (wavPath, oggPath) => { convertArgs = [wavPath, oggPath]; },
    sendVoiceFn: async (cfg, audioPath) => { sendVoiceArgs = [cfg, audioPath]; },
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();

  assert.ok(synthArgs, "expected synthesizeFn to be called");
  assert.equal(synthArgs![0], "Nothing on today.");
  assert.ok(convertArgs, "expected convertToOggFn to be called");
  assert.equal(convertArgs![0], synthArgs![1]);
  assert.ok(sendVoiceArgs, "expected sendVoiceFn to be called");
  assert.equal(sendVoiceArgs![1], convertArgs![1]);
  const sendMessageCalls = calls.filter((c) => c.url.includes("/sendMessage"));
  assert.equal(sendMessageCalls.length, 0, "a successful voice reply must not also send a text message");
});

test("a voice-origin turn sends the spoken text's character count as the voice note's caption", async () => {
  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/getUpdates")) return { ok: true, json: async () => voiceReplyUpdate("v1b") } as Response;
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  let sendVoiceArgs: [unknown, string, string | undefined] | undefined;

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async (_input, emit) => emit("Nothing on today.", "text"),
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    downloadFileFn: async () => {},
    transcribeFn: async () => "what's on today",
    synthesizeFn: async () => {},
    convertToOggFn: async () => {},
    sendVoiceFn: async (cfg, audioPath, caption) => { sendVoiceArgs = [cfg, audioPath, caption]; },
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();

  assert.ok(sendVoiceArgs, "expected sendVoiceFn to be called");
  assert.equal(sendVoiceArgs![2], "17 chars", `"Nothing on today." is 17 chars`);
});

test("a voice-origin turn logs the spoken text's character count server-side", async () => {
  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/getUpdates")) return { ok: true, json: async () => voiceReplyUpdate("v1c") } as Response;
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  const logLines: string[] = [];
  const originalConsoleLog = console.log;
  console.log = (...args: unknown[]) => { logLines.push(args.map(String).join(" ")); };

  try {
    const bridge = createBridge({
      ...basePushOpts(),
      config: { token: "t", chatId: "12345", transport },
      runTurn: async (_input, emit) => emit("Nothing on today.", "text"),
      getSessionId: () => undefined,
      resetSession: () => {},
      pollIntervalMs: 5,
      downloadFileFn: async () => {},
      transcribeFn: async () => "what's on today",
      synthesizeFn: async () => {},
      convertToOggFn: async () => {},
      sendVoiceFn: async () => {},
    });

    await bridge.drainOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await bridge.stop();

    assert.ok(
      logLines.some((l) => l.includes("voice reply") && l.includes("17 chars")),
      `expected a char-count log line, got: ${JSON.stringify(logLines)}`,
    );
  } finally {
    console.log = originalConsoleLog;
  }
});

test("a voice-origin turn whose synthesis fails falls back to sending the reply as text", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    if (url.includes("/getUpdates")) return { ok: true, json: async () => voiceReplyUpdate("v2") } as Response;
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async (_input, emit) => emit("Here's your update.", "text"),
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    downloadFileFn: async () => {},
    transcribeFn: async () => "give me an update",
    synthesizeFn: async () => { throw new Error("mlx-audio crashed"); },
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();

  const sendCalls = calls.filter((c) => c.url.includes("/sendMessage"));
  assert.ok(sendCalls.some((c) => (c.body as Record<string, unknown>)["text"] === "Here's your update."));
});

test("a turn that outruns turnTimeoutMs is aborted, tells Gary, and does not wedge the queue", async () => {
  const { transport, calls } = makeStubTransport([
    messageUpdate(1, "first"),
    messageUpdate(2, "second"),
    { ok: true, result: [] },
  ]);
  const seen: string[] = [];
  let abortedFirst = false;
  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    // The first turn never resolves on its own — it only ends when the
    // watchdog aborts it, exactly like a hung upstream API call.
    runTurn: async (input, emit, signal) => {
      seen.push(input);
      if (input === "first") {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => { abortedFirst = true; resolve(); });
        });
        return;
      }
      emit("second reply", "text");
    },
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    turnTimeoutMs: 30,
  });

  await bridge.drainOnce();
  // drainOnce() fetches exactly one getUpdates batch (one stub entry), so
  // "second" only enters the fifo once a further poll cycle runs — drive one
  // now, while "first" is still blocked in-flight inside the fire-and-forget
  // drainFifo() from the call above (that drainFifo() will no-op here since
  // draining is already true, but it queues "second" for the original
  // drainFifo()'s while-loop to pick up once the watchdog aborts "first").
  await bridge.drainOnce();
  // drainFifo is fire-and-forget, so poll until the queue has actually drained
  // past the aborted turn rather than guessing at a sleep duration.
  for (let i = 0; i < 100 && seen.length < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await bridge.stop();

  // The hung turn was cut off rather than awaited forever...
  assert.equal(abortedFirst, true);
  // ...Gary was told why, instead of getting silence...
  const texts = calls
    .filter((c) => c.url.includes("/sendMessage"))
    .map((c) => String((c.body as Record<string, unknown>)?.["text"] ?? ""));
  assert.ok(texts.some((t) => t.includes("cut it off")), `expected a timeout notice, got: ${JSON.stringify(texts)}`);
  // ...with the escalation ramp offering the background-it path.
  assert.ok(texts.some((t) => t.includes("background it")), `expected the notice to offer backgrounding, got: ${JSON.stringify(texts)}`);
  // ...and the queue kept draining instead of wedging behind it. The second
  // turn's input additionally carries the abort-artifact prefix (RCA item 6),
  // so match on the operator's own message rather than exact equality.
  assert.equal(seen.length, 2);
  assert.equal(seen[0], "first");
  assert.ok(seen[1]!.endsWith("second"), `expected the queued message to run, got: ${JSON.stringify(seen[1])}`);
});

test("a timed-out turn does not log 'turn completed in <ms>ms'", async () => {
  // The mutual exclusion between "timed out" and "completed" is currently
  // held by code structure alone (which branch of the if/else runs) — with
  // no test coverage, a future edit that hoists the completed-log out of the
  // else (or adds an unconditional one after the if/else) would regress
  // silently with the suite green.
  const { transport } = makeStubTransport([
    messageUpdate(1, "hung"),
    { ok: true, result: [] },
  ]);

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    // Never resolves on its own — only ends when the watchdog aborts it.
    runTurn: async (_input, _emit, signal) => {
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve());
      });
    },
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    turnTimeoutMs: 30,
  });

  const logSpy: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { logSpy.push(args.map(String).join(" ")); };
  try {
    await bridge.drainOnce();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await bridge.stop();
  } finally {
    console.log = originalLog;
  }

  assert.ok(
    logSpy.every((line) => !line.includes("turn completed")),
    `expected no "turn completed" log line for a timed-out turn, got: ${JSON.stringify(logSpy)}`,
  );
});

test("a turn that IGNORES its abort signal still does not wedge the queue", async () => {
  // The load-bearing assumption of the watchdog is that abort() unblocks a
  // hung SDK call. If it doesn't — a parked socket read that never observes
  // the signal — awaiting runTurn alone would leave the queue wedged exactly
  // as in the original bug. This turn never resolves and never listens for
  // abort; the drain loop must proceed regardless.
  const { transport, calls } = makeStubTransport([
    messageUpdate(1, "hung"),
    messageUpdate(2, "after"),
    { ok: true, result: [] },
  ]);
  const seen: string[] = [];
  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async (input, emit) => {
      seen.push(input);
      if (input === "hung") {
        await new Promise<void>(() => {});   // never resolves, ignores the signal
        return;
      }
      emit("after reply", "text");
    },
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    turnTimeoutMs: 30,
  });

  await bridge.drainOnce();
  await bridge.drainOnce();
  for (let i = 0; i < 100 && seen.length < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await bridge.stop();

  // The second input additionally carries the abort-artifact prefix (RCA item
  // 6), so match on the operator's own message rather than exact equality.
  assert.equal(seen.length, 2, "the abandoned turn must not block the next message");
  assert.equal(seen[0], "hung");
  assert.ok(seen[1]!.endsWith("after"), `expected the queued message to run, got: ${JSON.stringify(seen[1])}`);
  const texts = calls
    .filter((c) => c.url.includes("/sendMessage"))
    .map((c) => String((c.body as Record<string, unknown>)?.["text"] ?? ""));
  assert.ok(texts.some((t) => t.includes("cut it off")), `expected a timeout notice, got: ${JSON.stringify(texts)}`);
});

test("a normal completed turn logs its duration: 'turn completed in <ms>ms'", async () => {
  // The timed-out path already logs its own "turn exceeded" line — this test
  // covers the non-timed-out path, which needs its own instrument (hard
  // problem 5 in the plan) so the 10-minute constant becomes data-backed
  // over time instead of anecdote.
  const { transport } = makeStubTransport([
    messageUpdate(1, "hello"),
    { ok: true, result: [] },
  ]);

  const runTurnStub: BridgeRunTurn = async (input, emit) => {
    emit(`echo: ${input}`, "text");
  };

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  const logSpy: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { logSpy.push(args.map(String).join(" ")); };
  try {
    await bridge.drainOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await bridge.stop();
  } finally {
    console.log = originalLog;
  }

  assert.ok(
    logSpy.some((line) => /\[telegram-bridge\] turn completed in \d+ms/.test(line)),
    `expected a "turn completed in <ms>ms" log line, got: ${JSON.stringify(logSpy)}`,
  );
});

test("bridge log lines are prefixed with an ISO-8601 timestamp from the injected clock", async () => {
  // Every createBridge call in this suite spreads basePushOpts(), which pins
  // nowFn to DAYTIME (2026-07-15T11:00:00Z) — the log helper must read that
  // same seam, not a real wall clock, so the prefix is deterministic here.
  const { transport } = makeStubTransport([
    messageUpdate(1, "hello"),
    { ok: true, result: [] },
  ]);

  const runTurnStub: BridgeRunTurn = async (input, emit) => {
    emit(`echo: ${input}`, "text");
  };

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  const logSpy: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { logSpy.push(args.map(String).join(" ")); };
  try {
    await bridge.drainOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await bridge.stop();
  } finally {
    console.log = originalLog;
  }

  assert.ok(
    logSpy.some((line) => line.startsWith("[2026-07-15T11:00:00.000Z] [telegram-bridge] turn completed in")),
    `expected the turn-completed line to carry the injected clock's ISO timestamp prefix, got: ${JSON.stringify(logSpy)}`,
  );
});

test("a turn that throws does not log 'turn completed in <ms>ms'", async () => {
  // A turn caught by the try/catch is not a completed turn — logging it as
  // one would contaminate the duration data the "turn completed" instrument
  // exists to collect (hard problem 5 in the plan).
  const { transport } = makeStubTransport([
    messageUpdate(1, "hello"),
    { ok: true, result: [] },
  ]);

  const runTurnStub: BridgeRunTurn = async () => {
    throw new Error("boom");
  };

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  const logSpy: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { logSpy.push(args.map(String).join(" ")); };
  try {
    await bridge.drainOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await bridge.stop();
  } finally {
    console.log = originalLog;
  }

  assert.ok(
    !logSpy.some((line) => /\[telegram-bridge\] turn completed in \d+ms/.test(line)),
    `expected no "turn completed in <ms>ms" log line for an errored turn, got: ${JSON.stringify(logSpy)}`,
  );
});

// ---------------------------------------------------------------------------
// RCA 2026-07-23 ghost-rejection hardening — items 6, 8, 9.
// ---------------------------------------------------------------------------

test("RCA item 6: after a deadline abort the NEXT turn's input is prefixed with an artifact note", async () => {
  // Mechanism A in the RCA: when the 10-minute deadline aborts a turn, the
  // harness injects "The user doesn't want to proceed with this tool use"
  // for the in-flight tool call. On the following turn that residue is in
  // session context and reads as a real refusal by the operator. Seeding the
  // next turn's INPUT (not just the user-facing buffer, which the timedOut
  // branch already handles) is what stops that misreading.
  const { transport } = makeStubTransport([
    messageUpdate(1, "hung"),
    messageUpdate(2, "what happened?"),
    { ok: true, result: [] },
  ]);
  const seen: string[] = [];
  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async (input, emit, signal) => {
      seen.push(input);
      if (input.includes("hung")) {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve());
        });
        return;
      }
      emit("ok", "text");
    },
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    turnTimeoutMs: 30,
  });

  await bridge.drainOnce();
  await bridge.drainOnce();
  for (let i = 0; i < 100 && seen.length < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await bridge.stop();

  assert.equal(seen.length, 2, `expected both turns to run, got: ${JSON.stringify(seen)}`);
  // The aborted turn itself is NOT prefixed — nothing preceded it.
  assert.equal(seen[0], "hung");
  // The next turn is, and the operator's own words survive intact after it.
  assert.ok(
    seen[1]!.includes("aborted by the bridge"),
    `expected the next turn's input to carry an abort-artifact note, got: ${JSON.stringify(seen[1])}`,
  );
  assert.ok(
    seen[1]!.endsWith("what happened?"),
    `expected the operator's message to be preserved verbatim at the end, got: ${JSON.stringify(seen[1])}`,
  );
});

test("RCA item 6: the abort-artifact prefix is one-shot — it does not leak into a third turn", async () => {
  // The note describes the immediately preceding turn. Left sticky it would
  // assert an abort that did not happen, which is its own ghost.
  const { transport } = makeStubTransport([
    messageUpdate(1, "hung"),
    messageUpdate(2, "second"),
    messageUpdate(3, "third"),
    { ok: true, result: [] },
  ]);
  const seen: string[] = [];
  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async (input, emit, signal) => {
      seen.push(input);
      if (input.includes("hung")) {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve());
        });
        return;
      }
      emit("ok", "text");
    },
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    turnTimeoutMs: 30,
  });

  await bridge.drainOnce();
  await bridge.drainOnce();
  await bridge.drainOnce();
  for (let i = 0; i < 100 && seen.length < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await bridge.stop();

  assert.equal(seen.length, 3, `expected three turns, got: ${JSON.stringify(seen)}`);
  assert.ok(seen[1]!.includes("aborted by the bridge"));
  assert.equal(seen[2], "third", "the third turn must be unprefixed — no abort preceded it");
});

test("RCA item 6: a normally completed turn never prefixes the next one", async () => {
  const { transport } = makeStubTransport([
    messageUpdate(1, "first"),
    messageUpdate(2, "second"),
    { ok: true, result: [] },
  ]);
  const seen: string[] = [];
  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async (input, emit) => { seen.push(input); emit("ok", "text"); },
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  await bridge.drainOnce();
  await bridge.drainOnce();
  for (let i = 0; i < 100 && seen.length < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await bridge.stop();

  assert.deepEqual(seen, ["first", "second"]);
});

test("RCA item 6: /reset clears a pending abort notice — a fresh session has no residue to explain", async () => {
  // The flag lives in createBridge's closure, so it outlives the SDK session
  // that /reset clears. Left set, the next turn would assert an abort into a
  // context holding none of its residue — the same false attribution item 6
  // exists to prevent, just pointing the other way.
  const { transport } = makeStubTransport([
    messageUpdate(1, "hung"),
    messageUpdate(2, "/reset"),
    messageUpdate(3, "fresh start"),
    { ok: true, result: [] },
  ]);
  const seen: string[] = [];
  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async (input, emit, signal) => {
      seen.push(input);
      if (input.includes("hung")) {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve());
        });
        return;
      }
      emit("ok", "text");
    },
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    turnTimeoutMs: 30,
  });

  // Poll 1 starts the hung turn; wait for the 30ms deadline to actually abort
  // it before /reset arrives. Draining all three polls back-to-back would let
  // /reset run BEFORE the abort sets the flag, which tests nothing.
  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 80));
  // Poll 2 delivers /reset (handled bridge-side, never queued).
  await bridge.drainOnce();
  // Poll 3 delivers the post-reset message.
  await bridge.drainOnce();
  for (let i = 0; i < 100 && seen.length < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await bridge.stop();

  // /reset is handled bridge-side and never reaches runTurn, so the turns
  // seen are the aborted one and the post-reset one.
  assert.equal(seen.length, 2, `expected two turns, got: ${JSON.stringify(seen)}`);
  assert.equal(seen[0], "hung");
  assert.equal(seen[1], "fresh start", "a post-/reset turn must carry no abort-artifact prefix");
});

test("RCA item 8: a turn logs its start plus the FIFO depth at that moment", async () => {
  // Only completion/abort were logged before this, which is exactly why the
  // RCA had to cross-reference SDK session JSONL to establish when a turn
  // began. A start line with queue depth makes the bridge log self-sufficient.
  const { transport } = makeStubTransport([
    messageUpdate(1, "hello"),
    { ok: true, result: [] },
  ]);

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async (_input, emit) => { emit("hi", "text"); },
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  const logSpy: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { logSpy.push(args.map(String).join(" ")); };
  try {
    await bridge.drainOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await bridge.stop();
  } finally {
    console.log = originalLog;
  }

  assert.ok(
    logSpy.some((line) => /\[telegram-bridge\] turn started \(queue depth 0\)/.test(line)),
    `expected a "turn started (queue depth N)" log line, got: ${JSON.stringify(logSpy)}`,
  );
});

test("RCA item 8: the turn-start line reports the real backlog when messages are queued", async () => {
  // Depth is what makes the line diagnostic: a turn starting behind a backlog
  // is the signature of the single-flight drain falling behind.
  const { transport } = makeStubTransport([
    { ok: true, result: [
      { update_id: 1, message: { message_id: 1, chat: { id: 12345 }, text: "one" } },
      { update_id: 2, message: { message_id: 2, chat: { id: 12345 }, text: "two" } },
      { update_id: 3, message: { message_id: 3, chat: { id: 12345 }, text: "three" } },
    ] },
    { ok: true, result: [] },
  ]);

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async (_input, emit) => { emit("ok", "text"); },
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  const logSpy: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { logSpy.push(args.map(String).join(" ")); };
  try {
    await bridge.drainOnce();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await bridge.stop();
  } finally {
    console.log = originalLog;
  }

  const startLines = logSpy.filter((line) => line.includes("turn started"));
  assert.equal(startLines.length, 3, `expected one start line per turn, got: ${JSON.stringify(logSpy)}`);
  // Depths are the remaining backlog at each turn's start: 2, then 1, then 0.
  assert.ok(startLines[0]!.includes("queue depth 2"), `got: ${startLines[0]}`);
  assert.ok(startLines[1]!.includes("queue depth 1"), `got: ${startLines[1]}`);
  assert.ok(startLines[2]!.includes("queue depth 0"), `got: ${startLines[2]}`);
});

test("RCA item 9: a synthesis failure truncates the error detail in the log", async () => {
  // One real failure wrote a 9,696-char private reply into the bridge log:
  // synthesize.py is invoked with the reply text as argv, so an execFile
  // timeout error echoes the whole reply back in its message. The log must
  // stay diagnostic without becoming a transcript of Gary's private replies.
  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/getUpdates")) return { ok: true, json: async () => voiceReplyUpdate("v-trunc") } as Response;
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };
  const secret = "SECRET".repeat(2000);   // 12,000 chars, as if the reply leaked into the error
  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async (_input, emit) => emit("reply text", "text"),
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    downloadFileFn: async () => {},
    transcribeFn: async () => "say something",
    synthesizeFn: async () => { throw new Error(`synthesize failed (exit 1): ${secret}`); },
    convertToOggFn: async () => {},
    sendVoiceFn: async () => {},
  });

  const errSpy: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errSpy.push(args.map(String).join(" ")); };
  try {
    await bridge.drainOnce();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await bridge.stop();
  } finally {
    console.error = originalError;
  }

  const failureLine = errSpy.find((line) => line.includes("voice reply synthesis failed"));
  assert.ok(failureLine, `expected a synthesis-failure log line, got: ${JSON.stringify(errSpy)}`);
  assert.ok(
    failureLine!.length < 1000,
    `expected the failure line to be capped well under the 12k error detail, got ${failureLine!.length} chars`,
  );
  // The head of the detail survives — the cap must not destroy diagnosability.
  assert.ok(
    failureLine!.includes("synthesize failed (exit 1)"),
    `expected the leading diagnostic to survive truncation, got: ${failureLine}`,
  );
  // ...and the truncation is announced rather than silent.
  assert.ok(
    failureLine!.includes("truncated"),
    `expected the line to mark itself truncated, got: ${failureLine}`,
  );
});

test("RCA item 9: a short synthesis error is logged intact, with no truncation marker", async () => {
  // The cap must be a ceiling, not a reformat — ordinary failures keep their
  // full message.
  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/getUpdates")) return { ok: true, json: async () => voiceReplyUpdate("v-short") } as Response;
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };
  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async (_input, emit) => emit("reply text", "text"),
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    downloadFileFn: async () => {},
    transcribeFn: async () => "say something",
    synthesizeFn: async () => { throw new Error("ffmpeg not found"); },
    convertToOggFn: async () => {},
    sendVoiceFn: async () => {},
  });

  const errSpy: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errSpy.push(args.map(String).join(" ")); };
  try {
    await bridge.drainOnce();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await bridge.stop();
  } finally {
    console.error = originalError;
  }

  const failureLine = errSpy.find((line) => line.includes("voice reply synthesis failed"));
  assert.ok(failureLine, `expected a synthesis-failure log line, got: ${JSON.stringify(errSpy)}`);
  assert.ok(failureLine!.includes("ffmpeg not found"), `got: ${failureLine}`);
  assert.ok(!failureLine!.includes("truncated"), `short errors must not be marked truncated, got: ${failureLine}`);
});

test("a voice-origin turn answers in voice regardless of reply length — no character cap", async () => {
  const longReply = "x".repeat(5000);
  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/getUpdates")) return { ok: true, json: async () => voiceReplyUpdate("v3") } as Response;
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };
  let synthesizedText: string | undefined;
  let voiceSent = false;
  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async (_input, emit) => emit(longReply, "text"),
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    downloadFileFn: async () => {},
    transcribeFn: async () => "tell me everything",
    synthesizeFn: async (text) => { synthesizedText = text; },
    convertToOggFn: async () => {},
    sendVoiceFn: async () => { voiceSent = true; },
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();

  // The full reply is synthesized and delivered as voice — never truncated,
  // never silently downgraded to text on length alone.
  assert.equal(synthesizedText, longReply);
  assert.equal(voiceSent, true);
});

test("a text-origin turn never calls synthesizeFn/convertToOggFn/sendVoiceFn", async () => {
  const { transport } = makeStubTransport([
    messageUpdate(1, "hello"),
    { ok: true, result: [] },
  ]);
  let called = false;
  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async (_input, emit) => emit("hi back", "text"),
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    synthesizeFn: async () => { called = true; },
    convertToOggFn: async () => { called = true; },
    sendVoiceFn: async () => { called = true; },
  });
  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();
  assert.equal(called, false);
});

test("temp wav/ogg files from a voice reply are cleaned up after sendVoiceFn succeeds", async () => {
  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/getUpdates")) return { ok: true, json: async () => voiceReplyUpdate("v4") } as Response;
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };
  const unlinked: string[] = [];
  const fsFn = { ...defaultFsFn(), unlink: (path: string) => { unlinked.push(path); } };

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async (_input, emit) => emit("ok", "text"),
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    downloadFileFn: async () => {},
    transcribeFn: async () => "hi",
    synthesizeFn: async () => {},
    convertToOggFn: async () => {},
    sendVoiceFn: async () => {},
    fsFn,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();

  assert.ok(unlinked.some((p) => p.endsWith(".wav")));
  assert.ok(unlinked.some((p) => p.endsWith(".ogg")));
});

// ---------------------------------------------------------------------------
// Chokepoint routing — startup notice, watchdog pings, and health-transition
// alerts go through proactive/push.ts's push() (family store + deferred.json
// under pushBaseDir); only the FATAL 5x409 exit alert stays a direct awaited
// sendChunked.
// ---------------------------------------------------------------------------

test("the startup notice is deferred to the push store during quiet hours instead of being sent", async () => {
  const sendMessages: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/getUpdates")) {
      return { ok: true, json: async () => ({ ok: true, result: [] }) } as Response;
    }
    if (url.includes("/sendMessage")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      sendMessages.push(String(body.text ?? ""));
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  const pushSeams = basePushOpts();
  const bridge = createBridge({
    ...pushSeams,
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {},
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    nowFn: QUIET_TIME,
  });

  const runPromise = bridge.run();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await bridge.stop();
  await runPromise;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(!sendMessages.some((m) => m.toLowerCase().includes("started")), `no immediate startup send in quiet hours: ${JSON.stringify(sendMessages)}`);
  const deferred = readDeferred(pushSeams.pushBaseDir);
  const startupEntry = deferred.entries.find((e) => e.family === "bridge-startup");
  assert.ok(startupEntry, `startup notice queued in deferred.json (a 3am crash-restart lands in the morning digest): ${JSON.stringify(deferred)}`);
  assert.equal(startupEntry.event_id, "bridge:startup");
  assert.equal(startupEntry.reason, "quiet");
});

test("startup-alert re-entry: run() driven twice on one bridge sends exactly one 'started' alert (chokepoint dedup)", async () => {
  const sendMessages: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/getUpdates")) {
      return { ok: true, json: async () => ({ ok: true, result: [] }) } as Response;
    }
    if (url.includes("/sendMessage")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      sendMessages.push(String(body.text ?? ""));
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {},
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  // First run(): note stop() latches `stopped`, so the second run() exits its
  // loop immediately — but its startup push still fires, which is the
  // re-entry being pinned here.
  const firstRun = bridge.run();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await bridge.stop();
  await firstRun;
  const secondRun = bridge.run();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await secondRun;
  await new Promise((resolve) => setTimeout(resolve, 0));

  const startedAlerts = sendMessages.filter((m) => m.toLowerCase().includes("started"));
  assert.equal(startedAlerts.length, 1, `re-entering run() must not re-announce startup — got: ${JSON.stringify(startedAlerts)}`);
});

test("a watchdog stall ping is deferred to the push store during quiet hours — no transport send, no synthetic turn", async () => {
  const now = Date.now();
  const watchdogDir = "/fake/watchdog";
  const watchdogPath = watchdogDir + "/quiet-loop.watchdog.json";
  const progressPath = "/fake/quiet-progress.json";

  const entry = makeWatchdogEntry({
    slug: "quiet-loop",
    loop_name: "Quiet Loop",
    pid: 22222,
    progress_json_path: progressPath,
    spawn_time: now - 70 * 60 * 1000,
    last_check: null,
    pinged_at: null,
    done: false,
  });

  const fsFn = makeStubFs({
    watchdogDir,
    files: new Map([
      [watchdogPath, JSON.stringify(entry)],
      [progressPath, JSON.stringify({ status: "in_progress" })],
    ]),
    mtimes: new Map([[progressPath, now - 61 * 60 * 1000]]),
  });

  const { transport, calls } = makeStubTransport([{ ok: true, result: [] }]);
  const pushSeams = basePushOpts();
  let dispatched = false;

  const bridge = createBridge({
    ...pushSeams,
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => { dispatched = true; },
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    watchdogDir,
    fsFn,
    isPidAliveFn: () => true,
    nowFn: QUIET_TIME,
  });

  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bridge.stop();

  const sendCalls = calls.filter((c) => c.url.includes("/sendMessage"));
  assert.equal(sendCalls.length, 0, `nothing goes out over the transport in quiet hours: ${JSON.stringify(sendCalls)}`);
  assert.equal(dispatched, false, "no synthetic turn is injected");
  const deferred = readDeferred(pushSeams.pushBaseDir);
  const stallEntry = deferred.entries.find((e) => e.family === "loop-watchdog");
  assert.ok(stallEntry, `stall ping queued in deferred.json: ${JSON.stringify(deferred)}`);
  assert.equal(stallEntry.event_id, "loop-stall:quiet-loop");
  assert.equal(stallEntry.reason, "quiet");
});

test("the conflict-entry health alert defers during quiet hours while the FATAL 5x409 exit alert is still sent directly", async () => {
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

  const pushSeams = basePushOpts();
  const bridge = createBridge({
    ...pushSeams,
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {},
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    conflictBackoffMs: 5,
    nowFn: QUIET_TIME,
  });

  const originalExit = process.exit;
  const exitOrder: string[] = [];
  process.exit = ((_code?: number) => {
    exitOrder.push("exit");
    throw new Error("process.exit stub halting run()");
  }) as typeof process.exit;

  try {
    await assert.rejects(() => bridge.run(), /process\.exit stub/);
  } finally {
    process.exit = originalExit;
  }

  const fatalAlerts = sendMessages.filter((m) => m.toUpperCase().includes("FATAL"));
  assert.equal(fatalAlerts.length, 1, `the FATAL exit alert bypasses quiet hours via direct send: ${JSON.stringify(sendMessages)}`);
  assert.ok(
    !sendMessages.some((m) => m.toLowerCase().includes("conflict detected")),
    `the conflict-entry alert must NOT go out during quiet hours: ${JSON.stringify(sendMessages)}`,
  );
  const deferred = readDeferred(pushSeams.pushBaseDir);
  const healthEntry = deferred.entries.find((e) => e.family === "bridge-health");
  assert.ok(healthEntry, `conflict-entry alert queued in deferred.json: ${JSON.stringify(deferred)}`);
  assert.equal(healthEntry.event_id, "bridge:health");
});

test("a push() failure falls back to a direct send so the startup alert is never lost to the chokepoint plumbing", async () => {
  const sendMessages: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/getUpdates")) {
      return { ok: true, json: async () => ({ ok: true, result: [] }) } as Response;
    }
    if (url.includes("/sendMessage")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      sendMessages.push(String(body.text ?? ""));
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };

  const pushSeams = basePushOpts();
  // A corrupt family store makes push() throw loudly for this family — the
  // bridge must catch and fall back to a direct send.
  const { mkdirSync: realMkdirSync, writeFileSync: realWriteFileSync } = await import("node:fs");
  realMkdirSync(pushSeams.pushBaseDir, { recursive: true });
  realWriteFileSync(join(pushSeams.pushBaseDir, "bridge-startup.json"), "not json {");

  const bridge = createBridge({
    ...pushSeams,
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {},
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
  });

  const runPromise = bridge.run();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await bridge.stop();
  await runPromise;
  await new Promise((resolve) => setTimeout(resolve, 0));

  const startedAlerts = sendMessages.filter((m) => m.toLowerCase().includes("started"));
  assert.equal(startedAlerts.length, 1, `startup alert delivered via the direct-send fallback: ${JSON.stringify(sendMessages)}`);
});

// ---------------------------------------------------------------------------
// Heartbeat tests — the bridge writes ~/.rachel/bridge-heartbeat.json (path
// injectable via heartbeatPath) atomically on every poll iteration.
// ---------------------------------------------------------------------------

test("each poll iteration atomically writes the heartbeat with the exact four-key shape and an advancing last_poll_at", async () => {
  const { transport } = makeStubTransport([{ ok: true, result: [] }]);
  const watchdogDir = "/fake/watchdog";
  const heartbeatPath = "/fake/hb/bridge-heartbeat.json";
  const fsFn = makeStubFs({ watchdogDir });

  let nowMs = new Date("2026-07-15T11:00:00Z").getTime();
  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {},
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    watchdogDir,
    fsFn,
    isPidAliveFn: () => false,
    heartbeatPath,
    nowFn: () => new Date(nowMs),
    pushBaseDir: mkdtempSync(join(tmpdir(), "rachel-bridge-push-")),
  });

  await bridge.drainOnce();
  const first = JSON.parse(fsFn.readFile(heartbeatPath)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(first).sort(), ["last_poll_at", "queue_depth", "schema_version", "turn_in_flight_since"]);
  assert.equal(first["schema_version"], 1);
  assert.equal(first["queue_depth"], 0);
  assert.equal(first["turn_in_flight_since"], null);
  assert.ok(!Number.isNaN(Date.parse(String(first["last_poll_at"]))), "last_poll_at is a parseable timestamp");

  nowMs += 5000;
  await bridge.drainOnce();
  const second = JSON.parse(fsFn.readFile(heartbeatPath)) as Record<string, unknown>;
  assert.ok(
    Date.parse(String(second["last_poll_at"])) > Date.parse(String(first["last_poll_at"])),
    "last_poll_at strictly advances between iterations",
  );

  // Atomicity: every heartbeat write is temp-file-then-rename in the same
  // directory (push.ts idiom) — never a direct write to the final path.
  assert.ok(
    fsFn.written.every((w) => w.path !== heartbeatPath),
    "no direct write to the final heartbeat path",
  );
  const tmpWrites = fsFn.written.filter((w) => w.path.startsWith(`${heartbeatPath}.tmp-`));
  assert.equal(tmpWrites.length, 2, "one temp write per poll iteration");
  assert.ok(
    fsFn.renames.some((r) => r.from.startsWith(`${heartbeatPath}.tmp-`) && r.to === heartbeatPath),
    `temp file renamed onto the heartbeat path, got renames: ${JSON.stringify(fsFn.renames)}`,
  );
  await bridge.stop();
});

test("the heartbeat carries turn_in_flight_since while a turn is draining and null once it completes, with queue_depth counting waiting turns", async () => {
  const { transport } = makeStubTransport([
    {
      ok: true,
      result: [
        { update_id: 1, message: { message_id: 1, chat: { id: 12345 }, text: "slow task", from: { id: 12345 } } },
        { update_id: 2, message: { message_id: 2, chat: { id: 12345 }, text: "queued behind it", from: { id: 12345 } } },
      ],
    },
    { ok: true, result: [] },
  ]);
  const watchdogDir = "/fake/watchdog";
  const heartbeatPath = "/fake/hb/bridge-heartbeat.json";
  const fsFn = makeStubFs({ watchdogDir });

  let releaseTurn: (() => void) | undefined;
  let turnCount = 0;
  const runTurnStub: BridgeRunTurn = (_input, emit) =>
    new Promise<void>((resolve) => {
      turnCount++;
      if (turnCount === 1) {
        releaseTurn = () => {
          emit("done", "text");
          resolve();
        };
      } else {
        emit("ok", "text");
        resolve();
      }
    });

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    watchdogDir,
    fsFn,
    isPidAliveFn: () => false,
    heartbeatPath,
    pushBaseDir: mkdtempSync(join(tmpdir(), "rachel-bridge-push-")),
  });

  try {
    await bridge.drainOnce();
    // The first turn is now blocked in-flight; the second message waits in the FIFO.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await bridge.drainOnce();
    const during = JSON.parse(fsFn.readFile(heartbeatPath)) as Record<string, unknown>;
    assert.ok(during["turn_in_flight_since"] !== null, "turn_in_flight_since set while a turn is draining");
    assert.ok(!Number.isNaN(Date.parse(String(during["turn_in_flight_since"]))), "turn_in_flight_since is a parseable timestamp");
    assert.equal(during["queue_depth"], 1, "the queued second message is counted");

    releaseTurn!();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await bridge.drainOnce();
    const after = JSON.parse(fsFn.readFile(heartbeatPath)) as Record<string, unknown>;
    assert.equal(after["turn_in_flight_since"], null, "cleared once the drain completes");
    assert.equal(after["queue_depth"], 0);
  } finally {
    // Release the blocked turn even on assertion failure — a forever-pending
    // runTurn plus its typing interval would otherwise hang the test run.
    releaseTurn?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await bridge.stop();
  }
});

test("no heartbeat is written while polls are failing — staleness under backoff is the wedge detector's load-bearing signal", async () => {
  let getUpdatesCalls = 0;
  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/getUpdates")) {
      getUpdatesCalls++;
      throw new Error("ECONNRESET: network down");
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };
  const watchdogDir = "/fake/watchdog";
  const heartbeatPath = "/fake/hb/bridge-heartbeat.json";
  const fsFn = makeStubFs({ watchdogDir });

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {},
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    watchdogDir,
    fsFn,
    isPidAliveFn: () => false,
    heartbeatPath,
  });

  const runPromise = bridge.run();
  // First failure hits the 1000ms initial backoff, the second doubles it —
  // waiting 2200ms spans multiple failing poll/backoff cycles.
  await new Promise((resolve) => setTimeout(resolve, 2200));
  await bridge.stop();
  await runPromise;

  assert.ok(getUpdatesCalls >= 2, `multiple failing poll cycles occurred (got ${getUpdatesCalls})`);
  assert.equal(
    fsFn.written.filter((w) => w.path.includes("bridge-heartbeat")).length,
    0,
    `ZERO heartbeat writes while polling fails — wedge detection reads this staleness: ${JSON.stringify(fsFn.written.map((w) => w.path))}`,
  );
  assert.equal(fsFn.renames.length, 0, "zero heartbeat renames while polling fails");
});

test("a failing heartbeat write never breaks polling and logs once per failure state, not per tick", async () => {
  const { transport, getGetUpdatesCallCount } = makeStubTransport([{ ok: true, result: [] }]);
  const watchdogDir = "/fake/watchdog";
  const heartbeatPath = "/fake/hb/bridge-heartbeat.json";
  const fsFn = makeStubFs({ watchdogDir });
  let failWrites = true;
  const originalWrite = fsFn.writeFile.bind(fsFn);
  fsFn.writeFile = (path: string, content: string) => {
    if (failWrites && path.includes("bridge-heartbeat")) throw new Error("EACCES: heartbeat dir unwritable");
    originalWrite(path, content);
  };

  const errorLines: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    errorLines.push(args.map(String).join(" "));
  };

  try {
    const bridge = createBridge({
      ...basePushOpts(),
      config: { token: "t", chatId: "12345", transport },
      runTurn: async () => {},
      getSessionId: () => undefined,
      resetSession: () => {},
      pollIntervalMs: 5,
      watchdogDir,
      fsFn,
      isPidAliveFn: () => false,
      heartbeatPath,
    });

    await bridge.drainOnce();
    await bridge.drainOnce();
    const heartbeatErrors = () => errorLines.filter((l) => l.includes("heartbeat"));
    assert.equal(heartbeatErrors().length, 1, `one log for the whole failing state, not one per tick: ${JSON.stringify(errorLines)}`);

    failWrites = false;
    await bridge.drainOnce();
    failWrites = true;
    await bridge.drainOnce();
    assert.equal(heartbeatErrors().length, 2, "a recovery then a fresh failure logs again");
    assert.equal(getGetUpdatesCallCount(), 4, "polling never stopped");
    await bridge.stop();
  } finally {
    console.error = originalConsoleError;
  }
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
}): FsFunctions & { written: { path: string; content: string }[]; unlinked: string[]; renames: { from: string; to: string }[] } {
  const files: Map<string, string> = opts.files ?? new Map();
  const mtimes: Map<string, number> = opts.mtimes ?? new Map();
  const globResults: string[] = opts.globResults ?? [];
  const existingDirs: Set<string> = new Set([opts.watchdogDir]);
  const written: { path: string; content: string }[] = [];
  const unlinked: string[] = [];
  const renames: { from: string; to: string }[] = [];

  return {
    written,
    unlinked,
    renames,
    rename(from: string, to: string): void {
      const content = files.get(from);
      if (content === undefined) throw new Error(`ENOENT rename: ${from}`);
      files.delete(from);
      files.set(to, content);
      renames.push({ from, to });
    },
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

  const { transport, calls } = makeStubTransport([{ ok: true, result: [] }]);
  const pushSeams = basePushOpts();

  const bridge = createBridge({
    ...pushSeams,
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

  // The exit ping routes through the push() chokepoint (family
  // loop-watchdog, event loop-exit:<slug>), not through a synthetic Rachel
  // turn — daytime clock, so it delivers immediately via the transport.
  const sent = calls
    .filter((c) => c.url.includes("/sendMessage"))
    .map((c) => String((c.body as Record<string, unknown>)["text"]));
  assert.ok(
    sent.some((s) => /complete:1/.test(s) && /has exited/.test(s)),
    `expected a delivered exit ping containing "complete:1", got: ${JSON.stringify(sent)}`,
  );
  assert.equal(capturedInputs.length, 0, "no synthetic turn is injected — the ping goes via push(), not runTurn");
  const familyStore = JSON.parse(readFileSync(join(pushSeams.pushBaseDir, "loop-watchdog.json"), "utf8")) as {
    events: Record<string, { state: string }>;
  };
  assert.ok(familyStore.events["loop-exit:test-loop"], `loop-exit:<slug> recorded in the store: ${JSON.stringify(familyStore.events)}`);
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

  const { transport, calls } = makeStubTransport([{ ok: true, result: [] }]);
  const pushSeams = basePushOpts();

  const bridge = createBridge({
    ...pushSeams,
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

  // The stall ping routes through the push() chokepoint (family
  // loop-watchdog, event loop-stall:<slug>) — not a synthetic Rachel turn.
  const sent = calls
    .filter((c) => c.url.includes("/sendMessage"))
    .map((c) => String((c.body as Record<string, unknown>)["text"]));
  assert.ok(
    sent.some((s) => /gone quiet/i.test(s) && /Stall Loop/.test(s)),
    `expected a delivered stall ping naming the loop, got: ${JSON.stringify(sent)}`,
  );
  assert.equal(capturedInputs.length, 0, "no synthetic turn is injected — the ping goes via push(), not runTurn");
  const familyStore = JSON.parse(readFileSync(join(pushSeams.pushBaseDir, "loop-watchdog.json"), "utf8")) as {
    events: Record<string, { state: string }>;
  };
  assert.ok(familyStore.events["loop-stall:stall-loop"], `loop-stall:<slug> recorded in the store: ${JSON.stringify(familyStore.events)}`);

  // The watchdog's own pinged_at debounce is KEPT as a layer above the
  // chokepoint dedup: they are not behaviour-equivalent (a sleep/wake bumps
  // the wake_floor into a fresh chokepoint state, which would re-ping a
  // still-stalled loop that pinged_at correctly suppresses).
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
    ...basePushOpts(),
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
    ...basePushOpts(),
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
    ...basePushOpts(),
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
    ...basePushOpts(),
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
      ...basePushOpts(),
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

// ---------------------------------------------------------------------------
// Overlap rule (wake file vs watchdog exit ping)
//
// Spec: on loop exit the agent's OWN wake file is the primary report; the
// watchdog's exit ping demotes to a crash fallback. The exit ping is skipped
// when a slug-matching wake file (pending "<slug>.json" or consumed
// "<slug>.done") NEWER than the loop's spawn_time exists. A loop that crashed
// before writing one still gets the ping — that is what the watchdog is for.
// Stall pings are NEVER suppressed, under any condition.
// ---------------------------------------------------------------------------

// Shared fixture: a watchdog entry plus an optional wake file at a chosen
// mtime. mtime (not created_at) is the freshness source — it comes through
// the same injectable fs.stat seam the rest of the watchdog already uses.
function makeOverlapFixture(opts: {
  slug: string;
  spawnTime: number;
  wakeFile?: { name: string; mtimeMs: number };
  progressMtimeMs?: number;
}) {
  const watchdogDir = "/fake/watchdog";
  const wakeDir = "/fake/wake";
  const watchdogPath = `${watchdogDir}/${opts.slug}.watchdog.json`;
  const progressPath = `/fake/${opts.slug}-progress.json`;

  const entry = makeWatchdogEntry({
    slug: opts.slug,
    loop_name: `Loop ${opts.slug}`,
    pid: 77777,
    progress_json_path: progressPath,
    spawn_time: opts.spawnTime,
    last_check: null,
    pinged_at: null,
    done: false,
  });

  const files = new Map<string, string>([
    [watchdogPath, JSON.stringify(entry)],
    [progressPath, JSON.stringify({ status: "in_progress" })],
  ]);
  const mtimes = new Map<string, number>([
    [progressPath, opts.progressMtimeMs ?? Date.now()],
  ]);
  if (opts.wakeFile) {
    const wakePath = `${wakeDir}/${opts.wakeFile.name}`;
    files.set(wakePath, JSON.stringify({ id: opts.slug, source: `adhoc:${opts.slug}`, mode: "narrate", message: "done" }));
    mtimes.set(wakePath, opts.wakeFile.mtimeMs);
  }

  const fsFn = makeStubFs({ watchdogDir, files, mtimes });
  // makeStubFs only pre-registers watchdogDir as existing; register wakeDir
  // too, since the overlap check guards on existsSync before reading it.
  fsFn.mkdirSync(wakeDir, { recursive: true });
  return { watchdogDir, wakeDir, watchdogPath, fsFn };
}

async function runOverlapBridge(opts: {
  watchdogDir: string;
  wakeDir?: string;
  fsFn: FsFunctions;
  pidAlive: boolean;
}): Promise<string[]> {
  const { transport, calls } = makeStubTransport([{ ok: true, result: [] }]);
  const pushSeams = basePushOpts();
  const bridge = createBridge({
    ...pushSeams,
    config: { token: "t", chatId: "12345", transport },
    runTurn: async (_input, emit) => { emit("ok", "text"); },
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    watchdogDir: opts.watchdogDir,
    ...(opts.wakeDir !== undefined ? { wakeDir: opts.wakeDir } : {}),
    fsFn: opts.fsFn,
    isPidAliveFn: () => opts.pidAlive,
  });
  await bridge.drainOnce();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await bridge.stop();
  return calls
    .filter((c) => c.url.includes("/sendMessage"))
    .map((c) => String((c.body as Record<string, unknown>)["text"]));
}

test("overlap: exit ping is SUPPRESSED when a pending <slug>.json wake file newer than spawn_time exists", async () => {
  const spawnTime = Date.now() - 30 * 60 * 1000;
  const fx = makeOverlapFixture({
    slug: "wake-pending",
    spawnTime,
    wakeFile: { name: "wake-pending.json", mtimeMs: spawnTime + 5 * 60 * 1000 },
  });

  const sent = await runOverlapBridge({ watchdogDir: fx.watchdogDir, wakeDir: fx.wakeDir, fsFn: fx.fsFn, pidAlive: false });

  assert.ok(
    !sent.some((s) => s.includes("[watchdog]") && s.includes("wake-pending") && /exited/i.test(s)),
    `expected the exit ping to be suppressed by the pending wake file, got: ${JSON.stringify(sent)}`,
  );
  // Suppression must still CONSUME the watchdog entry, or it re-evaluates forever.
  assert.ok(
    (fx.fsFn as ReturnType<typeof makeStubFs>).unlinked.includes(fx.watchdogPath),
    `expected the watchdog file to be consumed even when the ping is suppressed, got unlinked: ${JSON.stringify((fx.fsFn as ReturnType<typeof makeStubFs>).unlinked)}`,
  );
});

test("overlap: exit ping is SUPPRESSED when a consumed <slug>.done wake file newer than spawn_time exists", async () => {
  const spawnTime = Date.now() - 30 * 60 * 1000;
  const fx = makeOverlapFixture({
    slug: "wake-done",
    spawnTime,
    wakeFile: { name: "wake-done.done", mtimeMs: spawnTime + 5 * 60 * 1000 },
  });

  const sent = await runOverlapBridge({ watchdogDir: fx.watchdogDir, wakeDir: fx.wakeDir, fsFn: fx.fsFn, pidAlive: false });

  assert.ok(
    !sent.some((s) => s.includes("[watchdog]") && s.includes("wake-done") && /exited/i.test(s)),
    `expected the exit ping to be suppressed by the consumed .done wake file, got: ${JSON.stringify(sent)}`,
  );
});

test("overlap: exit ping FIRES when no wake file exists (the crash-before-wake case)", async () => {
  const spawnTime = Date.now() - 30 * 60 * 1000;
  const fx = makeOverlapFixture({ slug: "no-wake", spawnTime });

  const sent = await runOverlapBridge({ watchdogDir: fx.watchdogDir, wakeDir: fx.wakeDir, fsFn: fx.fsFn, pidAlive: false });

  assert.ok(
    sent.some((s) => s.includes("[watchdog]") && s.includes("no-wake") && /exited/i.test(s)),
    `expected the exit ping to fire with no wake file present, got: ${JSON.stringify(sent)}`,
  );
});

test("overlap: exit ping FIRES when the wake file is OLDER than spawn_time (a previous run's leftover)", async () => {
  const spawnTime = Date.now() - 30 * 60 * 1000;
  const fx = makeOverlapFixture({
    slug: "stale-wake",
    spawnTime,
    wakeFile: { name: "stale-wake.json", mtimeMs: spawnTime - 60 * 60 * 1000 },
  });

  const sent = await runOverlapBridge({ watchdogDir: fx.watchdogDir, wakeDir: fx.wakeDir, fsFn: fx.fsFn, pidAlive: false });

  assert.ok(
    sent.some((s) => s.includes("[watchdog]") && s.includes("stale-wake") && /exited/i.test(s)),
    `expected the exit ping to fire when the only wake file predates spawn_time, got: ${JSON.stringify(sent)}`,
  );
});

test("overlap: exit ping FIRES when only a NON-matching slug's wake file exists", async () => {
  const spawnTime = Date.now() - 30 * 60 * 1000;
  const fx = makeOverlapFixture({
    slug: "mine",
    spawnTime,
    wakeFile: { name: "someone-else.json", mtimeMs: spawnTime + 5 * 60 * 1000 },
  });

  const sent = await runOverlapBridge({ watchdogDir: fx.watchdogDir, wakeDir: fx.wakeDir, fsFn: fx.fsFn, pidAlive: false });

  assert.ok(
    sent.some((s) => s.includes("[watchdog]") && s.includes("mine") && /exited/i.test(s)),
    `expected another slug's wake file not to suppress this loop's exit ping, got: ${JSON.stringify(sent)}`,
  );
});

test("overlap: exit ping FIRES when no wakeDir option is passed at all (default seam absent in tests)", async () => {
  const spawnTime = Date.now() - 30 * 60 * 1000;
  const fx = makeOverlapFixture({ slug: "no-wakedir", spawnTime });

  const sent = await runOverlapBridge({ watchdogDir: fx.watchdogDir, fsFn: fx.fsFn, pidAlive: false });

  assert.ok(
    sent.some((s) => s.includes("[watchdog]") && s.includes("no-wakedir") && /exited/i.test(s)),
    `an unreadable/absent wake dir must never suppress the ping, got: ${JSON.stringify(sent)}`,
  );
});

test("overlap: STALL ping fires even when a slug-matching wake file newer than spawn_time exists", async () => {
  const now = Date.now();
  const spawnTime = now - 70 * 60 * 1000;
  // pid ALIVE + progress.json silent for 61 min → the stall path.
  const fx = makeOverlapFixture({
    slug: "stall-with-wake",
    spawnTime,
    progressMtimeMs: now - 61 * 60 * 1000,
    wakeFile: { name: "stall-with-wake.json", mtimeMs: now - 5 * 60 * 1000 },
  });

  const sent = await runOverlapBridge({ watchdogDir: fx.watchdogDir, wakeDir: fx.wakeDir, fsFn: fx.fsFn, pidAlive: true });

  assert.ok(
    sent.some((s) => /gone quiet/i.test(s) && s.includes("stall-with-wake")),
    `stall pings are never suppressed by a wake file, got: ${JSON.stringify(sent)}`,
  );
});

// ---------------------------------------------------------------------------
// Producer: the ad-hoc task template's wake-file step
//
// Frontmatter never reaches the spawned process — only the body does (the
// same reason the report: path has to be restated in the constraints block).
// So the wake instruction must live in the BODY text of the template.
// ---------------------------------------------------------------------------

test("producer: the ad-hoc task template instructs the spawned job to write a wake file, in the BODY", () => {
  const systemMd = readFileSync(new URL("../prompts/system.md", import.meta.url), "utf8");

  const adhocStart = systemMd.indexOf("## Ad-hoc backgrounding");
  assert.ok(adhocStart >= 0, "expected an Ad-hoc backgrounding section in prompts/system.md");
  const adhocEnd = systemMd.indexOf("\n## ", adhocStart + 1);
  const section = systemMd.slice(adhocStart, adhocEnd === -1 ? undefined : adhocEnd);

  assert.match(section, /\.rachel\/wake/, "the wake directory path must be spelled out literally in the template");
  assert.match(section, /narrate/, "the default wake mode is narrate");

  // The constraints block is part 3 of the BODY — the block the template says
  // goes verbatim into every synthesised file. The wake step must be inside
  // it, not in the frontmatter list under "Synthesising the task file".
  const constraintsStart = section.indexOf("**The fixed constraints block**");
  assert.ok(constraintsStart >= 0, "expected the fixed constraints block in the template");
  const blockEnd = section.indexOf("\n\n", constraintsStart);
  const constraintsBlock = section.slice(constraintsStart, blockEnd === -1 ? undefined : blockEnd);
  assert.match(
    constraintsBlock,
    /\.rachel\/wake/,
    "the wake-file step must live in the body's constraints block — frontmatter never reaches the spawned process",
  );
});

// ---------------------------------------------------------------------------
// Wake channel consumer (spec Part B). These use REAL temp dirs rather than
// the stub fs above: the whole point of the design is the .done/.bad rename
// semantics, which are real filesystem behaviour.
// ---------------------------------------------------------------------------

import { mkdirSync as realMkdirSync, writeFileSync as realWriteFileSync, readdirSync as realReaddirSync } from "node:fs";

function makeWakeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rachel-wake-test-"));
  const wakeDir = join(dir, "wake");
  realMkdirSync(wakeDir, { recursive: true });
  return wakeDir;
}

function writeWakeFile(wakeDir: string, name: string, body: unknown): void {
  realWriteFileSync(join(wakeDir, name), typeof body === "string" ? body : JSON.stringify(body), "utf8");
}

// Collects the text of every /sendMessage the bridge made — the observable
// end state of the fyi/untagged push path.
function sentTexts(calls: { url: string; body: unknown }[]): string[] {
  return calls
    .filter((c) => c.url.includes("/sendMessage"))
    .map((c) => String((c.body as Record<string, unknown> | undefined)?.["text"] ?? ""));
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("wake consumer: a narrate wake starts a real Rachel turn carrying its source and message", async () => {
  const wakeDir = makeWakeDir();
  writeWakeFile(wakeDir, "adhoc-tunnel.json", {
    id: "adhoc-tunnel", source: "adhoc:tunnel", mode: "narrate",
    severity: "info", message: "Tunnel task finished: 3 files changed.",
    created_at: new Date().toISOString(),
  });

  const { transport, calls } = makeStubTransport([{ ok: true, result: [] }]);
  const turnInputs: string[] = [];
  const runTurnStub: BridgeRunTurn = async (input, emit) => {
    turnInputs.push(input);
    emit(`handled: ${input}`, "text");
  };

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    typingIntervalMs: 100000,
    wakeDir,
  });

  await bridge.drainOnce();
  await sleepMs(300);
  await bridge.stop();

  assert.equal(turnInputs.length, 1, `expected exactly one turn, got: ${JSON.stringify(turnInputs)}`);
  assert.equal(turnInputs[0], "[wake: adhoc:tunnel] Tunnel task finished: 3 files changed.");
  // The turn's reply reached Telegram, proving it ran end to end.
  assert.ok(sentTexts(calls).some((t) => t.includes("handled:")), `expected the turn's reply to be sent, got: ${JSON.stringify(sentTexts(calls))}`);
  assert.deepEqual(realReaddirSync(wakeDir), ["adhoc-tunnel.done"]);
});

test("wake consumer: an fyi wake reaches Telegram without starting a turn", async () => {
  const wakeDir = makeWakeDir();
  writeWakeFile(wakeDir, "sweep-restart.json", {
    id: "sweep-restart", source: "sweep:stale-process", mode: "fyi",
    severity: "info", message: "restarted bridge onto abc1234",
    created_at: new Date().toISOString(),
  });

  const { transport, calls } = makeStubTransport([{ ok: true, result: [] }]);
  const turnInputs: string[] = [];
  const runTurnStub: BridgeRunTurn = async (input) => { turnInputs.push(input); };

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    typingIntervalMs: 100000,
    wakeDir,
  });

  await bridge.drainOnce();
  await sleepMs(300);
  await bridge.stop();

  assert.deepEqual(turnInputs, [], "an fyi wake must never start a Rachel turn");
  assert.ok(
    sentTexts(calls).some((t) => t.includes("restarted bridge onto abc1234")),
    `expected the fyi message to reach Telegram, got: ${JSON.stringify(sentTexts(calls))}`,
  );
  assert.deepEqual(realReaddirSync(wakeDir), ["sweep-restart.done"]);
});

test("wake consumer: a wake with NO mode is delivered fyi with an [untagged wake:] prefix and never starts a turn", async () => {
  const wakeDir = makeWakeDir();
  writeWakeFile(wakeDir, "mystery.json", {
    id: "mystery", source: "unknown:thing",
    severity: "info", message: "something happened",
    created_at: new Date().toISOString(),
  });

  const { transport, calls } = makeStubTransport([{ ok: true, result: [] }]);
  const turnInputs: string[] = [];
  const runTurnStub: BridgeRunTurn = async (input) => { turnInputs.push(input); };

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    typingIntervalMs: 100000,
    wakeDir,
  });

  await bridge.drainOnce();
  await sleepMs(300);
  await bridge.stop();

  assert.deepEqual(turnInputs, [], "an untagged wake must NEVER start a billed turn");
  assert.ok(
    sentTexts(calls).some((t) => t.includes("[untagged wake: unknown:thing] something happened")),
    `expected the prefixed untagged message, got: ${JSON.stringify(sentTexts(calls))}`,
  );
});

test("wake consumer: an INVALID mode value is treated as untagged — prefixed fyi, never a turn", async () => {
  const wakeDir = makeWakeDir();
  writeWakeFile(wakeDir, "explodey.json", {
    id: "explodey", source: "rogue:producer", mode: "explode",
    severity: "info", message: "please run a turn for me",
    created_at: new Date().toISOString(),
  });

  const { transport, calls } = makeStubTransport([{ ok: true, result: [] }]);
  const turnInputs: string[] = [];
  const runTurnStub: BridgeRunTurn = async (input) => { turnInputs.push(input); };

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    typingIntervalMs: 100000,
    wakeDir,
  });

  await bridge.drainOnce();
  await sleepMs(300);
  await bridge.stop();

  assert.deepEqual(turnInputs, [], "an unknown mode must never be able to trigger SDK spend");
  assert.ok(
    sentTexts(calls).some((t) => t.includes("[untagged wake: rogue:producer] please run a turn for me")),
    `expected an invalid mode to route as untagged, got: ${JSON.stringify(sentTexts(calls))}`,
  );
});

test("wake consumer: malformed JSON is renamed .bad and never crashes the poll loop", async () => {
  const wakeDir = makeWakeDir();
  writeWakeFile(wakeDir, "broken.json", "{ this is not json");

  const { transport, calls } = makeStubTransport([{ ok: true, result: [] }]);
  const turnInputs: string[] = [];
  const runTurnStub: BridgeRunTurn = async (input) => { turnInputs.push(input); };

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    typingIntervalMs: 100000,
    wakeDir,
  });

  // Must not throw — a malformed producer file cannot be allowed to kill polling.
  await bridge.drainOnce();
  await sleepMs(300);
  await bridge.stop();

  assert.deepEqual(realReaddirSync(wakeDir), ["broken.json.bad"]);
  assert.deepEqual(turnInputs, []);
  assert.deepEqual(sentTexts(calls), [], "a malformed wake produces no delivery");
});

test("wake consumer: a field that cannot coerce to a string is quarantined .bad, not replayed forever", async () => {
  // Valid JSON, but wake.message's shape makes String() throw (no toString/
  // valueOf primitive coercion path) — this used to escape checkWakeFiles
  // uncaught, since the String() calls sat between the JSON.parse catch and
  // the claiming rename, so the file was never renamed off .json and the
  // outer poll-loop catch retried the same poison file forever.
  const wakeDir = makeWakeDir();
  writeWakeFile(wakeDir, "poison.json", '{"id":"p","source":"s","mode":"fyi","severity":"normal","message":{"toString":1,"valueOf":2},"created_at":"now"}');

  const { transport, calls } = makeStubTransport([{ ok: true, result: [] }]);
  const turnInputs: string[] = [];
  const runTurnStub: BridgeRunTurn = async (input) => { turnInputs.push(input); };

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    typingIntervalMs: 100000,
    wakeDir,
  });

  // Must not throw — a poison field must not crash the poll loop.
  await bridge.drainOnce();
  await sleepMs(300);
  await bridge.stop();

  assert.deepEqual(realReaddirSync(wakeDir), ["poison.json.bad"], "the poison file must be quarantined, not left as .json to replay");
  assert.deepEqual(turnInputs, []);
  assert.deepEqual(sentTexts(calls), [], "a quarantined wake produces no delivery");
});

test("wake consumer: a top-level null wake file is quarantined .bad, not replayed forever", async () => {
  // Valid JSON (the literal `null`), but every field access on it throws —
  // same failure shape as the poison-object case above, different trigger.
  const wakeDir = makeWakeDir();
  writeWakeFile(wakeDir, "nullwake.json", "null");

  const { transport, calls } = makeStubTransport([{ ok: true, result: [] }]);
  const turnInputs: string[] = [];
  const runTurnStub: BridgeRunTurn = async (input) => { turnInputs.push(input); };

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    typingIntervalMs: 100000,
    wakeDir,
  });

  await bridge.drainOnce();
  await sleepMs(300);
  await bridge.stop();

  assert.deepEqual(realReaddirSync(wakeDir), ["nullwake.json.bad"], "a null wake file must be quarantined, not left as .json to replay");
  assert.deepEqual(turnInputs, []);
  assert.deepEqual(sentTexts(calls), [], "a quarantined wake produces no delivery");
});

test("wake consumer: the wake file is renamed .done BEFORE the turn is dispatched (at-most-once)", async () => {
  const wakeDir = makeWakeDir();
  writeWakeFile(wakeDir, "ordered.json", {
    id: "ordered", source: "adhoc:ordered", mode: "narrate",
    severity: "normal", message: "ordering probe",
    created_at: new Date().toISOString(),
  });

  const { transport } = makeStubTransport([{ ok: true, result: [] }]);
  // Snapshot the on-disk state from INSIDE the turn: if the rename happened
  // before dispatch, the .json is already gone by the time runTurn is entered.
  let dirDuringTurn: string[] = [];
  const runTurnStub: BridgeRunTurn = async () => {
    dirDuringTurn = realReaddirSync(wakeDir);
  };

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    typingIntervalMs: 100000,
    wakeDir,
  });

  await bridge.drainOnce();
  await sleepMs(300);
  await bridge.stop();

  assert.ok(!dirDuringTurn.includes("ordered.json"), `the pending .json must already be renamed when the turn starts, saw: ${JSON.stringify(dirDuringTurn)}`);
  assert.deepEqual(dirDuringTurn, ["ordered.done"]);
});

test("wake consumer: at most 5 wake files are processed per poll iteration", async () => {
  const wakeDir = makeWakeDir();
  for (let i = 0; i < 8; i++) {
    writeWakeFile(wakeDir, `w${i}.json`, {
      id: `w${i}`, source: "sweep:flood", mode: "fyi",
      severity: "normal", message: `flood ${i}`,
      created_at: new Date().toISOString(),
    });
  }

  const { transport } = makeStubTransport([{ ok: true, result: [] }]);
  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {},
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    typingIntervalMs: 100000,
    wakeDir,
  });

  await bridge.drainOnce();
  await sleepMs(300);
  await bridge.stop();

  const entries = realReaddirSync(wakeDir);
  assert.equal(entries.filter((f) => f.endsWith(".done")).length, 5, `expected exactly 5 consumed per iteration, got: ${JSON.stringify(entries)}`);
  assert.equal(entries.filter((f) => f.endsWith(".json")).length, 3, `expected 3 left pending, got: ${JSON.stringify(entries)}`);
});

test("wake consumer: an absent wake directory is a silent no-op", async () => {
  const parent = mkdtempSync(join(tmpdir(), "rachel-wake-absent-"));
  const wakeDir = join(parent, "never-created");

  const { transport, calls } = makeStubTransport([{ ok: true, result: [] }]);
  const turnInputs: string[] = [];
  const runTurnStub: BridgeRunTurn = async (input) => { turnInputs.push(input); };

  const bridge = createBridge({
    ...basePushOpts(),
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    typingIntervalMs: 100000,
    wakeDir,
  });

  await bridge.drainOnce();
  await sleepMs(300);
  await bridge.stop();

  assert.deepEqual(turnInputs, []);
  assert.deepEqual(sentTexts(calls), []);
});
