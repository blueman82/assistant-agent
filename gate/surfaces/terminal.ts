import * as readline from "node:readline/promises";
import type { ApprovalSurface } from "../types.ts";

// Prints the recipient + full canonicalised input and reads a y/n keystroke.
// A no-op (never resolves) when stdin isn't a TTY — a headless secretary run
// has no terminal to prompt, so this surface just sits out of the race and
// lets another surface (or the internal timeout) decide.
export function createTerminalApprovalSurface(): ApprovalSurface {
  return {
    async requestApproval(toolName, toolInput, hash) {
      if (!process.stdin.isTTY) {
        return new Promise(() => {});
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        console.log(`\n[send-gate] Approval requested for ${toolName} (hash ${hash.slice(0, 12)}...)`);
        console.log(JSON.stringify(toolInput, null, 2));
        const answer = await rl.question("[send-gate] Approve? (y/n): ");
        return answer.trim().toLowerCase() === "y" ? "approve" : "deny";
      } finally {
        rl.close();
      }
    },
  };
}
