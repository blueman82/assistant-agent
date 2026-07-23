import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { denyOutput } from "./sendGate.ts";
import { validateFrontmatter } from "../proactive/memoryLint.ts";

const MEMORY_DIR = join(homedir(), ".rachel", "memory");
const INDEX_FILENAME = "MEMORY.md";

// A raw substring test on a model-supplied path is bypassable: "." segments,
// doubled separators, and (on this case-insensitive filesystem, confirmed
// empirically) case variants all resolve to the exact same file while
// failing a plain includes() check — a security-review finding (2026-07-24).
// path.resolve() collapses "." / ".." / doubled separators; case-folding
// both sides matches the filesystem's own case-insensitivity; anchoring with
// `+ sep` (not includes()) prevents a sibling directory like
// "memory-notes/" from matching as a false positive.
function isInsideMemoryDir(filePath: string): boolean {
  const resolved = resolve(filePath).toLowerCase();
  const dirWithSep = (MEMORY_DIR + sep).toLowerCase();
  return resolved.startsWith(dirWithSep);
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
          if (typeof filePath === "string" && filePath.includes(MEMORY_DIR)) {
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
          && filePath.includes(MEMORY_DIR)
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
