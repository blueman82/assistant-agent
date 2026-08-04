// Keep rachel.ts's module-scope surfaces away from the operator's real files.
process.env["RACHEL_TELEGRAM_TOKEN"] = "000000000:FAKE-TEST-TOKEN";
process.env["RACHEL_TELEGRAM_CHAT_ID"] = "1";
process.env["RACHEL_GATE_TIMEOUT_MS"] = "200";

import { mkdtempSync as mkdtempSyncEarly } from "node:fs";
import { tmpdir as tmpdirEarly } from "node:os";
import { join as joinEarly } from "node:path";

const testQueueDir = mkdtempSyncEarly(joinEarly(tmpdirEarly(), "rachel-test-queue-"));
process.env["RACHEL_QUEUE_DIR"] = testQueueDir;
process.env["RACHEL_AUDIT_LOG_PATH"] = joinEarly(testQueueDir, "audit.jsonl");
process.env["RACHEL_MEMORY_PATH"] = joinEarly(testQueueDir, "memory", "MEMORY.md");

globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
  throw new Error(`Unexpected real fetch() call in sessionPersist.test.ts: ${String(args[0])}`);
}) as typeof fetch;

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  clearSession,
  readSession,
  writeSession,
  type PersistedSession,
} from "./sessionPersist.ts";
import type { SessionRecoveryDeps } from "../rachel.ts";

function tempSessionPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rachel-test-session-")), "bridge-session.json");
}

function initMessage(sessionId: string): SDKMessage {
  return { type: "system", subtype: "init", session_id: sessionId } as unknown as SDKMessage;
}

function assistantMessage(sessionId: string, uuid: string, aborted = false): SDKMessage {
  return {
    type: "assistant",
    session_id: sessionId,
    uuid,
    parent_tool_use_id: null,
    ...(aborted ? { aborted: true } : {}),
    message: { role: "assistant", content: [{ type: "text", text: "reply" }] },
  } as unknown as SDKMessage;
}

function resultMessage(sessionId: string, subtype: "success" | "error_during_execution"): SDKMessage {
  return {
    type: "result",
    subtype,
    session_id: sessionId,
    uuid: `result-${subtype}`,
    num_turns: 1,
    total_cost_usd: 0,
  } as unknown as SDKMessage;
}

function queryMessages(...messages: SDKMessage[]) {
  return ((_params: unknown) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield* messages;
    }
    return generate();
  }) as Parameters<(typeof import("../rachel.ts"))["runTurn"]>[3];
}

function forkDeps(options: {
  forkedSessionId?: string;
  remappedCheckpointId?: string;
  onFork?: (sessionId: string, checkpointId: string) => Promise<void> | void;
  fail?: Error;
} = {}): SessionRecoveryDeps & { calls: Array<{ sessionId: string; checkpointId: string }> } {
  const calls: Array<{ sessionId: string; checkpointId: string }> = [];
  return {
    calls,
    async forkSession(sessionId, forkOptions) {
      calls.push({ sessionId, checkpointId: forkOptions.upToMessageId });
      await options.onFork?.(sessionId, forkOptions.upToMessageId);
      if (options.fail) throw options.fail;
      return { sessionId: options.forkedSessionId ?? "forked-session" };
    },
    async getSessionMessages(sessionId) {
      return [{
        type: "assistant",
        uuid: options.remappedCheckpointId ?? "remapped-checkpoint",
        session_id: sessionId,
        message: {},
        parent_tool_use_id: null,
        parent_agent_id: null,
      } satisfies SessionMessage];
    },
  };
}

async function hydrateActive(path: string, state: PersistedSession): Promise<void> {
  writeSession(path, state);
  process.env["RACHEL_SESSION_FILE"] = path;
  const { hydratePersistedSession } = await import("../rachel.ts");
  assert.equal(await hydratePersistedSession(), "active");
}

beforeEach(async () => {
  delete process.env["RACHEL_SESSION_FILE"];
  const { resetSession } = await import("../rachel.ts");
  resetSession();
});

