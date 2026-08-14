import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryStore } from "./memory.ts";

function withStore(run: (store: MemoryStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "rachel-memory-"));
  const store = new MemoryStore(join(directory, "rachel.db"));
  try { run(store); } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}

test("migrates, stores conversation events, and preserves metadata", () => withStore((store) => {
  const lease = store.acquireTurnLease("default", "cli");
  assert.ok(lease);
  const event = store.appendConversationEvent({
    conversationId: "default", turnId: "turn-1", role: "user", content: "I prefer tea", metadata: { source: "cli" },
  }, lease);
  assert.deepEqual(store.listConversationEvents("default"), [{ ...event }]);
  assert.throws(() => store.appendConversationEvent({
    conversationId: "default", turnId: "late", role: "assistant", content: "late",
  }, { ...lease, token: "stale" }), /lease/);
}));

test("explicit memory operations retain provenance and version history", () => withStore((store) => {
  const event = store.appendConversationEvent({
    conversationId: "default", turnId: "turn-1", role: "user", content: "I prefer tea",
  });
  const first = store.remember({ kind: "preference", content: "Tea", source: "explicit", sourceEventId: event.id });
  const second = store.reviseMemory(first.id, { kind: "preference", content: "Coffee", source: "explicit" });
  assert.equal(second.version, 2);
  assert.equal(store.getMemory(first.id)?.supersededBy, second.id);
  assert.deepEqual(store.searchMemories("coffee"), [second]);
  assert.equal(store.forgetMemory(second.id), true);
  assert.deepEqual(store.searchMemories("coffee"), []);
  assert.equal(store.forgetMemory(second.id), false);
}));

test("expired leases can be fenced and replaced", () => withStore((store) => {
  const first = store.acquireTurnLease("default", "cli", 1);
  assert.ok(first);
  while (Date.now() <= first.expiresAt) { /* wait for the intentionally tiny test lease */ }
  const second = store.acquireTurnLease("default", "telegram", 1);
  assert.ok(second);
  assert.throws(() => store.appendConversationEvent({
    conversationId: "default", turnId: "stale", role: "user", content: "stale",
  }, first), /lease/);
}));
