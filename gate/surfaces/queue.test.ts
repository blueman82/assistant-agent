import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeQueueEntry, createQueueApprovalSurface } from "./queue.ts";

function tempQueueDir(): string {
  return mkdtempSync(join(tmpdir(), "queue-test-"));
}

test("writeQueueEntry writes the frozen QueueFileEntry shape to <hash>.json", () => {
  const dir = tempQueueDir();
  writeQueueEntry(dir, {
    hash: "abc123",
    toolName: "mcp__claude_ai_Slack__slack_send_message",
    toolInput: { channel: "#general", text: "hi" },
    createdAt: 1234,
    status: "pending",
  });
  const path = join(dir, "abc123.json");
  assert.ok(existsSync(path));
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(parsed.hash, "abc123");
  assert.equal(parsed.toolName, "mcp__claude_ai_Slack__slack_send_message");
  assert.deepEqual(parsed.toolInput, { channel: "#general", text: "hi" });
  assert.equal(parsed.createdAt, 1234);
  assert.equal(parsed.status, "pending");
});

test("field names are exact — a wrong field name must fail this check", () => {
  const dir = tempQueueDir();
  writeQueueEntry(dir, {
    hash: "def456",
    toolName: "X",
    toolInput: {},
    createdAt: 1,
    status: "pending",
  });
  const parsed = JSON.parse(readFileSync(join(dir, "def456.json"), "utf8"));
  // Deliberately assert the WRONG (snake_case) field name is absent, proving
  // this test would fail if the implementation used tool_name instead of
  // toolName.
  assert.equal(parsed.tool_name, undefined);
  assert.equal(parsed.toolName, "X");
});

test("queue directory is created if absent (idempotent)", () => {
  const base = tempQueueDir();
  const nested = join(base, "not-yet-created");
  writeQueueEntry(nested, { hash: "h1", toolName: "X", toolInput: {}, createdAt: 1, status: "pending" });
  writeQueueEntry(nested, { hash: "h2", toolName: "X", toolInput: {}, createdAt: 2, status: "pending" });
  assert.ok(existsSync(join(nested, "h1.json")));
  assert.ok(existsSync(join(nested, "h2.json")));
});

test("createQueueApprovalSurface writes a pending entry then resolves once status flips to approved", async () => {
  const dir = tempQueueDir();
  const surface = createQueueApprovalSurface(dir, /* pollIntervalMs */ 10);
  const promise = surface.requestApproval("mcp__claude_ai_Slack__slack_send_message", { text: "hi" }, "hash1");

  // Simulate an external actor (future dashboard button) flipping the file's
  // status after the surface has already written the pending entry.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const path = join(dir, "hash1.json");
  const entry = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(entry.status, "pending");

  const { writeFileSync } = await import("node:fs");
  writeFileSync(path, JSON.stringify({ ...entry, status: "approved" }));

  const decision = await promise;
  assert.equal(decision, "approve");
});

test("createQueueApprovalSurface resolves deny when status flips to denied", async () => {
  const dir = tempQueueDir();
  const surface = createQueueApprovalSurface(dir, 10);
  const promise = surface.requestApproval("mcp__claude_ai_Slack__slack_send_message", { text: "hi" }, "hash2");

  await new Promise((resolve) => setTimeout(resolve, 30));
  const path = join(dir, "hash2.json");
  const entry = JSON.parse(readFileSync(path, "utf8"));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path, JSON.stringify({ ...entry, status: "denied" }));

  const decision = await promise;
  assert.equal(decision, "deny");
});

test("a poll landing on malformed/partial JSON does not crash — surface keeps polling until valid status arrives", async () => {
  const dir = tempQueueDir();
  const surface = createQueueApprovalSurface(dir, 10);
  const promise = surface.requestApproval("mcp__claude_ai_Slack__slack_send_message", { text: "hi" }, "hash3");

  const path = join(dir, "hash3.json");
  const { writeFileSync } = await import("node:fs");

  // Simulate a poll tick landing mid-write (e.g. a non-atomic external
  // writer): truncated JSON should not throw out of the setInterval
  // callback — it must be swallowed and polling must continue.
  await new Promise((resolve) => setTimeout(resolve, 15));
  writeFileSync(path, '{"hash":"hash3","status":"appro'); // deliberately truncated

  await new Promise((resolve) => setTimeout(resolve, 15));
  writeFileSync(path, JSON.stringify({ hash: "hash3", toolName: "X", toolInput: {}, createdAt: 1, status: "approved" }));

  const decision = await promise;
  assert.equal(decision, "approve");
});
