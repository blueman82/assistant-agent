import type { StopReason } from "../core/contracts.ts";

const STOP_REASONS = new Set<StopReason>(["deadline", "user", "shutdown", "reset"]);

export function stopReasonFromAbort(value: unknown): StopReason {
  return typeof value === "string" && STOP_REASONS.has(value as StopReason) ? value as StopReason : "user";
}
