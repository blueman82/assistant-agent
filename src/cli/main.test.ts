import assert from "node:assert/strict";
import { test } from "node:test";
import { resetCliSession, stopCliSession } from "./commands.ts";

test("CLI reset invalidates the session and confirms it", async () => {
  let reset = false;
  let output = "";
  await resetCliSession({ reset: async () => { reset = true; } }, (text) => { output += text; });
  assert.equal(reset, true);
  assert.equal(output, "Session reset.\n");
});

test("CLI stop reports whether it aborted an active turn", async () => {
  let output = "";
  let reason = "";
  await stopCliSession({ stop: async (value) => { reason = value ?? ""; return false; } }, (text) => { output += text; });
  await stopCliSession({ stop: async (value) => { reason = value ?? ""; return true; } }, (text) => { output += text; });
  assert.equal(reason, "user");
  assert.equal(output, "No active turn.\nStopped.\n");
});
