import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { resolveSystemPromptPath } from "./systemPrompt.ts";

const REPO = "/repo";
const LOCAL = join(REPO, "prompts", "system.local.md");
const GENERIC = join(REPO, "prompts", "system.md");

const never = () => false;
const always = () => true;

test("resolveSystemPromptPath: falls back to the generic tracked prompt when no local override exists", () => {
  assert.equal(resolveSystemPromptPath(REPO, {}, never), GENERIC);
});

test("resolveSystemPromptPath: prefers the operator's local prompt when it is present", () => {
  assert.equal(resolveSystemPromptPath(REPO, {}, always), LOCAL);
});

test("resolveSystemPromptPath: RACHEL_SYSTEM_PROMPT overrides both, without touching the filesystem", () => {
  let probed = false;
  const spy = () => {
    probed = true;
    return true;
  };
  const env = { RACHEL_SYSTEM_PROMPT: "/etc/custom-prompt.md" };
  assert.equal(resolveSystemPromptPath(REPO, env, spy), "/etc/custom-prompt.md");
  // The explicit override short-circuits: no existence probe should happen at
  // all, so a broken/absent path surfaces as rachel.ts's own missing-prompt
  // error naming the operator's path rather than silently falling back.
  assert.equal(probed, false, "explicit override must not probe the filesystem");
});

test("resolveSystemPromptPath: an explicit override wins even when a local prompt also exists", () => {
  const env = { RACHEL_SYSTEM_PROMPT: "/etc/custom-prompt.md" };
  assert.equal(resolveSystemPromptPath(REPO, env, always), "/etc/custom-prompt.md");
});

test("resolveSystemPromptPath: a blank RACHEL_SYSTEM_PROMPT is treated as unset, not as an empty path", () => {
  // An empty env var is much more likely an unset-variable accident in a
  // launchd plist than a deliberate request to read "". Falling through beats
  // failing to start.
  assert.equal(resolveSystemPromptPath(REPO, { RACHEL_SYSTEM_PROMPT: "" }, never), GENERIC);
  assert.equal(resolveSystemPromptPath(REPO, { RACHEL_SYSTEM_PROMPT: "   " }, never), GENERIC);
});
