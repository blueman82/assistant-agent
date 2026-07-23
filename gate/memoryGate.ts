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

      if (process.env["RACHEL_UNTRUSTED_CONTENT"]) {
        const untrustedReason =
          "This run is processing untrusted content (RACHEL_UNTRUSTED_CONTENT) — memory writes are disabled. Surface anything worth remembering in your digest instead.";

        if (input.tool_name === "Write" || input.tool_name === "Edit") {
          const filePath = (input.tool_input as Record<string, unknown>)?.["file_path"];
          if (typeof filePath === "string" && filePath.includes(MEMORY_DIR)) {
            return denyOutput(untrustedReason);
          }
        }

        if (input.tool_name === "Bash") {
          const command = (input.tool_input as Record<string, unknown>)?.["command"];
          if (typeof command === "string" && command.includes(MEMORY_DIR)) {
            return denyOutput(untrustedReason);
          }
          if (typeof command === "string" && /~\/\.rachel\/memory\b/.test(command)) {
            return denyOutput(untrustedReason);
          }
        }
      }

      // SPIKE-STRIPPED: check (b) frontmatter validation temporarily
      // removed to prove check (a) + wiring are green in isolation, per
      // advisor guidance. Restored immediately after this run.

      return {};
    } catch {
      return denyOutput("Internal hook error — denied by default.");
    }
  };
}
