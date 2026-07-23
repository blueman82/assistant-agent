import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "node:os";
import { join } from "node:path";
import { denyOutput } from "./sendGate.ts";

const MEMORY_DIR = join(homedir(), ".rachel", "memory");

export function createMemoryGateHook(): HookCallback {
  return async (input) => {
    try {
      if (input.hook_event_name !== "PreToolUse") {
        return {};
      }

      if (process.env["RACHEL_UNTRUSTED_CONTENT"] && input.tool_name === "Write") {
        const filePath = (input.tool_input as Record<string, unknown>)?.["file_path"];
        if (typeof filePath === "string" && filePath.includes(MEMORY_DIR)) {
          return denyOutput(
            "This run is processing untrusted content (RACHEL_UNTRUSTED_CONTENT) — memory writes are disabled. Surface anything worth remembering in your digest instead.",
          );
        }
      }

      return {};
    } catch {
      return denyOutput("Internal hook error — denied by default.");
    }
  };
}
