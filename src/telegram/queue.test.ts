import assert from "node:assert/strict";
import { test } from "node:test";
import { createSingleFlightQueue } from "./queue.ts";

test("worker error is reported via onError instead of swallowed", async () => {
  const errors: unknown[] = [];
  const queue = createSingleFlightQueue<string>(async (item) => {
    if (item === "bad") throw new Error("boom");
  }, (error) => errors.push(error));
  queue.add("bad");
  await queue.drain();
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as Error).message, "boom");
});

test("an error on one item does not stop later items from processing", async () => {
  const processed: string[] = [];
  const queue = createSingleFlightQueue<string>(async (item) => {
    if (item === "bad") throw new Error("boom");
    processed.push(item);
  });
  queue.add("bad");
  queue.add("good");
  await queue.drain();
  assert.deepEqual(processed, ["good"]);
});
