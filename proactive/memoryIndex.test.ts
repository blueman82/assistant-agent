// Env-safety header — matches bridge/telegram-bridge.test.ts's header
// exactly and for the same reason: tests 5 and 6 below import the REAL
// runTurn from rachel.ts, and importing rachel.ts runs its module-scope
// side effects once (loadTelegramConfig() reading ~/.rachel/telegram.json,
// createQueueApprovalSurface() defaulting to
// ~/.claude/coderails-dashboard/approvals, createSendGateHook() writing
// ~/.rachel/send-gate-audit.jsonl). Without these redirects, a test run
// here could touch the operator's real queue/audit files or a live
// Telegram token. This block MUST stay ahead of every import in this file.
process.env["RACHEL_TELEGRAM_TOKEN"] = "000000000:FAKE-TEST-TOKEN";
process.env["RACHEL_TELEGRAM_CHAT_ID"] = "1";
// The SAFETY test below needs a real (but short) deny-timeout race rather
// than the 60s production default — same reasoning as
// bridge/telegram-bridge.test.ts's own gate-integrity test, and it must be
// set here, before rachel.ts's first import anywhere in this file, since
// rachel.ts's module-scope createSendGateHook(...) call reads it once.
process.env["RACHEL_GATE_TIMEOUT_MS"] = "200";

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const testQueueDir = mkdtempSync(join(tmpdir(), "rachel-test-queue-"));
process.env["RACHEL_QUEUE_DIR"] = testQueueDir;
process.env["RACHEL_AUDIT_LOG_PATH"] = join(testQueueDir, "audit.jsonl");

// Defense-in-depth, same reasoning as telegram-bridge.test.ts: every test
// here injects its own fake queryFn rather than relying on global fetch, so
// fetch should never fire. Throw loud if it ever does.
globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
  throw new Error(`Unexpected real fetch() call in memoryIndex.test.ts — all transports must be stubbed. Called with: ${String(args[0])}`);
}) as typeof fetch;

import { test } from "node:test";
import assert from "node:assert/strict";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { GATED_TOOL_NAMES } from "../gate/sendGate.ts";
import { composeSystemPrompt, resolveMemoryPath } from "./memoryIndex.ts";

test("absent MEMORY.md leaves the prompt unchanged and does not throw", () => {
  const missingDir = mkdtempSync(join(tmpdir(), "rachel-test-memory-"));
  const missingPath = join(missingDir, "does-not-exist", "MEMORY.md");
  const basePrompt = "You are Rachel.";
  const result = composeSystemPrompt(basePrompt, missingPath);
  assert.equal(result, basePrompt);
});

test("a present MEMORY.md has its content appear in the composed prompt", () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "rachel-test-memory-"));
  const memoryPath = join(memoryDir, "MEMORY.md");
  writeFileSync(memoryPath, "- [Some fact](some-fact.md) — a hook\n");
  const basePrompt = "You are Rachel.";
  const result = composeSystemPrompt(basePrompt, memoryPath);
  assert.ok(result.includes(basePrompt), "base prompt is preserved");
  assert.ok(result.includes("[Some fact](some-fact.md) — a hook"), "index content is present in the composed prompt");
});

test("a non-ENOENT read failure throws loud with the file path named", () => {
  // Point the "file" path at a directory, not a file — readFileSync throws
  // EISDIR, a non-ENOENT failure that must NOT be silently swallowed the
  // way an absent file is (proactive/push.ts's readJson draws the same
  // ENOENT-only line: a corrupt/unreadable store must fail loud, never be
  // read as empty).
  const dirAsFile = mkdtempSync(join(tmpdir(), "rachel-test-memory-"));
  assert.throws(
    () => composeSystemPrompt("You are Rachel.", dirAsFile),
    (err: unknown) => err instanceof Error && err.message.includes(dirAsFile),
  );
});

test("RACHEL_MEMORY_PATH overrides the default ~/.rachel/memory/MEMORY.md path", () => {
  const original = process.env["RACHEL_MEMORY_PATH"];
  try {
    process.env["RACHEL_MEMORY_PATH"] = "/tmp/some/override/MEMORY.md";
    assert.equal(resolveMemoryPath(), "/tmp/some/override/MEMORY.md");
  } finally {
    if (original === undefined) {
      delete process.env["RACHEL_MEMORY_PATH"];
    } else {
      process.env["RACHEL_MEMORY_PATH"] = original;
    }
  }
});

