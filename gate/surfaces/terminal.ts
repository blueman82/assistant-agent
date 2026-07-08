import * as readline from "node:readline/promises";
import type { ApprovalSurface } from "../types.ts";

export interface TerminalSurfaceOptions {
  // Injectable for tests, so PC1 can be exercised through the real module
  // without a real TTY or real stdin. Defaults to the real checks/interface.
  isTTY?: boolean;
  askQuestion?: (prompt: string) => Promise<string>;
}

// Prints the recipient + full canonicalised input and reads a y/n keystroke.
// A no-op (never resolves) when stdin isn't a TTY — a headless Rachel run
// has no terminal to prompt, so this surface just sits out of the race and
// lets another surface (or the internal timeout) decide.
export function createTerminalApprovalSurface(options: TerminalSurfaceOptions = {}): ApprovalSurface {
  const isTTY = options.isTTY ?? process.stdin.isTTY ?? false;
  const askQuestion = options.askQuestion ?? defaultAskQuestion;

  return {
    async requestApproval(toolName, toolInput, hash) {
      if (!isTTY) {
        return new Promise(() => {});
      }
      console.log(`\n[send-gate] Approval requested for ${toolName} (hash ${hash.slice(0, 12)}...)`);
      console.log(JSON.stringify(toolInput, null, 2));
      const answer = await askQuestion("[send-gate] Approve? (y/n): ");
      return answer.trim().toLowerCase() === "y" ? "approve" : "deny";
    },
  };
}

async function defaultAskQuestion(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}
