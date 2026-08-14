import assert from "node:assert/strict";
import { test } from "node:test";
import { createApprovalTransport } from "./approval.ts";

test("approval callback resolves the matching transport request", async () => {
  const calls: unknown[] = [];
  const transport = createApprovalTransport({
    async call(method, body) { calls.push([method, body]); return {}; },
    async getUpdates() { return []; },
    async download() {},
    async sendVoice() {},
  }, "7");
  const pending = transport.request("a".repeat(64), "send it");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(await transport.callback({ id: "q", from: { id: 7 }, data: `${"a".repeat(32)}:approve` }), {
    hash: "a".repeat(32), decision: "approve",
  });
  assert.equal(await pending, "approve");
  assert.equal(calls.length, 2);
});
