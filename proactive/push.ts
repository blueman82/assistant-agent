#!/usr/bin/env -S npx tsx
// Proactive push chokepoint. Owns the state store at ~/.rachel/proactive/
// and is the ONLY code that reads/writes it. Library for the deterministic
// sweep, CLI for LLM one-shots.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { sendChunked } from "../bridge/api.ts";
import { loadTelegramConfig } from "../gate/surfaces/telegram.ts";

const SEVERITIES = ["urgent", "normal", "digest"] as const;
export type Severity = (typeof SEVERITIES)[number];
export type PushResult = "sent" | "deferred" | "dedup";

function isSeverity(value: string): value is Severity {
  return (SEVERITIES as readonly string[]).includes(value);
}

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

// Absent-is-empty is a documented contract, so ONLY ENOENT maps to
// undefined. Anything else — corrupt JSON, EACCES, EIO — throws loud with
// the file path: a corrupt deferred.json silently read as empty would let
// the next write-back permanently destroy every queued entry.
function readJson<T>(path: string): T | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new Error(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`corrupt JSON in ${path}: ${err instanceof Error ? err.message : String(err)}`);
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

// readFamilyFile/writeFamilyFile are exported for push.test.ts only — no
// production caller exists outside this module, preserving the "push.ts is
// the only reader/writer of the store" invariant.
export function readFamilyFile(baseDir: string, family: string): FamilyFile {
  const path = join(baseDir, `${family}.json`);
  const parsed = readJson<FamilyFile>(path);
  if (parsed === undefined) {
    return { schema_version: 1, events: {} };
  }
  // schema_version is load-bearing: an unrecognised shape means silent
  // dedup loss (a re-ping storm), so it fails loud like corrupt JSON.
  if (parsed.schema_version !== 1 || typeof parsed.events !== "object" || parsed.events === null || Array.isArray(parsed.events)) {
    throw new Error(`corrupt family store ${path}: unrecognised shape (want schema_version 1 with an events object)`);
  }
  return parsed;
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
  const path = join(baseDir, "deferred.json");
  const parsed = readJson<DeferredFile>(path);
  if (parsed === undefined) {
    return { schema_version: 1, entries: [] };
  }
  // Fail loud on an unrecognised shape — treating it as empty would let the
  // flush write-back destroy every queued entry (defer never drops).
  if (parsed.schema_version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error(`corrupt deferred queue ${path}: unrecognised shape (want schema_version 1 with an entries array)`);
  }
  return parsed;
}

// Returns the count for today's DUBLIN date; a stored different date means
// the counter has rolled over to 0. Unlike the family/deferred stores, a
// corrupt budget.json is loud-but-tolerated (treated as 0 sent): failing
// loud here would block every normal ping, and resetting the counter only
// leaks in the safe direction — pings still deliver, capped from now on.
function interruptsSentToday(baseDir: string, today: string): number {
  const path = join(baseDir, "budget.json");
  let budget: BudgetFile | undefined;
  try {
    budget = readJson<BudgetFile>(path);
    if (budget !== undefined && (budget.schema_version !== 1 || typeof budget.interrupts_sent !== "number")) {
      throw new Error(`corrupt budget file ${path}: unrecognised shape`);
    }
  } catch (err) {
    console.error(`[push] ${err instanceof Error ? err.message : String(err)} — treating as 0 interrupts sent today (leaky-safe)`);
    return 0;
  }
  return budget?.date === today ? budget.interrupts_sent : 0;
}

