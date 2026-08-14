import assert from "node:assert/strict";
import { test } from "node:test";
import { resetCliSession } from "./commands.ts";

test("CLI reset invalidates the session and confirms it", async () => {
  let reset = false;
  let output = "";
  await resetCliSession({ reset: async () => { reset = true; } }, (text) => { output += text; });
  assert.equal(reset, true);
  assert.equal(output, "Session reset.\n");
});
