import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalise, hashInput } from "./sendGate.ts";

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
