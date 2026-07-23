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
// the index is truncated to a tail slice plus an explicit marker telling
// the agent it was truncated and should consolidate. Never silently
// dropped — the marker plus the tail slice are both always visible.
//
// Tail, not head: MEMORY.md is append-ordered (new pointer lines are added
// at the end), so the oldest entries sit at the head and the newest at the
// tail. Keeping the head would evict the newest — statistically the most
// relevant — entries. Keeping the tail evicts the oldest instead.
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

    // Preserve the leading "# Memory Index" heading (if present) so a tail
    // slice doesn't silently drop the file's title. Only the first line is
    // treated as a header, and only when it looks like a markdown heading —
    // fixtures/inputs with no header are left alone rather than assuming
    // structure that isn't there.
    const firstNewline = buf.indexOf("\n");
    let header = "";
    let searchStart = 0;
    if (firstNewline !== -1 && buf.subarray(0, firstNewline).toString("utf8").startsWith("#")) {
      header = `${buf.subarray(0, firstNewline).toString("utf8")}\n\n`;
      searchStart = firstNewline + 1;
    }

    // Keep the LAST MAX_INDEX_BYTES bytes (the newest entries). Cut point is
    // relative to the start of the buffer.
    let cut = Math.max(searchStart, buf.length - MAX_INDEX_BYTES);

    // A raw byte cut can land inside a multi-byte UTF-8 character (the
    // operator's writing style uses em dashes and accented names
    // routinely), turning the truncated tail into a U+FFFD replacement
    // character. Advance FORWARD over any continuation bytes (10xxxxxx) at
    // the cut point so the slice always STARTS on a character boundary.
    while (cut < buf.length && (buf[cut] & 0xc0) === 0x80) {
      cut++;
    }
    const charBoundaryCut = cut;

    // Don't start mid-line: snap forward to just after the next newline so
    // the kept tail never opens with a truncated half pointer-line. But a
    // single oversized line (or one with its only newline right at the end
    // of the file) can push this snap all the way to buf.length, leaving an
    // EMPTY tail — a total silent wipe of the operator's memory, worse than
    // a partially-corrupt first line. If the line-snapped cut would leave
    // nothing (or only whitespace) behind, fall back to the character-
    // boundary cut instead: real, if imperfectly-split, content beats none.
    const nextNewline = buf.indexOf("\n", cut);
    if (nextNewline !== -1) {
      cut = nextNewline + 1;
    }
    if (buf.subarray(cut, buf.length).toString("utf8").trim() === "") {
      cut = charBoundaryCut;
    }

    const tail = buf.subarray(cut, buf.length).toString("utf8");
    index = `${header}[MEMORY.md truncated — older entries were dropped, keeping the most recent ${MAX_INDEX_BYTES} bytes; consolidate the index (see prompts/system.md's Memory contract).]\n\n${tail}`;
  }
  return `${basePrompt}\n\n${index}`;
}