test("readSession treats only ENOENT as an absent session", () => {
  const missing = tempSessionPath();
  assert.equal(readSession(missing), undefined);

  const directory = mkdtempSync(join(tmpdir(), "rachel-test-session-dir-"));
  assert.throws(() => readSession(directory), (error: unknown) =>
    error instanceof Error && error.message.includes(directory));
});

test("schema v1 is read backward-compatibly as active without a checkpoint", () => {
  const path = tempSessionPath();
  writeFileSync(path, JSON.stringify({ schema_version: 1, session_id: "legacy-session" }));
  assert.deepEqual(readSession(path), { sessionId: "legacy-session", state: "active" });
});

test("schema v2 active and tainted records round trip", () => {
  const path = tempSessionPath();
  const active: PersistedSession = {
    sessionId: "active-session",
    lastCompletedAssistantMessageId: "checkpoint-a",
    state: "active",
  };
  writeSession(path, active);
  assert.deepEqual(readSession(path), active);

  const tainted: PersistedSession = {
    sessionId: "tainted-session",
    lastCompletedAssistantMessageId: "checkpoint-b",
    state: "tainted",
    abortReason: "shutdown",
  };
  writeSession(path, tainted);
  assert.deepEqual(readSession(path), tainted);
});

test("writeSession atomically stores session ownership, checkpoint, and state", () => {
  const path = tempSessionPath();
  writeSession(path, {
    sessionId: "session-shape",
    lastCompletedAssistantMessageId: "checkpoint-shape",
    state: "tainted",
    abortReason: "deadline",
  });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    schema_version: 2,
    session_id: "session-shape",
    last_completed_assistant_message_id: "checkpoint-shape",
    state: "tainted",
    abort_reason: "deadline",
  });
  assert.deepEqual(readdirSync(join(path, "..")), ["bridge-session.json"]);
});

test("writeSession creates parent directories and clearSession is idempotent", () => {
  const path = join(mkdtempSync(join(tmpdir(), "rachel-test-session-")), "nested", "bridge-session.json");
  writeSession(path, { sessionId: "nested-session", state: "active" });
  assert.ok(existsSync(path));
  clearSession(path);
  assert.equal(readSession(path), undefined);
  assert.doesNotThrow(() => clearSession(path));
});

test("corrupt and schema-invalid files fail loudly", () => {
  const invalidValues = [
    "not json",
    JSON.stringify([]),
    JSON.stringify({ schema_version: 99, session_id: "x" }),
    JSON.stringify({ schema_version: 1, session_id: "" }),
    JSON.stringify({
      schema_version: 2,
      session_id: "x",
      last_completed_assistant_message_id: "",
      state: "active",
      abort_reason: null,
    }),
    JSON.stringify({
      schema_version: 2,
      session_id: "x",
      last_completed_assistant_message_id: null,
      state: "active",
      abort_reason: "stop",
    }),
    JSON.stringify({
      schema_version: 2,
      session_id: "x",
      last_completed_assistant_message_id: null,
      state: "tainted",
      abort_reason: "other",
    }),
  ];
  for (const value of invalidValues) {
    const path = tempSessionPath();
    writeFileSync(path, value);
    assert.throws(() => readSession(path), (error: unknown) =>
      error instanceof Error && error.message.includes(path));
  }
});

test("a successful turn commits only the latest non-aborted assistant checkpoint and migrates v1", async () => {
  const path = tempSessionPath();
  writeFileSync(path, JSON.stringify({ schema_version: 1, session_id: "legacy-session" }));
  process.env["RACHEL_SESSION_FILE"] = path;
  const { hydratePersistedSession, runTurn } = await import("../rachel.ts");
  assert.equal(await hydratePersistedSession(), "active");

  const outcome = await runTurn("hello", () => {}, new AbortController().signal, queryMessages(
    initMessage("legacy-session"),
    assistantMessage("legacy-session", "assistant-one"),
    assistantMessage("legacy-session", "assistant-aborted", true),
    assistantMessage("legacy-session", "assistant-two"),
    resultMessage("legacy-session", "success"),
  ));
  assert.deepEqual(outcome, { status: "completed" });
  assert.deepEqual(readSession(path), {
    sessionId: "legacy-session",
    lastCompletedAssistantMessageId: "assistant-two",
    state: "active",
  });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).schema_version, 2);
});