const FAMILY_RE = /^[a-z][a-z0-9-]*$/;

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
  if (!isSeverity(severity)) {
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
  // Post-send bookkeeping must never turn a DELIVERED alert into a caller-
  // visible failure: the message is already in Gary's chat, so a store or
  // budget write error here logs loud (with the path) and still returns
  // "sent" — a rethrow would make callers fall back or retry and double-
  // deliver. Cost of swallowing: the event stays unrecorded, so the next
  // observation may re-ping once; that beats a guaranteed duplicate now.
  try {
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
  } catch (err) {
    console.error(
      `[push] post-send bookkeeping failed for ${family}/${eventId} under ${d.baseDir}: ${err instanceof Error ? err.message : String(err)} — treating as sent (never re-deliver a delivered alert)`,
    );
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
  // every entry NOT in the flushed snapshot (matched on family+queued_at+
  // event_id — the family qualifier stops a cross-family same-millisecond
  // collision deleting an unflushed entry), so an entry a concurrent push
  // appended mid-send survives — never a blind truncate to empty.
  const flushKey = (e: DeferredEntry): string => `${e.family}|${e.queued_at}|${e.event_id}`;
  const flushedKeys = new Set(eligible.map(flushKey));
  const remaining = readDeferred(d.baseDir).entries.filter((e) => !flushedKeys.has(flushKey(e)));
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
  if (!isSeverity(severity)) {
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
    const result = await push(family, eventId, state, severity, text, deps);
    console.log(`[push] ${result}.`);
    return 0;
  } catch (err) {
    // Full stack for non-usage failures — these land in launchd logs where
    // the stack is the only debugging signal.
    console.error(`[push] ${err instanceof Error ? err.stack ?? String(err) : String(err)}`);
    return 1;
  }
}

const HM_RE = /^\d{2}:\d{2}$/;

// Returns a description of the first problem, or undefined when valid.
function configProblem(cfg: ProactiveConfig): string | undefined {
  try {
    // Intl probe: the only reliable way to know a timezone string is real.
    new Intl.DateTimeFormat("en-GB", { timeZone: cfg.timezone });
  } catch {
    return `unknown timezone ${JSON.stringify(cfg.timezone)}`;
  }
  if (
    typeof cfg.quiet_hours !== "object" ||
    cfg.quiet_hours === null ||
    !HM_RE.test(String(cfg.quiet_hours.start)) ||
    !HM_RE.test(String(cfg.quiet_hours.end))
  ) {
    return `quiet_hours must be { start: "HH:MM", end: "HH:MM" }`;
  }
  if (typeof cfg.daily_budget !== "number" || !Number.isFinite(cfg.daily_budget)) {
    return "daily_budget must be a finite number";
  }
  if (!Array.isArray(cfg.calendar_oneshot_hours) || !cfg.calendar_oneshot_hours.every((h) => Number.isInteger(h))) {
    return "calendar_oneshot_hours must be an array of integers";
  }
  return undefined;
}

// config.json is written by the (Loop-2) installer, never by push.ts.
// Absent => sane defaults. Corrupt or invalid after the shallow merge =>
// loud console.error, then DEFAULT_CONFIG — better default pings than none,
// but never silently.
export function loadConfig(baseDir: string): ProactiveConfig {
  const path = join(baseDir, "config.json");
  let parsed: Partial<ProactiveConfig> | undefined;
  try {
    parsed = readJson<Partial<ProactiveConfig>>(path);
  } catch (err) {
    console.error(`[push] ${err instanceof Error ? err.message : String(err)} — falling back to DEFAULT_CONFIG`);
    return { ...DEFAULT_CONFIG };
  }
  if (parsed === undefined) {
    return { ...DEFAULT_CONFIG };
  }
  const merged = { ...DEFAULT_CONFIG, ...parsed };
  const problem = configProblem(merged);
  if (problem !== undefined) {
    console.error(`[push] invalid config.json (${path}): ${problem} — falling back to DEFAULT_CONFIG`);
    return { ...DEFAULT_CONFIG };
  }
  return merged;
}

// Inclusive start, exclusive end. A start later than the end means the
// window wraps midnight (the 22:30-08:00 default).
export function inQuietWindow(d: Date, cfg: ProactiveConfig): boolean {
  const m = zonedMinutesOfDay(d, cfg.timezone);
  const startM = parseHM(cfg.quiet_hours.start);
  const endM = parseHM(cfg.quiet_hours.end);
  return startM < endM ? m >= startM && m < endM : m >= startM || m < endM;
}

// Only run as a CLI when executed directly (tsx proactive/push.ts ...), not
// when imported by the sweep or a test — same guard as notify.ts/rachel.ts.
// MUST stay the last statement in this module (same layout as notify.ts and
// sweep.ts): the top-level await runs during module evaluation, so any
// `const` declared below it would be in its temporal dead zone for every
// CLI code path — that exact bug (HM_RE) crashed all one-shots once
// config.json existed.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await cliMain(process.argv));
}
