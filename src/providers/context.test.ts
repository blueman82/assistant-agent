import assert from "node:assert/strict";
import { test } from "node:test";
import { providerPrompt } from "./context.ts";

test("projects memories and recent conversation before the new user turn", () => {
  assert.equal(providerPrompt({
    text: "What should I do next?",
    context: {
      memories: [{ text: "The owner prefers concise answers." }],
      conversation: [{ role: "user", text: "I finished the design." }, { role: "assistant", text: "Run the focused checks." }],
    },
  }), "Relevant durable memories:\n- The owner prefers concise answers.\n\nRecent conversation:\nuser: I finished the design.\nassistant: Run the focused checks.\n\nuser: What should I do next?");
});

test("leaves the provider prompt unchanged without context", () => {
  assert.equal(providerPrompt({ text: "Hello" }), "Hello");
});