test("error results and aborted assistant frames never advance the checkpoint", async () => {
  const path = tempSessionPath();
  await hydrateActive(path, {
    sessionId: "source-session",
    lastCompletedAssistantMessageId: "checkpoint-old",
    state: "active",
  });
  const { runTurn } = await import("../rachel.ts");
  await runTurn("error", () => {}, new AbortController().signal, queryMessages(
    initMessage("source-session"),
    assistantMessage("source-session", "candidate-on-error"),
    resultMessage("source-session", "error_during_execution"),
  ));
  assert.equal(readSession(path)?.lastCompletedAssistantMessageId, "checkpoint-old");

  await runTurn("aborted frame", () => {}, new AbortController().signal, queryMessages(
    initMessage("source-session"),
    assistantMessage("source-session", "aborted-only", true),
    resultMessage("source-session", "success"),
  ));
  assert.equal(readSession(path)?.lastCompletedAssistantMessageId, "checkpoint-old");
});

test("an abort taints before SDK cancellation, forks through the clean checkpoint, and persists the remapped checkpoint", async () => {
  const path = tempSessionPath();
  await hydrateActive(path, {
    sessionId: "source-session",
    lastCompletedAssistantMessageId: "clean-checkpoint",
    state: "active",
  });
  const { runTurn } = await import("../rachel.ts");
  const externalAbort = new AbortController();
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  let settle!: () => void;
  const canSettle = new Promise<void>((resolve) => { settle = resolve; });
  const queryFn: Parameters<typeof runTurn>[3] = ((params) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      started();
      await new Promise<void>((resolve) => params.options?.abortController?.signal.addEventListener("abort", () => resolve(), { once: true }));
      await canSettle;
      throw new Error("SDK abort");
    }
    return generate();
  }) as Parameters<typeof runTurn>[3];
  const deps = forkDeps({ forkedSessionId: "clean-fork", remappedCheckpointId: "remapped-clean" });

  const turn = runTurn("interrupt me", () => {}, externalAbort.signal, queryFn, deps);
  await didStart;
  externalAbort.abort("deadline");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(readSession(path), {
    sessionId: "source-session",
    lastCompletedAssistantMessageId: "clean-checkpoint",
    state: "tainted",
    abortReason: "deadline",
  });
  settle();

  assert.deepEqual(await turn, { status: "aborted", reason: "deadline", recovery: "forked" });
  assert.deepEqual(deps.calls, [{ sessionId: "source-session", checkpointId: "clean-checkpoint" }]);
  assert.deepEqual(readSession(path), {
    sessionId: "clean-fork",
    lastCompletedAssistantMessageId: "remapped-clean",
    state: "active",
  });
});

test("missing checkpoints and fork failures fall back to a fresh session", async () => {
  const { runTurn, getSessionId } = await import("../rachel.ts");
  for (const scenario of ["missing", "failure"] as const) {
    const path = tempSessionPath();
    await hydrateActive(path, {
      sessionId: `source-${scenario}`,
      ...(scenario === "failure" ? { lastCompletedAssistantMessageId: "checkpoint" } : {}),
      state: "active",
    });
    const controller = new AbortController();
    controller.abort("stop");
    const deps = scenario === "failure" ? forkDeps({ fail: new Error("fork unavailable") }) : forkDeps();
    const outcome = await runTurn("stop", () => {}, controller.signal, queryMessages(), deps);
    assert.deepEqual(outcome, { status: "aborted", reason: "stop", recovery: "fresh" });
    assert.equal(getSessionId(), undefined);
    assert.equal(readSession(path), undefined);
  }
});

