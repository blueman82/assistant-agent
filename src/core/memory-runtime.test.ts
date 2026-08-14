import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore } from "./memory.ts";
import { createRachelMemory } from "./memory-runtime.ts";

async function* completed(text: string, seen: Array<unknown>): AsyncIterable<any> {
  seen.push(text);
  yield { type: "text", sessionId: "s", turnId: "t", text: "noted" };
  yield { type: "completed", sessionId: "s", turnId: "t" };
}

test("shared memory projects prior context and records automatic memories", async () => {
  const store = new MemoryStore();
  const memory = createRachelMemory(store);
  const seen: unknown[] = [];
  const session = {
    id: "s",
    run: (input: { text: string }) => completed(input.text, seen),
    async reset() {},
    async stop() { return false; },
  };
  for await (const _event of memory.run(session, { text: "I prefer concise answers" })) {}
  assert.deepEqual(seen, ["I prefer concise answers"]);
  assert.equal(store.searchMemories("concise")[0]?.source, "automatic");
  assert.equal(store.listConversationEvents("default").length, 2);
  await memory.resetConversation();
  assert.equal(store.listConversationEvents("default").length, 0);
  assert.equal(store.searchMemories("concise").length, 1);
  store.close();
});

test("a second runtime cannot take the active conversation lease", async () => {
  const store = new MemoryStore();
  const memory = createRachelMemory(store);
  const session = {
    id: "s",
    async *run() { yield { type: "started", sessionId: "s", turnId: "t" } as const; await new Promise(() => {}); },
    async reset() {},
    async stop() { return true; },
  };
  const active = memory.run(session, { text: "hold" })[Symbol.asyncIterator]();
  await active.next();
  await assert.rejects(async () => {
    for await (const _event of memory.run(session, { text: "blocked" })) {}
  }, /busy/);
  await active.return?.();
  store.close();
});
