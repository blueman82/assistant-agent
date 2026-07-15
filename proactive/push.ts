#!/usr/bin/env -S npx tsx
// Proactive push chokepoint. Owns the state store at ~/.rachel/proactive/
// and is the ONLY code that reads/writes it. Library for the deterministic
// sweep, CLI for LLM one-shots.
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

function parseHM(hm: string): number {
  const [h, m] = hm.split(":");
  return Number(h) * 60 + Number(m);
}

export interface EventRecord {
  state: string;
  first_seen: number;
  pinged_at: number;
  last_seen: number;
}

export interface FamilyFile {
  schema_version: 1;
  events: Record<string, EventRecord>;
}

export function readFamilyFile(_baseDir: string, _family: string): FamilyFile {
  throw new Error("not implemented");
}

export function writeFamilyFile(_baseDir: string, _family: string, _data: FamilyFile, _now: Date): void {
  throw new Error("not implemented");
}

// config.json is written by the (Loop-2) installer, never by push.ts.
// Absent or malformed => sane defaults; a partial file shallow-merges over
// the defaults.
export function loadConfig(baseDir: string): ProactiveConfig {
  try {
    const parsed = JSON.parse(readFileSync(join(baseDir, "config.json"), "utf8")) as Partial<ProactiveConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// Inclusive start, exclusive end. A start later than the end means the
// window wraps midnight (the 22:30-08:00 default).
export function inQuietWindow(d: Date, cfg: ProactiveConfig): boolean {
  const m = zonedMinutesOfDay(d, cfg.timezone);
  const startM = parseHM(cfg.quiet_hours.start);
  const endM = parseHM(cfg.quiet_hours.end);
  return startM < endM ? m >= startM && m < endM : m >= startM || m < endM;
}
