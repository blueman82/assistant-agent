import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalise, hashInput, createSendGateHook, GATED_TOOL_NAMES } from "./sendGate.ts";
import type { ApprovalSurface, PendingApproval } from "./types.ts";
import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

test("canonicalise: same object with keys in different order -> identical string", () => {
  const a = { z: 1, a: 2, m: { y: 1, x: 2 } };
  const b = { a: 2, m: { x: 2, y: 1 }, z: 1 };
  assert.equal(canonicalise(a), canonicalise(b));
});

test("hashInput: differing canonicalised content -> different hash", () => {
  const h1 = hashInput({ a: 1 });
  const h2 = hashInput({ a: 2 });
  assert.notEqual(h1, h2);
});

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

function tempAuditPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "sendgate-test-"));
  return join(dir, "audit.jsonl");
}

const NEVER_RESOLVES: ApprovalSurface = {
  requestApproval: () => new Promise(() => {}),
};

test("NC1: well-formed gated tool_input, surface never resolves -> deny", async () => {
  const hook = createSendGateHook([NEVER_RESOLVES], tempAuditPath(), new Map(), 50);
  const result = await hook(makeGatedInput({ channel: "#general", text: "hi" }), undefined, {
    signal: new AbortController().signal,
  });
  assert.equal(result.hookSpecificOutput?.permissionDecision, "deny");
});

test("NC1 negative control: surface auto-resolves approve with no owner action -> allow", async () => {
  const autoApprove: ApprovalSurface = { requestApproval: async () => "approve" };
  const hook = createSendGateHook([autoApprove], tempAuditPath());
  const result = await hook(makeGatedInput({ channel: "#general", text: "hi" }), undefined, {
    signal: new AbortController().signal,
  });
  assert.equal(result.hookSpecificOutput?.permissionDecision, "allow");
});

test("NC3: replay of a consumed approval (same hash, second call) -> deny", async () => {
  const alwaysApprove: ApprovalSurface = { requestApproval: async () => "approve" };
  const approvals = new Map<string, PendingApproval>();
  const hook = createSendGateHook([alwaysApprove], tempAuditPath(), approvals);
  const input = makeGatedInput({ channel: "#general", text: "replay me" });

  const first = await hook(input, undefined, { signal: new AbortController().signal });
  assert.equal(first.hookSpecificOutput?.permissionDecision, "allow");

  const second = await hook(input, undefined, { signal: new AbortController().signal });
  assert.equal(second.hookSpecificOutput?.permissionDecision, "deny");
});

test("NC3 negative control: first (non-replay) call -> allow", async () => {
  const alwaysApprove: ApprovalSurface = { requestApproval: async () => "approve" };
  const hook = createSendGateHook([alwaysApprove], tempAuditPath());
  const result = await hook(makeGatedInput({ channel: "#general", text: "fresh" }), undefined, {
    signal: new AbortController().signal,
  });
  assert.equal(result.hookSpecificOutput?.permissionDecision, "allow");
});

test("NC2: approval for X, gate invoked with tampered Y reusing X's approval slot -> deny", async () => {
  const alwaysApprove: ApprovalSurface = { requestApproval: async () => "approve" };
  const approvals = new Map<string, PendingApproval>();
  const hook = createSendGateHook([alwaysApprove], tempAuditPath(), approvals);

  const inputX = makeGatedInput({ channel: "#general", text: "original" });
  const approveX = await hook(inputX, undefined, { signal: new AbortController().signal });
  assert.equal(approveX.hookSpecificOutput?.permissionDecision, "allow");

  // Y has different content -> different hash -> no stored approval for it,
  // even though the same surface would approve it if asked fresh. We use a
  // surface stub here that DENIES to prove the gate isn't just re-asking and
  // getting lucky — it must look up by hash, not fall through to the surface.
  const denySurface: ApprovalSurface = { requestApproval: async () => "deny" };
  const hookForY = createSendGateHook([denySurface], tempAuditPath(), approvals);
  const inputY = makeGatedInput({ channel: "#general", text: "tampered" });
  const resultY = await hookForY(inputY, undefined, { signal: new AbortController().signal });
  assert.equal(resultY.hookSpecificOutput?.permissionDecision, "deny");
});

test("NC2 negative control: invoking the gate with the SAME input X approval was granted for -> allow", async () => {
  const alwaysApprove: ApprovalSurface = { requestApproval: async () => "approve" };
  const hook = createSendGateHook([alwaysApprove], tempAuditPath());
  const inputX = makeGatedInput({ channel: "#general", text: "untampered" });
  const result = await hook(inputX, undefined, { signal: new AbortController().signal });
  assert.equal(result.hookSpecificOutput?.permissionDecision, "allow");
});

test("NC4: a throwing ApprovalSurface results in deny, not allow-through", async () => {
  const throwingSurface: ApprovalSurface = {
    requestApproval: async () => {
      throw new Error("surface exploded");
    },
  };
  const hook = createSendGateHook([throwingSurface], tempAuditPath());
  const result = await hook(makeGatedInput({ channel: "#general", text: "throw me" }), undefined, {
    signal: new AbortController().signal,
  });
  assert.equal(result.hookSpecificOutput?.permissionDecision, "deny");
});

test("NC4 negative control: a non-throwing surface resolves per its actual decision (deny)", async () => {
  const denySurface: ApprovalSurface = { requestApproval: async () => "deny" };
  const hook = createSendGateHook([denySurface], tempAuditPath());
  const result = await hook(makeGatedInput({ channel: "#general", text: "explicit deny" }), undefined, {
    signal: new AbortController().signal,
  });
  assert.equal(result.hookSpecificOutput?.permissionDecision, "deny");
});

test("NC4 negative control: a non-throwing surface resolves per its actual decision (allow)", async () => {
  const allowSurface: ApprovalSurface = { requestApproval: async () => "approve" };
  const hook = createSendGateHook([allowSurface], tempAuditPath());
  const result = await hook(makeGatedInput({ channel: "#general", text: "explicit allow" }), undefined, {
    signal: new AbortController().signal,
  });
  assert.equal(result.hookSpecificOutput?.permissionDecision, "allow");
});

test("non-gated tool_name -> hook returns {} (no opinion), no audit row written", async () => {
  const auditPath = tempAuditPath();
  const hook = createSendGateHook([NEVER_RESOLVES], auditPath);
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
  assert.throws(() => readFileSync(auditPath));
});

test("PC3: one full gate cycle (attempt -> decision) writes exactly 2 audit rows", async () => {
  const auditPath = tempAuditPath();
  const alwaysApprove: ApprovalSurface = { requestApproval: async () => "approve" };
  const hook = createSendGateHook([alwaysApprove], auditPath);
  await hook(makeGatedInput({ channel: "#general", text: "audit me" }), undefined, {
    signal: new AbortController().signal,
  });
  // Audit writes are fire-and-forget (async import) relative to the hook's
  // own resolution — poll briefly for the file to settle.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const lines = readFileSync(auditPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const rows = lines.map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.event).sort(), ["attempt", "decision"]);
});
