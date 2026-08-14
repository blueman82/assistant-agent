import type { Severity } from "./types.ts";

export interface QuietHours {
  readonly startMinute: number;
  readonly endMinute: number;
}

export interface InterruptBudget {
  readonly limit: number;
  readonly used: number;
}

export function inQuietHours(minute: number, hours: QuietHours): boolean {
  if (hours.startMinute === hours.endMinute) return true;
  return hours.startMinute < hours.endMinute
    ? minute >= hours.startMinute && minute < hours.endMinute
    : minute >= hours.startMinute || minute < hours.endMinute;
}

export function allowInterrupt(severity: Severity, budget: InterruptBudget): boolean {
  return severity === "critical" || budget.used < budget.limit;
}

export function spendInterrupt(severity: Severity, budget: InterruptBudget): InterruptBudget {
  return severity === "critical" ? budget : { ...budget, used: budget.used + 1 };
}
