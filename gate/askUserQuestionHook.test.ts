import { test } from "node:test";
import assert from "node:assert/strict";
import { createAskUserQuestionHook } from "./askUserQuestionHook.ts";
import type { PreToolUseHookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

// Extract permissionDecision from hook output (same pattern as sendGate.test.ts)
function permissionDecisionOf(output: HookJSONOutput): string | undefined {
  return "hookSpecificOutput" in output
    ? (output.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision
    : undefined;
}

function makeAskUserQuestionInput(question: string): PreToolUseHookInput {
  return {
    hook_event_name: "PreToolUse",
    session_id: "test-session",
    transcript_path: "/dev/null",
    cwd: "/tmp",
    tool_name: "AskUserQuestion",
    tool_input: { question },
  } as PreToolUseHookInput;
}

test("AskUserQuestion tool call -> deny with 'No host renderer' reason", async () => {
  const hook = createAskUserQuestionHook();
  const result = await hook(makeAskUserQuestionInput("What should I do?"), undefined, {
    signal: new AbortController().signal,
  });
  assert.equal(permissionDecisionOf(result), "deny");
  const reason = "hookSpecificOutput" in result
    ? (result.hookSpecificOutput as { permissionDecisionReason?: string } | undefined)?.permissionDecisionReason
    : undefined;
  assert.match(reason ?? "", /No host renderer available/);
});

test("non-AskUserQuestion tool (Read) -> pass-through with empty object", async () => {
  const hook = createAskUserQuestionHook();
  const input = {
    hook_event_name: "PreToolUse",
    session_id: "test-session",
    transcript_path: "/dev/null",
    cwd: "/tmp",
    tool_name: "Read",
    tool_input: { file_path: "/tmp/foo.txt" },
  } as PreToolUseHookInput;
  const result = await hook(input, undefined, { signal: new AbortController().signal });
  assert.deepEqual(result, {});
});

test("non-PreToolUse hook event -> pass-through with empty object", async () => {
  const hook = createAskUserQuestionHook();
  const input = {
    hook_event_name: "PostToolUse",
    session_id: "test-session",
    transcript_path: "/dev/null",
    cwd: "/tmp",
    tool_name: "AskUserQuestion",
    tool_input: { question: "test" },
  } as unknown as PreToolUseHookInput;
  const result = await hook(input, undefined, { signal: new AbortController().signal });
  assert.deepEqual(result, {});
});

test("hook throws exception -> deny with 'Internal hook error' reason", async () => {
  const hook = createAskUserQuestionHook();
  // Use a Proxy that throws when any property is accessed
  const input = new Proxy({} as PreToolUseHookInput, {
    get: () => {
      throw new Error("input threw");
    },
  });
  const result = await hook(input, undefined, { signal: new AbortController().signal });
  assert.equal(permissionDecisionOf(result), "deny");
  const reason = "hookSpecificOutput" in result
    ? (result.hookSpecificOutput as { permissionDecisionReason?: string } | undefined)?.permissionDecisionReason
    : undefined;
  assert.match(reason ?? "", /Internal hook error/);
});
