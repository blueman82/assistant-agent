#!/usr/bin/env -S npx tsx
// Proactive push chokepoint. Owns the state store at ~/.rachel/proactive/
// and is the ONLY code that reads/writes it. Library for the deterministic
// sweep, CLI for LLM one-shots.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { sendChunked } from "../bridge/api.ts";
import { loadTelegramConfig } from "../gate/surfaces/telegram.ts";

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

// Delivery goes through the existing bridge sender path. The destination is
// exclusively whatever loadTelegramConfig() resolves — there is no chat-id
// parameter anywhere in this module (test-pinned security invariant).
async function defaultSendFn(text: string): Promise<void> {
  const config = loadTelegramConfig();
  if (!config) {
    throw new Error("no Telegram config (RACHEL_TELEGRAM_TOKEN/RACHEL_TELEGRAM_CHAT_ID or ~/.rachel/telegram.json) — cannot send.");
  }
  await sendChunked(config, text);
}

function resolveDeps(deps?: Partial<PushDeps>): PushDeps {
  return {
    now: deps?.now ?? (() => new Date()),
    baseDir: deps?.baseDir ?? join(homedir(), ".rachel", "proactive"),
    sendFn: deps?.sendFn ?? defaultSendFn,
  };
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

const EVICTION_MS = 14 * 24 * 60 * 60 * 1000;

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

// Temp-file + rename in the same directory => atomic on APFS. A reader never
// sees a half-written store file.
function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, path);
}

export function readFamilyFile(baseDir: string, family: string): FamilyFile {
  return readJson<FamilyFile>(join(baseDir, `${family}.json`)) ?? { schema_version: 1, events: {} };
}

// Every write evicts entries not seen for 14 days — resolved events (a green
// PR, a passed calendar conflict) age out instead of accumulating forever.
export function writeFamilyFile(baseDir: string, family: string, data: FamilyFile, now: Date): void {
  const cutoff = now.getTime() - EVICTION_MS;
  const events: Record<string, EventRecord> = {};
  for (const [id, record] of Object.entries(data.events)) {
    if (record.last_seen >= cutoff) {
      events[id] = record;
    }
  }
  writeJsonAtomic(join(baseDir, `${family}.json`), { schema_version: 1, events });
}

export interface DeferredEntry {
  family: string;
  event_id: string;
  state: string;
  text: string;
  queued_at: number;
  reason: "quiet" | "budget" | "digest";
}

interface DeferredFile {
  schema_version: 1;
  entries: DeferredEntry[];
}

interface BudgetFile {
  schema_version: 1;
  date: string; // Dublin date string, YYYY-MM-DD
  interrupts_sent: number;
}

function readDeferred(baseDir: string): DeferredFile {
  return readJson<DeferredFile>(join(baseDir, "deferred.json")) ?? { schema_version: 1, entries: [] };
}

// Returns the count for today's DUBLIN date; a stored different date means
// the counter has rolled over to 0.
function interruptsSentToday(baseDir: string, today: string): number {
  const budget = readJson<BudgetFile>(join(baseDir, "budget.json"));
  return budget?.date === today ? budget.interrupts_sent : 0;
}

const FAMILY_RE = /^[a-z][a-z0-9-]*$/;
const SEVERITIES: readonly string[] = ["urgent", "normal", "digest"];

// No destination anywhere in this signature — delivery goes to whatever chat
// loadTelegramConfig() resolves (Gary's own), same trust class as notify.ts.
export async function push(
  family: string,
  eventId: string,
  state: string,
  severity: Severity,
  text: string,
  deps?: Partial<PushDeps>,
): Promise<PushResult> {
  const d = resolveDeps(deps);
  // 1. Validate — fail fast.
  if (!FAMILY_RE.test(family)) {
    throw new Error(`invalid family: ${JSON.stringify(family)} (must match /^[a-z][a-z0-9-]*$/)`);
  }
  if (!SEVERITIES.includes(severity)) {
    throw new Error(`invalid severity: ${JSON.stringify(severity)} (must be urgent | normal | digest)`);
  }
  const now = d.now();
  const nowMs = now.getTime();
  const cfg = loadConfig(d.baseDir);
  const fam = readFamilyFile(d.baseDir, family);
  const existing = fam.events[eventId];

  // 2. Dedup: same id + same state => one ping per state, never re-send.
  if (existing && existing.state === state) {
    existing.last_seen = nowMs;
    writeFamilyFile(d.baseDir, family, fam, now);
    return "dedup";
  }

  // Recording marks the event pinged, so a deferred event is not re-queued
  // on every subsequent sweep — the deferral IS its one ping per state.
  const recordEvent = (): void => {
    fam.events[eventId] = {
      state,
      first_seen: existing?.first_seen ?? nowMs,
      pinged_at: nowMs,
      last_seen: nowMs,
    };
    writeFamilyFile(d.baseDir, family, fam, now);
  };

  const defer = (reason: DeferredEntry["reason"]): PushResult => {
    const deferred = readDeferred(d.baseDir);
    deferred.entries.push({ family, event_id: eventId, state, text, queued_at: nowMs, reason });
    writeJsonAtomic(join(d.baseDir, "deferred.json"), deferred);
    recordEvent();
    return "deferred";
  };

  // 3. Digest never interrupts.
  if (severity === "digest") {
    return defer("digest");
  }
  // 4. Normal respects quiet hours.
  if (severity === "normal" && inQuietWindow(now, cfg)) {
    return defer("quiet");
  }
  // 5. Normal respects the daily budget (Dublin date; a stored different
  //    date means the counter reset to 0).
  const today = zonedDateString(now, cfg.timezone);
  if (severity === "normal" && interruptsSentToday(d.baseDir, today) >= cfg.daily_budget) {
    return defer("budget");
  }

  // 6. Send. A sendFn throw records NOTHING — the event stays un-pinged so
  //    the next sweep retries — and propagates to the caller.
  await d.sendFn(text);
  recordEvent();
  if (severity === "normal") {
    // Read-modify-write is not transactional; a one-shot racing a sweep can
    // under-count by ±1. Accepted: a leaky cap in the safe direction.
    writeJsonAtomic(join(d.baseDir, "budget.json"), {
      schema_version: 1,
      date: today,
      interrupts_sent: interruptsSentToday(d.baseDir, today) + 1,
    } satisfies BudgetFile);
  }
  return "sent";
}

