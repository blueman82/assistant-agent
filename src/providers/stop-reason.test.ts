import assert from "node:assert/strict";
import { test } from "node:test";
import { stopReasonFromAbort } from "./stop-reason.ts";

test("preserves adapter stop reasons", () => {
  assert.equal(stopReasonFromAbort("deadline"), "deadline");
  assert.equal(stopReasonFromAbort("shutdown"), "shutdown");
  assert.equal(stopReasonFromAbort("reset"), "reset");
  assert.equal(stopReasonFromAbort(undefined), "user");
});
