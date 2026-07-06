import { createHash } from "node:crypto";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { ApprovalSurface, PendingApproval } from "./types.ts";

// Sorted-key JSON.stringify, recursing into nested objects/arrays, so two
// objects with the same content but different key order canonicalise
// identically. Approval binding depends on this being stable.
export function canonicalise(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function hashInput(toolInput: unknown): string {
  return createHash("sha256").update(canonicalise(toolInput)).digest("hex");
}

export const GATED_TOOL_NAMES: readonly string[] = [
  "mcp__claude_ai_Slack__slack_send_message",
  "mcp__claude_ai_Google_Calendar__create_event",
  "mcp__claude_ai_Google_Calendar__update_event",
  "mcp__claude_ai_Google_Calendar__delete_event",
  "mcp__claude_ai_Google_Calendar__respond_to_event",
];

// Internal deny timeout — strictly shorter than any matcher-level `timeout`
// we'd configure, and load-bearing regardless of matcher timeout: the spike
// (.claude/spike-notes-hook-semantics.md) proved the SDK does not cut hooks
// off itself on either throw or matcher-timeout-exceeded, so this race is the
// only actual enforcement of fail-closed-on-timeout.
const INTERNAL_DENY_TIMEOUT_MS = 60_000;

function denyOutput(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  };
}

function allowOutput() {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "allow" as const,
    },
  };
}

export function createSendGateHook(
  surfaces: ApprovalSurface[],
  auditLogPath: string,
  approvals: Map<string, PendingApproval> = new Map(),
  internalDenyTimeoutMs: number = INTERNAL_DENY_TIMEOUT_MS,
): HookCallback {
  return async (input) => {
    // Belt-and-braces per the spike: the SDK does not fail-closed on a
    // throwing or slow hook, so every path below must itself resolve to deny
    // on any exception, and the timeout race is the caller's own enforcement.
    try {
      if (input.hook_event_name !== "PreToolUse") {
        return {};
      }
      const toolName = input.tool_name;
      const toolInput = input.tool_input;

      const { matchesBashSendPattern } = await import("./bashPatterns.ts");
      if (toolName === "Bash") {
        const command = typeof (toolInput as Record<string, unknown>)?.["command"] === "string"
          ? (toolInput as Record<string, unknown>)["command"] as string
          : "";
        if (matchesBashSendPattern(command)) {
          const reason =
            "Send-capable Bash command blocked — use the corresponding MCP tool instead (Slack/Gmail/Calendar), which routes through the approval gate.";
          appendAudit(auditLogPath, { event: "attempt", toolName, hash: hashInput(toolInput), surface: "bash-pattern" });
          appendAudit(auditLogPath, { event: "decision", toolName, hash: hashInput(toolInput), surface: "bash-pattern", decision: "deny" });
          return denyOutput(reason);
        }
        return {};
      }

      if (!GATED_TOOL_NAMES.includes(toolName)) {
        return {};
      }

      const hash = hashInput(toolInput);

      const existing = approvals.get(hash);
      if (existing?.consumed) {
        // One-shot: a previously-consumed approval for this exact hash can
        // never be reused, no matter what any surface would say now.
        appendAudit(auditLogPath, { event: "attempt", toolName, hash, surface: "replay" });
        appendAudit(auditLogPath, { event: "decision", toolName, hash, surface: "replay", decision: "deny" });
        return denyOutput("Approval already consumed — request a fresh approval.");
      }

      appendAudit(auditLogPath, { event: "attempt", toolName, hash, surface: "pending" });

      const pending: PendingApproval = existing ?? {
        hash,
        toolName,
        toolInput,
        createdAt: Date.now(),
        consumed: false,
      };
      approvals.set(hash, pending);

      const decision = await raceSurfaces(surfaces, toolName, toolInput, hash, internalDenyTimeoutMs);

      if (decision === "approve") {
        pending.consumed = true;
        appendAudit(auditLogPath, { event: "decision", toolName, hash, surface: "resolved", decision: "allow" });
        return allowOutput();
      }

      appendAudit(auditLogPath, { event: "decision", toolName, hash, surface: "resolved", decision: "deny" });
      return denyOutput("No approval received — redraft or ask the operator directly.");
    } catch {
      // Fail-closed under exception (NC4) — never allow-through on a throw
      // anywhere in this body, per the spike's confirmed SDK fail-open finding.
      return denyOutput("Internal gate error — denied by default.");
    }
  };
}

async function raceSurfaces(
  surfaces: ApprovalSurface[],
  toolName: string,
  toolInput: unknown,
  hash: string,
  internalDenyTimeoutMs: number,
): Promise<"approve" | "deny"> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<"deny">((resolve) => {
    timer = setTimeout(() => resolve("deny"), internalDenyTimeoutMs);
  });

  const surfacePromises = surfaces.map((s) =>
    s.requestApproval(toolName, toolInput, hash).catch<"deny">(() => "deny"),
  );

  try {
    return await Promise.race([...surfacePromises, timeoutPromise]);
  } finally {
    // Prevent the losing timer from keeping the event loop alive (or firing
    // late) once the race has already settled via a surface response.
    clearTimeout(timer!);
  }
}

function appendAudit(
  auditLogPath: string,
  row: { event: "attempt" | "decision"; toolName: string; hash: string; surface: string; decision?: "allow" | "deny" },
): void {
  // Deferred import to keep sendGate.ts's own unit tests independent of
  // auditLog.ts's fs side effects when a caller passes a stub path; auditLog
  // itself is exercised directly in auditLog.test.ts.
  import("./auditLog.ts").then(({ appendAuditRow }) => {
    appendAuditRow(auditLogPath, { ts: new Date().toISOString(), ...row });
  }).catch(() => {
    // Audit-log failure must never affect the gate decision already returned.
  });
}
