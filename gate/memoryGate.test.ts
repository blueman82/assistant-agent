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

test("RACHEL_UNTRUSTED_CONTENT set + Write into memory dir -> deny", async () => {
  const original = process.env["RACHEL_UNTRUSTED_CONTENT"];
  process.env["RACHEL_UNTRUSTED_CONTENT"] = "1";
  try {
    const hook = createMemoryGateHook();
    const input = makeWriteInput("/Users/harrison/.rachel/memory/some-fact.md", "---\nname: some-fact\n---\n");
    const result = await hook(input, undefined, { signal: new AbortController().signal });
    assert.equal(permissionDecisionOf(result), "deny");
    assert.match(reasonOf(result) ?? "", /untrusted/i);
  } finally {
    if (original === undefined) {
      delete process.env["RACHEL_UNTRUSTED_CONTENT"];
    } else {
      process.env["RACHEL_UNTRUSTED_CONTENT"] = original;
    }
  }
});
