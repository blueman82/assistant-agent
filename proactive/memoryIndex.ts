import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Absent-is-empty is a documented contract, matching proactive/push.ts's
// readJson — only ENOENT means "no memories yet". Anything else (corrupt
// file, EACCES, EISDIR) throws loud with the path named: silently
// degrading to an unchanged prompt on a real read failure would hide a
// broken memory store instead of surfacing it.
export function composeSystemPrompt(basePrompt: string, memoryPath: string): string {
  let index: string;
  try {
    index = readFileSync(memoryPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return basePrompt;
    }
    throw new Error(`cannot read memory index ${memoryPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return basePrompt;
}
