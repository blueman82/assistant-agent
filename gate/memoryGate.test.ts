// Env-safety header — same idiom and reason as proactive/memoryIndex.test.ts:
// the WIRING test below imports the REAL rachel.ts, and importing it runs
// its module-scope side effects once (loadTelegramConfig(),
// createQueueApprovalSurface(), createSendGateHook() writing the real audit
// log). This block MUST stay ahead of every import in this file.
process.env["RACHEL_TELEGRAM_TOKEN"] = "000000000:FAKE-TEST-TOKEN";
process.env["RACHEL_TELEGRAM_CHAT_ID"] = "1";
process.env["RACHEL_GATE_TIMEOUT_MS"] = "200";

import { mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join as joinPath } from "node:path";

const testQueueDir = mkdtempSync(joinPath(tmpdir(), "rachel-test-queue-"));
process.env["RACHEL_QUEUE_DIR"] = testQueueDir;
process.env["RACHEL_AUDIT_LOG_PATH"] = joinPath(testQueueDir, "audit.jsonl");
process.env["RACHEL_MEMORY_PATH"] = joinPath(testQueueDir, "memory", "MEMORY.md");

globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
  throw new Error(`Unexpected real fetch() call in memoryGate.test.ts — all transports must be stubbed. Called with: ${String(args[0])}`);
}) as typeof fetch;