test("unset RACHEL_MEMORY_PATH resolves to ~/.rachel/memory/MEMORY.md", () => {
  const original = process.env["RACHEL_MEMORY_PATH"];
  try {
    delete process.env["RACHEL_MEMORY_PATH"];
    assert.equal(resolveMemoryPath(), join(homedir(), ".rachel", "memory", "MEMORY.md"));
  } finally {
    if (original === undefined) {
      delete process.env["RACHEL_MEMORY_PATH"];
    } else {
      process.env["RACHEL_MEMORY_PATH"] = original;
    }
  }
});

// Captures the `options` object a fake queryFn receives from runTurn, so a
// test can assert on it without hitting the network. Yields a minimal
// init+result message pair so runTurn's stream-consuming loop completes
// normally.
function captureOptionsQueryFn(
  onOptions: (options: Record<string, unknown>) => void,
): Parameters<typeof import("../rachel.ts").runTurn>[3] {
  return ((params: { options: Record<string, unknown> }) => {
    onOptions(params.options);
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield { type: "system", subtype: "init", session_id: "fake-session" } as unknown as SDKMessage;
    }
    return generate();
  }) as Parameters<typeof import("../rachel.ts").runTurn>[3];
}

test("WIRING: runTurn passes a system prompt containing the memory index to queryFn's options", async () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "rachel-test-memory-"));
  const memoryPath = join(memoryDir, "MEMORY.md");
  const sentinel = "- [Sentinel fact](sentinel.md) — unique marker for this test";
  writeFileSync(memoryPath, `${sentinel}\n`);

  const original = process.env["RACHEL_MEMORY_PATH"];
  process.env["RACHEL_MEMORY_PATH"] = memoryPath;
  try {
    const { runTurn } = await import("../rachel.ts");

    let capturedOptions: Record<string, unknown> | undefined;
    const fakeQueryFn = captureOptionsQueryFn((options) => {
      capturedOptions = options;
    });

    await runTurn("hello", () => {}, new AbortController().signal, fakeQueryFn);

    assert.ok(capturedOptions, "queryFn was invoked with options");
    const agents = capturedOptions!["agents"] as { rachel?: { prompt?: string } } | undefined;
    assert.ok(agents?.rachel?.prompt, "options.agents.rachel.prompt is set");
    assert.ok(
      agents!.rachel!.prompt!.includes(sentinel),
      "the composed prompt passed to the SDK includes the memory index content",
    );
  } finally {
    if (original === undefined) {
      delete process.env["RACHEL_MEMORY_PATH"];
    } else {
      process.env["RACHEL_MEMORY_PATH"] = original;
    }
  }
});

// MANDATORY safety-critical assertion: this PR touches the same `options`
// object where the send-approval gate is wired as a PreToolUse hook
// (rachel.ts's hooks.PreToolUse). A silent detach of that wiring would not
// crash anything — the first symptom would be an unapproved Slack or
// Calendar send going out. bridge/telegram-bridge.test.ts protects this
// only incidentally (its own comment says so); this test names the
// invariant explicitly for this PR's change.
test("SAFETY: the send-approval gate hook is still wired into runTurn's options after this change, and denies a gated tool call", async () => {
  const { runTurn } = await import("../rachel.ts");

  let hookDecision: string | undefined;

  type FakeHookCallback = (
    input: unknown,
    toolUseID: string | undefined,
    options: { signal: AbortSignal },
  ) => Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>;

  const fakeQueryFn = ((params: { options: Record<string, unknown> }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      const preToolUseHooks = (params.options["hooks"] as Record<string, { hooks: unknown[] }[]> | undefined)?.["PreToolUse"];
      assert.ok(
        preToolUseHooks && preToolUseHooks.length > 0,
        "options.hooks.PreToolUse must be present — the send gate must stay wired after this change",
      );
      const hook = preToolUseHooks![0]!.hooks[0] as FakeHookCallback;

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

      yield { type: "system", subtype: "init", session_id: "fake-session" } as unknown as SDKMessage;
    }
    return generate();
  }) as Parameters<typeof runTurn>[3];

  await runTurn("send a slack message", () => {}, new AbortController().signal, fakeQueryFn);

  assert.equal(hookDecision, "deny", "a gated tool call with no approval surface resolving must be denied, not allowed");
});
