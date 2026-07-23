import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { denyOutput } from "./sendGate.ts";
import { validateFrontmatter } from "../proactive/memoryLint.ts";

const MEMORY_DIR = join(homedir(), ".rachel", "memory");
const INDEX_FILENAME = "MEMORY.md";

// A raw substring test on a model-supplied path is bypassable multiple ways
// — a security-review finding (2026-07-24), corrected once already:
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
function resolveReal(filePath: string): string {
  const abs = resolve(filePath);
  try {
    return realpathSync(abs);
  } catch {
    try {
      return join(realpathSync(dirname(abs)), basename(abs));
    } catch {
      // Neither the path nor its parent exists — the lexical form is the
      // best available signal. Not silently more permissive: the caller's
      // startsWith check still applies to this value, and the top-level
      // try/catch around the whole hook already denies on any exception
      // escaping this function.
      return abs;
    }
  }
}

function isInsideMemoryDir(filePath: string): boolean {
  const real = resolveReal(filePath).toLowerCase();
  const dirWithSep = (resolveReal(MEMORY_DIR) + sep).toLowerCase();
  return real.startsWith(dirWithSep);
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
          if (typeof filePath === "string" && isInsideMemoryDir(filePath)) {
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
          && isInsideMemoryDir(filePath)
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