export function getEventState(family: string, eventId: string, deps?: Partial<PushDeps>): string | undefined {
  const d = resolveDeps(deps);
  return readFamilyFile(d.baseDir, family).events[eventId]?.state;
}

// Flushes the deferred queue as ONE digest message. quiet- and digest-reason
// entries are eligible on every tick outside the quiet window; budget-reason
// entries ride only the SCHEDULED digest hours (calendar_oneshot_hours plus
// the quiet-window-open hour) so budget overflow lands hours apart, not on a
// 30-minute smoother.
//
// Delivery is AT-LEAST-ONCE by design: the write-back happens only after the
// send resolves, so a crash in between re-sends the batch next tick. That is
// the accepted defer-never-drop semantic, not a bug. Digest flushes never
// touch budget.json.
export async function flushDeferred(deps?: Partial<PushDeps>): Promise<"sent" | "empty" | "quiet"> {
  const d = resolveDeps(deps);
  const now = d.now();
  const cfg = loadConfig(d.baseDir);
  if (inQuietWindow(now, cfg)) {
    return "quiet";
  }
  const currentHour = Math.floor(zonedMinutesOfDay(now, cfg.timezone) / 60);
  const budgetEligibleHours = new Set([...cfg.calendar_oneshot_hours, Math.floor(parseHM(cfg.quiet_hours.end) / 60)]);
  const eligible = readDeferred(d.baseDir).entries.filter(
    (e) => e.reason !== "budget" || budgetEligibleHours.has(currentHour),
  );
  if (eligible.length === 0) {
    return "empty";
  }

  const quietCount = eligible.filter((e) => e.reason === "quiet").length;
  const budgetCount = eligible.filter((e) => e.reason === "budget").length;
  const breakdown = [
    ...(quietCount > 0 ? [`${quietCount} overnight`] : []),
    ...(budgetCount > 0 ? [`${budgetCount} over budget`] : []),
  ];
  const header =
    `[digest] ${eligible.length} ${eligible.length === 1 ? "item" : "items"}` +
    (breakdown.length > 0 ? ` (${breakdown.join(", ")})` : "") +
    ":";
  await d.sendFn([header, ...eligible.map((e) => e.text)].join("\n"));

  // Subtract-flushed-snapshot write-back: re-read at truncate time and keep
  // every entry NOT in the flushed snapshot (matched on queued_at+event_id),
  // so an entry a concurrent push appended mid-send survives — never a blind
  // truncate to empty.
  const flushedKeys = new Set(eligible.map((e) => `${e.queued_at}|${e.event_id}`));
  const remaining = readDeferred(d.baseDir).entries.filter((e) => !flushedKeys.has(`${e.queued_at}|${e.event_id}`));
  writeJsonAtomic(join(d.baseDir, "deferred.json"), { schema_version: 1, entries: remaining } satisfies DeferredFile);
  return "sent";
}

// CLI contract: EXACTLY five arguments after node+script. A sixth argument —
// whatever it is — is rejected: there is no destination argv, and never will
// be (pinned security invariant). The message text comes from a FILE, never
// argv — argv text hits shell quoting limits on multi-line messages, and a
// swept email body containing a send-looking string would otherwise land in
// the Bash tool_use command and trip gate/bashPatterns.ts (same rationale as
// bridge/notify.ts).
const USAGE = "[push] usage: push.ts <family> <event-id> <state> <severity> <message-file> (exactly five arguments)";

export async function cliMain(argv: string[], deps?: Partial<PushDeps>): Promise<number> {
  if (argv.length !== 7) {
    console.error(USAGE);
    return 2;
  }
  const [, , family, eventId, state, severity, messageFile] = argv as [string, string, string, string, string, string, string];
  if (!FAMILY_RE.test(family)) {
    console.error(`[push] invalid family: ${family}`);
    return 2;
  }
  if (!SEVERITIES.includes(severity)) {
    console.error(`[push] invalid severity: ${severity} (must be urgent | normal | digest)`);
    return 2;
  }
  let text: string;
  try {
    text = readFileSync(messageFile, "utf8");
  } catch (err) {
    console.error(`[push] cannot read message file: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  try {
    const result = await push(family, eventId, state, severity as Severity, text, deps);
    console.log(`[push] ${result}.`);
    return 0;
  } catch (err) {
    console.error(`[push] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// Only run as a CLI when executed directly (tsx proactive/push.ts ...), not
// when imported by the sweep or a test — same guard as notify.ts/rachel.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await cliMain(process.argv));
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