test("startup recovers a tainted persisted session before it becomes active", async () => {
  const path = tempSessionPath();
  writeSession(path, {
    sessionId: "tainted-source",
    lastCompletedAssistantMessageId: "source-checkpoint",
    state: "tainted",
    abortReason: "shutdown",
  });
  process.env["RACHEL_SESSION_FILE"] = path;
  const deps = forkDeps({ forkedSessionId: "startup-fork", remappedCheckpointId: "startup-remap" });
  const { hydratePersistedSession, getSessionId } = await import("../rachel.ts");
  assert.equal(await hydratePersistedSession(deps), "forked");
  assert.equal(getSessionId(), "startup-fork");
  assert.deepEqual(readSession(path), {
    sessionId: "startup-fork",
    lastCompletedAssistantMessageId: "startup-remap",
    state: "active",
  });
});

test("reset during recovery is authoritative and leaves the superseded fork only in SDK history", async () => {
  const path = tempSessionPath();
  await hydrateActive(path, {
    sessionId: "source-session",
    lastCompletedAssistantMessageId: "clean-checkpoint",
    state: "active",
  });
  const { runTurn, resetSession, getSessionId } = await import("../rachel.ts");
  let forkStarted!: () => void;
  const didForkStart = new Promise<void>((resolve) => { forkStarted = resolve; });
  let releaseFork!: () => void;
  const forkGate = new Promise<void>((resolve) => { releaseFork = resolve; });
  const deps = forkDeps({
    async onFork() {
      forkStarted();
      await forkGate;
    },
  });
  const controller = new AbortController();
  controller.abort("deadline");
  const turn = runTurn("old turn", () => {}, controller.signal, queryMessages(), deps);
  await didForkStart;
  resetSession();
  releaseFork();

  assert.deepEqual(await turn, { status: "aborted", reason: "deadline", recovery: "superseded" });
  assert.equal(getSessionId(), undefined);
  assert.equal(readSession(path), undefined);
});

test("a late system/init from a reset-superseded turn cannot reclaim session ownership", async () => {
  const path = tempSessionPath();
  process.env["RACHEL_SESSION_FILE"] = path;
  const { runTurn, resetSession, getSessionId } = await import("../rachel.ts");
  let releaseOld!: () => void;
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
  const oldQuery: Parameters<typeof runTurn>[3] = ((_params) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      await oldGate;
      yield initMessage("stale-session");
      yield assistantMessage("stale-session", "stale-checkpoint");
      yield resultMessage("stale-session", "success");
    }
    return generate();
  }) as Parameters<typeof runTurn>[3];
  const oldTurn = runTurn("old", () => {}, new AbortController().signal, oldQuery);
  await Promise.resolve();
  resetSession();
  await runTurn("new", () => {}, new AbortController().signal, queryMessages(
    initMessage("replacement-session"),
    assistantMessage("replacement-session", "replacement-checkpoint"),
    resultMessage("replacement-session", "success"),
  ));
  releaseOld();
  await oldTurn;

  assert.equal(getSessionId(), "replacement-session");
  assert.deepEqual(readSession(path), {
    sessionId: "replacement-session",
    lastCompletedAssistantMessageId: "replacement-checkpoint",
    state: "active",
  });
});

test("RACHEL_SESSION_FILE is stripped only from the SDK child environment", async () => {
  const path = tempSessionPath();
  process.env["RACHEL_SESSION_FILE"] = path;
  const { runTurn } = await import("../rachel.ts");
  let childEnv: Record<string, string | undefined> | undefined;
  const withSeam: Parameters<typeof runTurn>[3] = ((params) => {
    childEnv = params.options?.env;
    return queryMessages()!(params);
  }) as Parameters<typeof runTurn>[3];
  await runTurn("hello", () => {}, new AbortController().signal, withSeam);
  assert.equal(childEnv?.["RACHEL_SESSION_FILE"], undefined);
  assert.equal(childEnv?.["PATH"], process.env["PATH"]);

  delete process.env["RACHEL_SESSION_FILE"];
  childEnv = { sentinel: "not-called" };
  const withoutSeam: Parameters<typeof runTurn>[3] = ((params) => {
    childEnv = params.options?.env;
    return queryMessages()!(params);
  }) as Parameters<typeof runTurn>[3];
  await runTurn("hello", () => {}, new AbortController().signal, withoutSeam);
  assert.equal(childEnv, undefined);
});
