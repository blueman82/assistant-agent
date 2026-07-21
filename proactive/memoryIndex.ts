import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// RACHEL_MEMORY_PATH env seam — same idiom as RACHEL_AUDIT_LOG_PATH in
// rachel.ts: unset in production (falls back to the real
// ~/.rachel/memory/MEMORY.md path), so tests can redirect reads away from
// the operator's real memory store.
export function resolveMemoryPath(): string {
  return process.env["RACHEL_MEMORY_PATH"] ?? join(homedir(), ".rachel", "memory", "MEMORY.md");
}

// prompts/system.md's Memory contract says to consolidate at ~50 entries,
// but that's prompt-level convention with no code backstop — if
// self-maintenance is ever skipped, an unbounded MEMORY.md would make every
// turn pay the full token cost. This is the code backstop: past this size,
// the index is truncated to a head slice plus an explicit marker telling
// the agent it was truncated and should consolidate. Never silently
// dropped — the marker plus the head slice are both always visible.
const MAX_INDEX_BYTES = 32 * 1024;

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
  if (index.trim() === "") {
    return basePrompt;
  }
  if (Buffer.byteLength(index, "utf8") > MAX_INDEX_BYTES) {
    const buf = Buffer.from(index, "utf8");
    // A raw byte cut can land inside a multi-byte UTF-8 character (the
    // operator's writing style uses em dashes and accented names
    // routinely), turning the truncated tail into a U+FFFD replacement
    // character. Back up over any continuation bytes (10xxxxxx) at the cut
    // point so the slice always ends on a character boundary.
    let cut = MAX_INDEX_BYTES;
    while (cut > 0 && ((buf[cut] as number) & 0xc0) === 0x80) {
      cut--;
    }
    const head = buf.subarray(0, cut).toString("utf8");
    index = `${head}\n\n[MEMORY.md truncated at ${MAX_INDEX_BYTES} bytes — consolidate the index (see prompts/system.md's Memory contract).]`;
  }
  return `${basePrompt}\n\n${index}`;
}
