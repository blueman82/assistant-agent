import { createHash } from "node:crypto";
import type {
  ApprovalDecision,
  ApprovalPolicy,
  ApprovalRequest,
  ApprovalResolution,
  ToolRequest,
} from "./contracts.ts";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortKeys(record[key])]));
  }
  return value;
}

export function canonicalize(value: unknown): string {
  const result = JSON.stringify(sortKeys(value));
  if (result === undefined) throw new TypeError("approval input must be JSON-serializable");
  return result;
}

export function hashToolRequest(request: ToolRequest): string {
  return createHash("sha256")
    .update(canonicalize({ toolName: request.toolName, input: request.input }))
    .digest("hex");
}

const deny = (reason: string): ApprovalDecision => ({ decision: "deny", reason });

export function createApprovalPolicy(timeoutMs = 60_000): ApprovalPolicy {
  const pending = new Map<string, ApprovalRequest>();
  const waiters = new Map<string, (decision: ApprovalDecision) => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const consumed = new Set<string>();

  const policy: ApprovalPolicy = {
    hash: hashToolRequest,
    begin(request) {
      const hash = hashToolRequest(request);
      if (consumed.has(hash)) return deny("approval already consumed");
      pending.set(hash, request);
      return { decision: "deny", reason: "approval pending" };
    },
    request(request) {
      const initial = policy.begin(request);
      if (initial.reason !== "approval pending") return Promise.resolve(initial);
      const hash = hashToolRequest(request);
      return new Promise<ApprovalDecision>((resolve) => {
        waiters.set(hash, resolve);
        timers.set(hash, setTimeout(() => {
          if (!waiters.delete(hash)) return;
          pending.delete(hash);
          timers.delete(hash);
          resolve(deny("approval timed out"));
        }, timeoutMs));
      });
    },
    resolve(request, resolution) {
      const hash = hashToolRequest(request);
      if (consumed.has(hash)) return deny("approval already consumed");
      if (!pending.has(hash)) return deny("no matching approval request");
      pending.delete(hash);
      const timer = timers.get(hash);
      if (timer !== undefined) clearTimeout(timer);
      timers.delete(hash);
      const decision = resolution === "approve"
        ? { decision: "approve", reason: "approved" } as const
        : deny("approval denied");
      if (resolution === "approve") consumed.add(hash);
      waiters.get(hash)?.(decision);
      waiters.delete(hash);
      return decision;
    },
  };
  return policy;
}
