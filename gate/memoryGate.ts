import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { denyOutput } from "./sendGate.ts";
import { validateFrontmatter } from "../proactive/memoryLint.ts";

const MEMORY_DIR = join(homedir(), ".rachel", "memory");
const INDEX_FILENAME = "MEMORY.md";

// A raw substring test on a model-supplied path is bypassable multiple ways
// — a security-review finding (2026-07-24), corrected twice already:
// - "." segments and doubled separators: path.resolve() collapses these
//   lexically (used below), but a plain includes() check missed them.
// - Case variants: this filesystem is case-insensitive (confirmed
//   empirically), so case-folding both sides is required.
// - Symlinks: path.resolve() does NOT follow symlinks — it is purely
//   lexical. A symlink whose target is the real memory dir lexically
//   resolves to a path outside MEMORY_DIR while the filesystem's actual
//   write target is inside it. realpathSync closes this; resolve() alone
//   does not (the first fix attempt used resolve() only and missed this).
// realpathSync throws ENOENT on a path that doesn't exist yet — the NORMAL
// case for a Write creating a new memory file — so this resolves the
// nearest EXISTING ancestor (the parent dir) and rejoins the basename
// rather than letting the throw propagate to a bypass-reinstating fallback.
//
// Only ENOENT is swallowed. Any OTHER resolution failure (EACCES, ELOOP,
// ENOTDIR, ...) means something exists at that ancestor that we could not
// see through — the lexical form may be actively hiding a symlink into the
// memory dir, not merely absent. Swallowing that too was a second bypass
// (security review, 2026-07-24): an unreadable ancestor hiding a
// memory-dir symlink returned the wrong-but-valid lexical path and passed
// the startsWith check as "outside". So this throws for non-ENOENT,
// matching proactive/memoryIndex.ts's "only ENOENT is silent" contract —
// the caller decides whether a throw here means deny (untrusted-context
// lockout) or fall back to unchanged behaviour (trusted-context schema
// check), see isInsideMemoryDirOrThrow's two callers below.
function resolveReal(filePath: string): string {
  const abs = resolve(filePath);
  try {
    return realpathSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    try {
      return join(realpathSync(dirname(abs)), basename(abs));
    } catch (err2) {
      if ((err2 as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err2;
      }
      // Neither the path nor its parent exists — the lexical form is the
      // best available signal, and genuinely safe: nothing unresolvable
      // remains that could be hiding a symlink.
      return abs;
    }
  }
}

// No lexical pre-check ahead of the syscall: a symlink can lexically look
// completely unrelated to the memory dir (that's the whole point of the
// bypass this function exists to close), so any pre-check cheap enough to
// skip realpathSync would also skip it for exactly the paths that need it.
// The syscall cost is accepted as-is (microseconds per review) rather than
// risk reintroducing the bypass via a fast path. Already scoped to only run
// for Write/Edit tool calls (see call sites below) — never on every tool
// call regardless of relevance.
//
// Can throw (a non-ENOENT resolveReal failure) — deliberately not caught
// here. Callers decide the fail-open/fail-closed tradeoff for their own
// context; see the two call sites below.
function isInsideMemoryDirOrThrow(filePath: string): boolean {
  const real = resolveReal(filePath).toLowerCase();
  const dirWithSep = (resolveReal(MEMORY_DIR) + sep).toLowerCase();
  return real.startsWith(dirWithSep);
}

// Trusted-context callers (the schema-validation branch below, which runs
// unconditionally, not just when RACHEL_UNTRUSTED_CONTENT is set) must NOT
// start denying Rachel's ordinary memory writes just because a path could
// not be fully resolved — that would be an over-block regression on normal
// CLI/bridge use. Falls back to the plain resolve()-based (non-realpath)
// comparison on any resolution failure, matching this check's pre-symlink-fix
// behaviour rather than newly blocking.
function isInsideMemoryDirPermissive(filePath: string): boolean {
  try {
    return isInsideMemoryDirOrThrow(filePath);
  } catch {
    const lexical = resolve(filePath).toLowerCase();
    return lexical.startsWith((MEMORY_DIR + sep).toLowerCase());
  }
}

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
          // Untrusted context: a resolution failure DENIES rather than
          // falls back — ambiguity in a security check is not a reason to
          // allow. isInsideMemoryDirOrThrow's throw (a non-ENOENT
          // resolveReal failure) reaches the hook's own top-level
          // try/catch below, which denies on any exception.
          if (typeof filePath === "string" && isInsideMemoryDirOrThrow(filePath)) {
            return denyOutput(untrustedReason);
          }
        }

        if (input.tool_name === "Bash") {
          const command = (input.tool_input as Record<string, unknown>)?.["command"];
          if (typeof command === "string" && command.includes(MEMORY_DIR)) {
            return denyOutput(untrustedReason);
          }
          // Best-effort: also catch the ~/.rachel/memory shorthand a shell
          // command is likely to use, same idiom as matchesBashSendPattern
          // in bashPatterns.ts (small, explicit patterns, not a general path
          // resolver).
          if (typeof command === "string" && /~\/\.rachel\/memory\b/.test(command)) {
            return denyOutput(untrustedReason);
          }
        }
      }

      if (input.tool_name === "Write") {
        const filePath = (input.tool_input as Record<string, unknown>)?.["file_path"];
        const content = (input.tool_input as Record<string, unknown>)?.["content"];
        if (
          typeof filePath === "string"
          && typeof content === "string"
          && isInsideMemoryDirPermissive(filePath)
          && filePath.endsWith(".md")
          && basename(filePath) !== INDEX_FILENAME
        ) {
          const findings = validateFrontmatter(content, basename(filePath));
          const errors = findings.filter((f) => f.level === "error");
          if (errors.length > 0) {
            const reason = errors.map((f) => f.message).join("; ");
            return denyOutput(`Memory frontmatter invalid — fix and retry: ${reason}`);
          }
        }
      }

      return {};
    } catch {
      return denyOutput("Internal hook error — denied by default.");
    }
  };
}
