import assert from "node:assert/strict";
import { test } from "node:test";
import { createApprovalPolicy, createSessionPolicy, hashToolRequest } from "./index.ts";

test("approval is bound to canonical tool input and consumed once", () => {
  const policy = createApprovalPolicy();
  const first = { requestId: "1", toolName: "send", input: { z: 1, a: { y: 2, x: 3 } } };
  const same = { requestId: "2", toolName: "send", input: { a: { x: 3, y: 2 }, z: 1 } };

  assert.equal(hashToolRequest(first), hashToolRequest(same));
  assert.equal(policy.begin(first).decision, "deny");
  assert.equal(policy.resolve(same, "approve").decision, "approve");
  assert.equal(policy.resolve(first, "approve").decision, "deny");
});

test("approval timeout denies and does not leave a reusable pending request", async () => {
  const policy = createApprovalPolicy(1);
  const request = { requestId: "1", toolName: "send", input: { message: "x" } };
  assert.deepEqual(await policy.request(request), { decision: "deny", reason: "approval timed out" });
  assert.deepEqual(policy.resolve(request, "approve"), { decision: "deny", reason: "no matching approval request" });
});

test("session policy only advances clean active sessions", () => {
  const policy = createSessionPolicy();
  assert.deepEqual(policy.start("s1"), { sessionId: "s1", status: "active" });
  assert.deepEqual(policy.checkpoint("c1"), { sessionId: "s1", status: "active", checkpointId: "c1" });
  assert.deepEqual(policy.taint("stop"), {
    sessionId: "s1", status: "tainted", checkpointId: "c1", abortReason: "stop",
  });
  assert.throws(() => policy.checkpoint("c2"), /inactive/);
  assert.deepEqual(policy.recover("s2", "c1"), { sessionId: "s2", status: "active", checkpointId: "c1" });
  assert.equal(policy.owns("s2"), true);
  assert.equal(policy.owns("s1"), false);
});
