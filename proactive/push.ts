#!/usr/bin/env -S npx tsx
// Proactive push chokepoint. Owns the state store at ~/.rachel/proactive/
// and is the ONLY code that reads/writes it. Library for the deterministic
// sweep, CLI for LLM one-shots.

export type Severity = "urgent" | "normal" | "digest";
export type PushResult = "sent" | "deferred" | "dedup";

export interface PushDeps {
  now: () => Date;
  baseDir: string;
  sendFn: (text: string) => Promise<void>;
}

export interface ProactiveConfig {
  schema_version: 1;
  timezone: string;
  quiet_hours: { start: string; end: string };
  daily_budget: number;
  pr_watch_repos: string[];
  calendar_oneshot_hours: number[];
}

export const DEFAULT_CONFIG: ProactiveConfig = {
  schema_version: 1,
  timezone: "Europe/Dublin",
  quiet_hours: { start: "22:30", end: "08:00" },
  daily_budget: 10,
  pr_watch_repos: [],
  calendar_oneshot_hours: [8, 11, 14, 17],
};

// All time comparisons and date boundaries run in the configured timezone
// (Europe/Dublin) via Intl — never UTC arithmetic, never a tz library.
function zonedParts(d: Date, tz: string, options: Intl.DateTimeFormatOptions): Map<string, string> {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...options }).formatToParts(d);
  return new Map(parts.map((p) => [p.type, p.value]));
}

export function zonedMinutesOfDay(d: Date, tz: string): number {
  const parts = zonedParts(d, tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return Number(parts.get("hour")) * 60 + Number(parts.get("minute"));
}

export function zonedDateString(d: Date, tz: string): string {
  const parts = zonedParts(d, tz, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
}
