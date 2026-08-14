import assert from "node:assert/strict";
import { test } from "node:test";
import { providerFromEnvironment } from "./selection.ts";

test("provider selection requires an explicit supported provider", () => {
  assert.equal(providerFromEnvironment({ RACHEL_PROVIDER: "claude" }), "claude");
  assert.equal(providerFromEnvironment({ RACHEL_PROVIDER: "CODEX" }), "codex");
  assert.throws(() => providerFromEnvironment({}), /must be set/);
  assert.throws(() => providerFromEnvironment({ RACHEL_PROVIDER: "other" }), /Unsupported/);
});