import { test } from "node:test";
import assert from "node:assert/strict";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createMemoryGateHook } from "./memoryGate.ts";
import type { PreToolUseHookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

function permissionDecisionOf(output: HookJSONOutput): string | undefined {
  return "hookSpecificOutput" in output
    ? (output.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision
    : undefined;
}

function reasonOf(output: HookJSONOutput): string | undefined {
  return "hookSpecificOutput" in output
    ? (output.hookSpecificOutput as { permissionDecisionReason?: string } | undefined)?.permissionDecisionReason
    : undefined;
}

function makeWriteInput(filePath: string, content: string): PreToolUseHookInput {
  return {
    hook_event_name: "PreToolUse",
    session_id: "test-session",
    transcript_path: "/dev/null",
    cwd: "/tmp",
    tool_name: "Write",
    tool_input: { file_path: filePath, content },
  } as PreToolUseHookInput;
}

function withUntrustedFlag(fn: () => Promise<void>): Promise<void> {
  const original = process.env["RACHEL_UNTRUSTED_CONTENT"];
  // Literal value from tasks/inbox-brief-launchd.plist (SO-17: reproduce the
  // real shape, not a simplified stand-in).
  process.env["RACHEL_UNTRUSTED_CONTENT"] = "1";
  return fn().finally(() => {
    if (original === undefined) {
      delete process.env["RACHEL_UNTRUSTED_CONTENT"];
    } else {
      process.env["RACHEL_UNTRUSTED_CONTENT"] = original;
    }
  });
}

test("RACHEL_UNTRUSTED_CONTENT set + Write into memory dir -> deny", async () => {
  await withUntrustedFlag(async () => {
    const hook = createMemoryGateHook();
    const input = makeWriteInput("/Users/harrison/.rachel/memory/some-fact.md", "---\nname: some-fact\n---\n");
    const result = await hook(input, undefined, { signal: new AbortController().signal });
    assert.equal(permissionDecisionOf(result), "deny");
    assert.match(reasonOf(result) ?? "", /untrusted/i);
  });
});

test("RACHEL_UNTRUSTED_CONTENT unset + Write into memory dir -> pass-through (not this check's concern)", async () => {
  const original = process.env["RACHEL_UNTRUSTED_CONTENT"];
  delete process.env["RACHEL_UNTRUSTED_CONTENT"];
  try {
    const hook = createMemoryGateHook();
    const input = makeWriteInput("/Users/harrison/.rachel/memory/some-fact.md", "---\nname: some-fact\ndescription: x\ntype: preference\n---\nbody");
    const result = await hook(input, undefined, { signal: new AbortController().signal });
    assert.deepEqual(result, {});
  } finally {
    if (original !== undefined) {
      process.env["RACHEL_UNTRUSTED_CONTENT"] = original;
    }
  }
});

test("RACHEL_UNTRUSTED_CONTENT set + Write OUTSIDE memory dir -> pass-through", async () => {
  await withUntrustedFlag(async () => {
    const hook = createMemoryGateHook();
    const input = makeWriteInput("/Users/harrison/Github/assistant-agent/tasks/2026-07-23-something.md", "content");
    const result = await hook(input, undefined, { signal: new AbortController().signal });
    assert.deepEqual(result, {});
  });
});

test("RACHEL_UNTRUSTED_CONTENT set + Edit into memory dir -> deny", async () => {
  await withUntrustedFlag(async () => {
    const hook = createMemoryGateHook();
    const input = {
      hook_event_name: "PreToolUse",
      session_id: "test-session",
      transcript_path: "/dev/null",
      cwd: "/tmp",
      tool_name: "Edit",
      tool_input: {
        file_path: "/Users/harrison/.rachel/memory/some-fact.md",
        old_string: "a",
        new_string: "attacker-controlled text",
      },
    } as PreToolUseHookInput;
    const result = await hook(input, undefined, { signal: new AbortController().signal });
    assert.equal(permissionDecisionOf(result), "deny");
    assert.match(reasonOf(result) ?? "", /untrusted/i);
  });
});

test("RACHEL_UNTRUSTED_CONTENT set + Bash command string-matching the memory path -> deny", async () => {
  await withUntrustedFlag(async () => {
    const hook = createMemoryGateHook();
    const input = {
      hook_event_name: "PreToolUse",
      session_id: "test-session",
      transcript_path: "/dev/null",
      cwd: "/tmp",
      tool_name: "Bash",
      tool_input: { command: "echo 'attacker text' >> ~/.rachel/memory/some-fact.md" },
    } as PreToolUseHookInput;
    const result = await hook(input, undefined, { signal: new AbortController().signal });
    assert.equal(permissionDecisionOf(result), "deny");
    assert.match(reasonOf(result) ?? "", /untrusted/i);
  });
});

test("RACHEL_UNTRUSTED_CONTENT set + Bash command NOT touching memory path -> pass-through", async () => {
  await withUntrustedFlag(async () => {
    const hook = createMemoryGateHook();
    const input = {
      hook_event_name: "PreToolUse",
      session_id: "test-session",
      transcript_path: "/dev/null",
      cwd: "/tmp",
      tool_name: "Bash",
      tool_input: { command: "ls -la /tmp" },
    } as PreToolUseHookInput;
    const result = await hook(input, undefined, { signal: new AbortController().signal });
    assert.deepEqual(result, {});
  });
});

test("non-PreToolUse hook event -> pass-through with empty object even when untrusted", async () => {
  await withUntrustedFlag(async () => {
    const hook = createMemoryGateHook();
    const input = {
      hook_event_name: "PostToolUse",
      session_id: "test-session",
      transcript_path: "/dev/null",
      cwd: "/tmp",
      tool_name: "Write",
      tool_input: { file_path: "/Users/harrison/.rachel/memory/some-fact.md", content: "x" },
    } as unknown as PreToolUseHookInput;
    const result = await hook(input, undefined, { signal: new AbortController().signal });
    assert.deepEqual(result, {});
  });
});

test("hook throws exception -> deny with 'Internal hook error' reason (fail-closed)", async () => {
  const hook = createMemoryGateHook();
  const input = new Proxy({} as PreToolUseHookInput, {
    get: () => {
      throw new Error("input threw");
    },
  });
  const result = await hook(input, undefined, { signal: new AbortController().signal });
  assert.equal(permissionDecisionOf(result), "deny");
  assert.match(reasonOf(result) ?? "", /Internal hook error/);
});

// --- (b) Frontmatter schema validation on memory writes (all contexts) ---

test("Write of a memory fact file with valid frontmatter -> pass-through", async () => {
  const hook = createMemoryGateHook();
  const validContent = "---\nname: some-fact\ndescription: a one-line fact\ntype: preference\n---\n\nBody text.\n";
  const input = makeWriteInput("/Users/harrison/.rachel/memory/some-fact.md", validContent);
  const result = await hook(input, undefined, { signal: new AbortController().signal });
  assert.deepEqual(result, {});
});

test("Write of a memory fact file MISSING only the optional date field -> pass-through (warning-level finding must not block)", async () => {
  const hook = createMemoryGateHook();
  // name/description/type all present and valid; date is absent, which
  // validateFrontmatter reports as a warning-level missing-date finding.
  // Gary's live store has pre-existing files without a date field, so this
  // must never block — only error-level findings may deny.
  const contentMissingDateOnly = "---\nname: some-fact\ndescription: a one-line fact\ntype: preference\n---\n\nBody text.\n";
  const input = makeWriteInput("/Users/harrison/.rachel/memory/some-fact.md", contentMissingDateOnly);
  const result = await hook(input, undefined, { signal: new AbortController().signal });
  assert.deepEqual(result, {}, "a warning-level-only finding set must pass through, not deny");
});

test("Write of a memory fact file MISSING a required frontmatter field -> deny naming the missing field", async () => {
  const hook = createMemoryGateHook();
  // Missing "type" entirely.
  const badContent = "---\nname: some-fact\ndescription: a one-line fact\n---\n\nBody text.\n";
  const input = makeWriteInput("/Users/harrison/.rachel/memory/some-fact.md", badContent);
  const result = await hook(input, undefined, { signal: new AbortController().signal });
  assert.equal(permissionDecisionOf(result), "deny");
  assert.match(reasonOf(result) ?? "", /type/);
});

test("Write of a memory fact file with an INVALID type value -> deny naming the bad value", async () => {
  const hook = createMemoryGateHook();
  const badContent = "---\nname: some-fact\ndescription: a one-line fact\ntype: user\n---\n\nBody text.\n";
  const input = makeWriteInput("/Users/harrison/.rachel/memory/some-fact.md", badContent);
  const result = await hook(input, undefined, { signal: new AbortController().signal });
  assert.equal(permissionDecisionOf(result), "deny");
  assert.match(reasonOf(result) ?? "", /type/);
});

test("Write to MEMORY.md (the index, not a fact file) -> schema check does not apply", async () => {
  const hook = createMemoryGateHook();
  const indexContent = "- [Some fact](some-fact.md) — a hook\n";
  const input = makeWriteInput("/Users/harrison/.rachel/memory/MEMORY.md", indexContent);
  const result = await hook(input, undefined, { signal: new AbortController().signal });
  assert.deepEqual(result, {});
});

test("Write of a non-.md file inside the memory dir -> schema check does not apply", async () => {
  const hook = createMemoryGateHook();
  const input = makeWriteInput("/Users/harrison/.rachel/memory/notes.txt", "arbitrary content");
  const result = await hook(input, undefined, { signal: new AbortController().signal });
  assert.deepEqual(result, {});
});

test("Write of a .md file OUTSIDE the memory dir with bad frontmatter -> schema check does not apply", async () => {
  const hook = createMemoryGateHook();
  const input = makeWriteInput("/Users/harrison/Github/assistant-agent/tasks/2026-07-23-something.md", "no frontmatter at all");
  const result = await hook(input, undefined, { signal: new AbortController().signal });
  assert.deepEqual(result, {});
});

// --- SO-8: drive the real FEATURE end to end, not just the callback in
// isolation. This proves memoryGateHook is actually wired into runTurn's
// options.hooks.PreToolUse array (3rd position) and that setting
// RACHEL_UNTRUSTED_CONTENT on a real turn actually denies a memory write —
// not just that the standalone callback returns the right shape.
test("WIRING+SAFETY: a real turn with RACHEL_UNTRUSTED_CONTENT set denies a memory-dir Write via the wired hook", async () => {
  const original = process.env["RACHEL_UNTRUSTED_CONTENT"];
  process.env["RACHEL_UNTRUSTED_CONTENT"] = "1";
  try {
    const { runTurn } = await import("../rachel.ts");

    type FakeHookCallback = (
      input: unknown,
      toolUseID: string | undefined,
      options: { signal: AbortSignal },
    ) => Promise<{ hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }>;

    let capturedOptions: { hooks?: Record<string, { hooks: FakeHookCallback[] }[]> } | undefined;

    const fakeQueryFn: Parameters<typeof runTurn>[3] = ((_params) => {
      capturedOptions = _params.options as typeof capturedOptions;
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield { type: "system", subtype: "init", session_id: "fake-session" } as unknown as SDKMessage;
      }
      return generate();
    }) as Parameters<typeof runTurn>[3];

    await runTurn("remember something", () => {}, new AbortController().signal, fakeQueryFn);

    const preToolUseHooks = capturedOptions?.hooks?.["PreToolUse"];
    assert.ok(preToolUseHooks && preToolUseHooks.length > 0, "options.hooks.PreToolUse must be present");
    const wiredHooks = preToolUseHooks![0]!.hooks;
    assert.equal(wiredHooks.length, 3, "expected 3 PreToolUse hooks after this PR's addition (sendGate, askUserQuestion, memoryGate)");
    const memoryHook = wiredHooks[2]!;

    const result = await memoryHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "test-session",
        transcript_path: "/dev/null",
        cwd: "/tmp",
        tool_name: "Write",
        tool_input: { file_path: "/Users/harrison/.rachel/memory/attacker-planted.md", content: "attacker text" },
      },
      undefined,
      { signal: new AbortController().signal },
    );

    assert.equal(result.hookSpecificOutput?.permissionDecision, "deny", "the wired 3rd hook must deny a memory write when RACHEL_UNTRUSTED_CONTENT is set");
    assert.match(result.hookSpecificOutput?.permissionDecisionReason ?? "", /untrusted/i);
  } finally {
    if (original === undefined) {
      delete process.env["RACHEL_UNTRUSTED_CONTENT"];
    } else {
      process.env["RACHEL_UNTRUSTED_CONTENT"] = original;
    }
  }
});
