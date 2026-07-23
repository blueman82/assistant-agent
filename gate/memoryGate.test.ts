import { test } from "node:test";
import assert from "node:assert/strict";
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
