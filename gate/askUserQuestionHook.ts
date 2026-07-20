import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { denyOutput } from "./sendGate.ts";

export function createAskUserQuestionHook(): HookCallback {
  return async (input) => {
    try {
      if (input.hook_event_name !== "PreToolUse") {
        return {};
      }
      if (input.tool_name === "AskUserQuestion") {
        return denyOutput("No host renderer available — ask your question directly in conversational text instead.");
      }
      return {};
    } catch {
      return denyOutput("Internal hook error — denied by default.");
    }
  };
}
