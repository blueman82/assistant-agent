import { test } from "node:test";
import assert from "node:assert/strict";
import { createTerminalApprovalSurface } from "./terminal.ts";
import { createSendGateHook, GATED_TOOL_NAMES } from "../sendGate.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreToolUseHookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

function tempAuditPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "terminal-test-"));
  return join(dir, "audit.jsonl");
}

function makeGatedInput(toolInput: unknown): PreToolUseHookInput {
  return {
    hook_event_name: "PreToolUse",
    session_id: "test-session",
    transcript_path: "/dev/null",
    cwd: "/tmp",
    tool_name: GATED_TOOL_NAMES[0]!,
    tool_input: toolInput,
  } as PreToolUseHookInput;
}

function permissionDecisionOf(output: HookJSONOutput): string | undefined {
  return "hookSpecificOutput" in output
    ? (output.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision
    : undefined;
}

test("PC1: a terminal-approved send (scripted 'y') passes the gate through the real terminal.ts module", async () => {
  const surface = createTerminalApprovalSurface({
    isTTY: true,
    askQuestion: async () => "y",
  });
  const hook = createSendGateHook([surface], tempAuditPath());
  const result = await hook(makeGatedInput({ channel: "#general", text: "hi" }), undefined, {
    signal: new AbortController().signal,
  });
  assert.equal(permissionDecisionOf(result), "allow");
});

test("PC1 negative control: a terminal-denied send (scripted 'n') is denied", async () => {
  const surface = createTerminalApprovalSurface({
    isTTY: true,
    askQuestion: async () => "n",
  });
  const hook = createSendGateHook([surface], tempAuditPath());
  const result = await hook(makeGatedInput({ channel: "#general", text: "hi" }), undefined, {
    signal: new AbortController().signal,
  });
  assert.equal(permissionDecisionOf(result), "deny");
});

test("non-TTY terminal surface sits out of the race (never resolves on its own) and the gate falls back to deny via the internal timeout", async () => {
  const surface = createTerminalApprovalSurface({ isTTY: false });
  const hook = createSendGateHook([surface], tempAuditPath(), new Map(), 50);
  const result = await hook(makeGatedInput({ channel: "#general", text: "hi" }), undefined, {
    signal: new AbortController().signal,
  });
  assert.equal(permissionDecisionOf(result), "deny");
});
