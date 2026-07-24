#!/usr/bin/env -S npx tsx
// Deterministic 30-minute proactive sweep tick (launchd: com.rachel.proactive-sweep).
// Consumes proactive/push.ts as a library — the sweep never touches the state
// store directly; every delivery decision (dedup, quiet, budget) lives in the
// chokepoint. Tick order is fixed: deferred flush FIRST, then bridge-liveness,
// then PR-red, then calendar (escalation then one-shot spawn), then the
// memory-lint store scan, then the ~/.rachel/tmp hygiene sweep. Each family
// runs in its own try/catch so one broken family never blocks the others and
// the tick still exits 0.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, readdirSync, lstatSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { push, flushDeferred, getEventState, loadConfig, zonedDateString, zonedMinutesOfDay } from "./push.ts";
import type { ProactiveConfig, PushDeps } from "./push.ts";
import { sendChunked } from "../bridge/api.ts";
import { loadTelegramConfig } from "../gate/surfaces/telegram.ts";
import { lintMemoryStore } from "./memoryLint.ts";
import type { Finding } from "./memoryLint.ts";
import { resolveMemoryPath } from "./memoryIndex.ts";

export interface SweepDeps {
  now: () => Date;
  execFn: (
    cmd: string,
    args: string[],
    opts?: { env?: Record<string, string>; stdinNull?: boolean; timeoutMs?: number },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  oneshotTimeoutMs: number;
  pushFn: typeof push;
  flushFn: typeof flushDeferred;
  getStateFn: typeof getEventState;
  statMtimeFn: (path: string) => Date | undefined;
  readFileFn: (path: string) => string | undefined;
  writeFileFn: (path: string, content: string) => void;
  lintFn: (memoryDir: string) => Finding[];
  // tmp-sweep seams. readDirFn returns undefined for a missing directory (a
  // no-op, not an error); lstatFn returns undefined for a vanished entry.
  readDirFn: (path: string) => string[] | undefined;
  lstatFn: (path: string) => Stats | undefined;
  unlinkFn: (path: string) => void;
  // Injected so the bridge-stale poll loop never really waits in tests.
  sleepFn: (ms: number) => Promise<void>;
  // Push-deps passthrough: forwarded to pushFn/flushFn/getStateFn so an
  // injected baseDir/clock/sendFn reaches the real chokepoint unchanged.
  sendFn?: PushDeps["sendFn"];
  baseDir: string;
  homeDir: string;
  repoDir: string;
  log: (line: string) => void;
}

// Default execFn: never throws on non-zero exit — the exit code is data
// (gh pr checks exits non-zero when checks fail). timeoutMs maps to
// execFile's timeout option, which kills the child on expiry. opts.env is
// merged OVER the inherited process.env, never replacing it — a launchd
// child stripped of PATH/HOME cannot resolve node. Exported for
// sweep.test.ts only — production callers go through SweepDeps.
export function defaultExecFn(
  cmd: string,
  args: string[],
  opts?: { env?: Record<string, string>; stdinNull?: boolean; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        env: opts?.env ? { ...process.env, ...opts.env } : process.env,
        timeout: opts?.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: 0 });
          return;
        }
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null };
        if (typeof e.code === "number") {
          resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: e.code });
          return;
        }
        // No numeric exit code: spawn failure (ENOENT) or kill (timeout /
        // signal). Fold the evidence into stderr so downstream logs carry
        // the truth instead of a bare exit-1 with nothing attached.
        const detail = [e.message, e.killed ? "(killed)" : "", e.signal ? `signal=${e.signal}` : ""]
          .filter(Boolean)
          .join(" ");
        const errText = String(stderr).trim() === "" ? detail : `${String(stderr)}\n${detail}`;
        resolve({ stdout: String(stdout), stderr: errText, exitCode: 1 });
      },
    );
    if (opts?.stdinNull) {
      child.stdin?.end();
    }
  });
}

function defaultStatMtime(path: string): Date | undefined {
  return statSync(path, { throwIfNoEntry: false })?.mtime;
}

function defaultReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

function defaultWriteFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// tmp-sweep default seams. Exported for sweep.test.ts, which injects a
// mkdtemp homeDir and then exercises these against the real filesystem —
// production callers go through SweepDeps like every other seam.
export function defaultReadDirFn(path: string): string[] | undefined {
  try {
    return readdirSync(path);
  } catch (err) {
    // A tmp dir that was never created is the normal state on a fresh host.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

// lstat, never stat: it reports on the symlink itself rather than its target,
// so isFile() rejects symlinks and directories in one check.
export function defaultLstatFn(path: string): Stats | undefined {
  return lstatSync(path, { throwIfNoEntry: false });
}

export function defaultUnlinkFn(path: string): void {
  unlinkSync(path);
}

const REPO_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function resolveSweepDeps(overrides?: Partial<SweepDeps>): SweepDeps {
  return {
    now: overrides?.now ?? (() => new Date()),
    execFn: overrides?.execFn ?? defaultExecFn,
    oneshotTimeoutMs: overrides?.oneshotTimeoutMs ?? 900_000,
    pushFn: overrides?.pushFn ?? push,
    flushFn: overrides?.flushFn ?? flushDeferred,
    getStateFn: overrides?.getStateFn ?? getEventState,
    statMtimeFn: overrides?.statMtimeFn ?? defaultStatMtime,
    readFileFn: overrides?.readFileFn ?? defaultReadFile,
    writeFileFn: overrides?.writeFileFn ?? defaultWriteFile,
    lintFn: overrides?.lintFn ?? ((memoryDir: string) => lintMemoryStore(memoryDir)),
    readDirFn: overrides?.readDirFn ?? defaultReadDirFn,
    lstatFn: overrides?.lstatFn ?? defaultLstatFn,
    unlinkFn: overrides?.unlinkFn ?? defaultUnlinkFn,
    sleepFn: overrides?.sleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    sendFn: overrides?.sendFn,
    baseDir: overrides?.baseDir ?? join(homedir(), ".rachel", "proactive"),
    homeDir: overrides?.homeDir ?? homedir(),
    repoDir: overrides?.repoDir ?? REPO_DIR,
    log: overrides?.log ?? console.log,
  };
}

function pushDepsOf(d: SweepDeps): Partial<PushDeps> {
  return { now: d.now, baseDir: d.baseDir, ...(d.sendFn ? { sendFn: d.sendFn } : {}) };
}

export type FamilyResult = "ok" | "failed";

async function runFamily(
  family: string,
  d: SweepDeps,
  errors: Record<string, string>,
  fn: () => Promise<void>,
): Promise<FamilyResult> {
  try {
    await fn();
    return "ok";
  } catch (err) {
    // Full stack — same convention as push.ts: launchd logs are the only
    // debugging signal. The first line is kept separately for the
    // escalation message.
    errors[family] = String(err instanceof Error ? err.message : err).split("\n")[0] ?? "unknown error";
    d.log(`[sweep] ${family} error: ${err instanceof Error ? (err.stack ?? String(err)) : String(err)}`);
    return "failed";
  }
}

// Wedged-alive threshold: >10 minutes without a heartbeat write. The bridge
// deliberately stops polling (and stops writing heartbeats) during its 409
// conflict backoff — up to 5 x 65s ≈ 5.4 minutes of legitimate, self-healing
// silence — so 10 minutes comfortably clears that whole window before
// declaring a wedge.
const WEDGE_THRESHOLD_MS = 10 * 60_000;

// Drain-stall threshold: a single turn in flight for >30 minutes means the
// FIFO is starved behind it — worth a normal (not urgent) ping.
const DRAIN_STALL_THRESHOLD_MS = 30 * 60_000;

// Escalation buckets for a stalled drain, in minutes. Part of the dedup state
// so a deepening stall re-pings instead of being collapsed into the first
// alert. Open-ended at the top: a stall past 8h keeps the same bucket rather
// than pinging forever.
const STALL_BUCKETS_MIN = [30, 60, 120, 240, 480];
function stallBucket(elapsedMs: number): number {
  const min = elapsedMs / 60_000;
  let bucket = STALL_BUCKETS_MIN[0];
  for (const b of STALL_BUCKETS_MIN) {
    if (min >= b) bucket = b;
  }
  return bucket;
}

// Deadline on the missing-heartbeat grace. The grace exists ONLY for the
// deploy-ordering window (the sweep can pick up heartbeat-aware code a
// restart cycle before the long-lived bridge does); U4 deploys within hours,
// so 48h of launchctl-alive with no heartbeat file ever appearing means
// wedge detection is silently dead (unwritable path, wrong HOME, ...) and
// Gary gets ONE normal-severity ping about it instead of silence forever.
const HEARTBEAT_MISSING_GRACE_MS = 48 * 60 * 60 * 1000;

interface BridgeHeartbeat {
  schema_version: number;
  last_poll_at: string;
  queue_depth: number;
  turn_in_flight_since: string | null;
}

// Bridge-liveness detection is layered: launchd-level death (launchctl says
// not running) is urgent bridge-down; a wedged-alive bridge (process running
// but the poll loop silent — heartbeat last_poll_at stale) is ALSO urgent
// bridge-down; a stalled drain (poll loop fine, one turn in flight >30min)
// is a separate, normal-severity bridge:drain-stall event. Log mtime is
// message detail only: a healthy idle bridge writes almost nothing, so log
// staleness would false-positive constantly if used as a trigger.
async function checkBridgeLiveness(d: SweepDeps, cfg: ProactiveConfig, pushDeps: Partial<PushDeps>): Promise<void> {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const result = await d.execFn("launchctl", ["print", `gui/${uid}/com.rachel.telegram-bridge`]);
  const down = result.exitCode !== 0 || !result.stdout.includes("state = running");
  if (down) {
    // The mtime is decoration on the one alert that matters — a stat failure
    // (EACCES, EIO) must never kill the urgent ping, so it degrades to
    // "unknown" instead of throwing into the family catch.
    let mtime: Date | undefined;
    try {
      mtime = d.statMtimeFn(join(d.repoDir, ".rachel", "telegram-bridge.log"));
    } catch {
      mtime = undefined;
    }
    const age = mtime === undefined ? "unknown" : `${Math.max(0, Math.floor((d.now().getTime() - mtime.getTime()) / 60_000))}m ago`;
    // When the launchctl call itself failed, name its stderr in the ping so
    // Gary can tell infra failure from real bridge death from the text alone.
    const infra = result.exitCode !== 0 && result.stderr.trim() !== "" ? ` launchctl: ${result.stderr.trim()}` : "";
    await d.pushFn("bridge-liveness", "bridge:liveness", "down", "urgent", `[urgent · bridge] Bridge down. Last log ${age}.${infra}`, pushDeps);
    return;
  }

  // Process is alive per launchd — check the heartbeat for a wedged poll
  // loop and a stalled drain. A missing heartbeat file with a running
  // process is treated as UNKNOWN, never as a wedge: it means a pre-U2b
  // bridge that has not been restarted onto heartbeat-writing code yet
  // (deploy ordering safety — the sweep can pick up merged code a full
  // restart cycle before the long-lived bridge process does).
  const now = d.now().getTime();
  const heartbeatPath = join(d.homeDir, ".rachel", "bridge-heartbeat.json");
  const raw = d.readFileFn(heartbeatPath);
  let heartbeat: BridgeHeartbeat | undefined;
  if (raw === undefined) {
    d.log("[sweep] bridge-liveness: no heartbeat file (pre-U2b bridge not yet restarted?) — wedge check skipped");
    await checkHeartbeatNeverObserved(d, cfg, pushDeps, now);
  } else {
    clearHeartbeatMissingSince(d, cfg);
    try {
      heartbeat = JSON.parse(raw) as BridgeHeartbeat;
    } catch {
      // Corrupt is unknown, not wedged — a half-written or damaged file must
      // not fire an urgent alarm on a healthy bridge.
      d.log(`[sweep] bridge-liveness: corrupt heartbeat at ${heartbeatPath} — wedge check skipped`);
    }
  }

  let wedged = false;
  if (heartbeat !== undefined) {
    const lastPollMs = Date.parse(String(heartbeat.last_poll_at));
    if (Number.isNaN(lastPollMs)) {
      d.log(`[sweep] bridge-liveness: unparseable last_poll_at in heartbeat — wedge check skipped`);
    } else if (now - lastPollMs > WEDGE_THRESHOLD_MS) {
      wedged = true;
      const staleMin = Math.floor((now - lastPollMs) / 60_000);
      await d.pushFn(
        "bridge-liveness",
        "bridge:liveness",
        "down",
        "urgent",
        `[urgent · bridge] Bridge wedged — launchd reports running but last poll ${staleMin}m ago.`,
        pushDeps,
      );
    }

    // Drain-stall is its own event (bridge:drain-stall), checked
    // independently of the wedge — both can be true at once and neither's
    // dedup may suppress the other. State pairs turn_in_flight_since with the
    // stall's escalation bucket: keying on the timestamp alone would freeze the
    // state for the entire stall, so a turn wedged forever pings exactly once
    // and then goes silent — the worst case reporting the least. Bucketing by
    // duration re-arms the ping as the stall deepens, while still collapsing
    // repeat sweeps within a bucket.
    if (typeof heartbeat.turn_in_flight_since === "string") {
      const sinceMs = Date.parse(heartbeat.turn_in_flight_since);
      if (!Number.isNaN(sinceMs) && now - sinceMs > DRAIN_STALL_THRESHOLD_MS) {
        const stallMin = Math.floor((now - sinceMs) / 60_000);
        const depth = typeof heartbeat.queue_depth === "number" ? heartbeat.queue_depth : 0;
        const bucket = stallBucket(now - sinceMs);
        await d.pushFn(
          "bridge-liveness",
          "bridge:drain-stall",
          `${heartbeat.turn_in_flight_since}:${bucket}`,
          "normal",
          `[bridge] turn running ${stallMin}m, queue depth ${depth}`,
          pushDeps,
        );
      }
    }
  }

  // A first-ever observation of a healthy bridge pushes nothing — recovery
  // is only announced after a recorded "down". A wedged bridge is down-class,
  // so it never announces recovery in the same tick.
  if (!wedged && d.getStateFn("bridge-liveness", "bridge:liveness", pushDeps) === "down") {
    await d.pushFn("bridge-liveness", "bridge:liveness", "up", "normal", "[bridge] Bridge recovered.", pushDeps);
  }
}

function sweepStatePath(d: SweepDeps): string {
  return join(d.homeDir, ".rachel", "proactive-sweep-state.json");
}

// Missing-heartbeat bookkeeping: record first-observed-missing in the sweep
// state file; past the 48h grace push ONE normal-severity alert. The
// chokepoint dedup keys on the first-observed date, so a heartbeat that
// appears (clearing the tracking) and later goes missing again re-arms with
// a fresh date instead of deduping forever.
async function checkHeartbeatNeverObserved(
  d: SweepDeps,
  cfg: ProactiveConfig,
  pushDeps: Partial<PushDeps>,
  now: number,
): Promise<void> {
  const statePath = sweepStatePath(d);
  const today = zonedDateString(d.now(), cfg.timezone);
  const state = readSweepState(d, statePath, today);
  if (state.heartbeat_missing_since === undefined) {
    d.writeFileFn(statePath, JSON.stringify({ ...state, heartbeat_missing_since: now } satisfies SweepState, null, 2));
    return;
  }
  if (now - state.heartbeat_missing_since > HEARTBEAT_MISSING_GRACE_MS) {
    await d.pushFn(
      "bridge-liveness",
      "bridge:heartbeat-missing",
      new Date(state.heartbeat_missing_since).toISOString(),
      "normal",
      "[bridge] heartbeat never observed — wedge detection inactive",
      pushDeps,
    );
  }
}

function clearHeartbeatMissingSince(d: SweepDeps, cfg: ProactiveConfig): void {
  const statePath = sweepStatePath(d);
  const today = zonedDateString(d.now(), cfg.timezone);
  const state = readSweepState(d, statePath, today);
  if (state.heartbeat_missing_since === undefined) {
    return;
  }
  const { heartbeat_missing_since: _cleared, ...rest } = state;
  d.writeFileFn(statePath, JSON.stringify(rest satisfies SweepState, null, 2));
}

// PR-red: pushes only on red (recovery is not pinged; the stale entry ages
// out via the store's 14-day eviction). A new head SHA while still red
// changes the state string, so a fresh push to the branch re-arms the ping.
//
// Isolation is layered: each REPO and each PR runs in its own try/catch with
// continue — one renamed/archived repo or one malformed checks payload can
// never blind the rest of the watch list.
async function checkPrRed(d: SweepDeps, cfg: ProactiveConfig, pushDeps: Partial<PushDeps>): Promise<void> {
  for (const repo of cfg.pr_watch_repos) {
    try {
      const list = await d.execFn("gh", ["pr", "list", "--repo", repo, "--author", "@me", "--state", "open", "--json", "number,headRefOid"]);
      if (list.exitCode !== 0) {
        throw new Error(`gh pr list exited ${list.exitCode}: ${list.stderr.trim()}`);
      }
      const prs = JSON.parse(list.stdout) as Array<{ number: number; headRefOid: string }>;
      for (const pr of prs) {
        try {
          // gh pr checks exits non-zero when checks fail — that exit code is
          // DATA on this call, never treated as an exec error. But non-zero
          // exit WITH empty stdout means no checks / gh failure (live-verified
          // on checkless repos: exit 1, nothing on stdout) — skip this PR,
          // never abort the family.
          const checks = await d.execFn("gh", ["pr", "checks", String(pr.number), "--repo", repo, "--json", "name,bucket,state"]);
          if (checks.exitCode !== 0 && checks.stdout.trim() === "") {
            d.log(`[sweep] pr-red no checks / gh failure for ${repo}#${pr.number} (exit ${checks.exitCode}): ${checks.stderr.trim()}`);
            continue;
          }
          // Red iff any check lands in gh's "fail" bucket — this covers
          // FAILURE, TIMED_OUT, STARTUP_FAILURE etc., which a state-string
          // comparison against "FAILURE" alone would miss.
          const parsed = JSON.parse(checks.stdout) as Array<{ name: string; bucket: string; state: string }>;
          if (parsed.some((check) => check.bucket === "fail")) {
            await d.pushFn(
              "pr-red",
              `pr:${repo}#${pr.number}`,
              `${pr.headRefOid}:failure`,
              "normal",
              `[pr] ${repo} #${pr.number} checks failing (${pr.headRefOid.slice(0, 7)})`,
              pushDeps,
            );
          }
        } catch (err) {
          d.log(`[sweep] pr-red error for ${repo}#${pr.number}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      d.log(`[sweep] pr-red error for ${repo}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

interface SweepState {
  schema_version: 1;
  date: string; // Dublin date, YYYY-MM-DD
  oneshot_hours_run: number[];
  // Consecutive-failure count per family — the self-alert escalation
  // counter. Unlike oneshot_hours_run it survives the Dublin date rollover:
  // "3 consecutive failures" means consecutive ticks, not consecutive ticks
  // within one calendar day.
  failure_streaks?: Record<string, number>;
  // First tick (ms epoch) that saw launchctl-alive with NO heartbeat file —
  // the missing-heartbeat grace tracking. Survives the date rollover.
  heartbeat_missing_since?: number;
  // Calendar producer-silence tracking: consecutive ticks whose cache was
  // missing or stale-beyond-26h, plus the first tick (ms epoch) of the
  // current silence episode. Deliberately NOT in failure_streaks — the
  // self-alert escalation loop iterates every failure_streaks key and would
  // fire a spurious urgent direct send for this normal-severity condition.
  // Both survive the date rollover (consecutive ticks, not per-day).
  calendar_producer_streak?: number;
  calendar_producer_silent_since?: number;
  // Whether the current streak's escalation has been DELIVERED (a failed
  // send stays false and is retried next tick). Cleared on family success.
  escalation_sent?: Record<string, boolean>;
  // bridge-stale thrash cap: how many restart attempts have been spent on the
  // CURRENT target commit, and which commit that is. Keyed on the SHA so a
  // newer relevant commit re-arms the budget, while repeated failure against
  // one unchanging target stops after STALE_RESTART_ATTEMPT_CAP. Survives the
  // date rollover — a crash-looping remediator is worse than a stale bridge.
  stale_restart_sha?: string;
  stale_restart_attempts?: number;
  // Whether the capped-out failure alert for the current target has been
  // pushed, so the operator is told once rather than every 30 minutes.
  stale_restart_alerted?: boolean;
}

// Sweep-owned state, deliberately OUTSIDE the push store dir — that dir is
// push.ts-only by invariant.
function readSweepState(d: SweepDeps, statePath: string, today: string): SweepState {
  const fresh: SweepState = { schema_version: 1, date: today, oneshot_hours_run: [], failure_streaks: {} };
  const raw = d.readFileFn(statePath);
  if (raw === undefined) {
    return fresh;
  }
  try {
    const parsed = JSON.parse(raw) as SweepState;
    if (parsed.schema_version !== 1 || !Array.isArray(parsed.oneshot_hours_run)) {
      d.log(`[sweep] corrupt sweep state at ${statePath} (unrecognised shape) — resetting`);
      return fresh;
    }
    // A date rollover (Dublin midnight) resets the hours-run list but keeps
    // the failure streaks, escalation flags, and heartbeat-grace tracking
    // running.
    return parsed.date === today
      ? parsed
      : {
          ...fresh,
          failure_streaks: parsed.failure_streaks ?? {},
          escalation_sent: parsed.escalation_sent ?? {},
          heartbeat_missing_since: parsed.heartbeat_missing_since,
          calendar_producer_streak: parsed.calendar_producer_streak,
          calendar_producer_silent_since: parsed.calendar_producer_silent_since,
          stale_restart_sha: parsed.stale_restart_sha,
          stale_restart_attempts: parsed.stale_restart_attempts,
          stale_restart_alerted: parsed.stale_restart_alerted,
        };
  } catch {
    d.log(`[sweep] corrupt sweep state at ${statePath} (invalid JSON) — resetting`);
    return fresh;
  }
}

// --- Calendar <2h escalation: deterministic consumer of the one-shot's cache ---

// The LLM one-shot (tasks/proactive-calendar.md) writes this cache and pushes
// each conflict at severity NORMAL under event-id cal:<idA>+<idB>. This
// deterministic block re-reads the cache every tick and escalates any
// conflict starting within 2h to URGENT.
//
// Red-team rationale for the :2h event-id suffix: the escalation carries its
// OWN event-id (cal:<idA>+<idB>:2h) so it dedups INDEPENDENTLY of the
// one-shot's normal ping — if it shared the one-shot's id, the normal ping's
// recorded state would swallow the urgent escalation (or vice versa) and
// Gary would never get the <2h heads-up. And because the state is hash16
// over the four start/end timestamps, a reschedule changes the hash and
// re-arms BOTH pings — a moved conflict is news again, on both channels.
interface CalendarCacheConflict {
  idA: string;
  idB: string;
  startA: string;
  endA: string;
  startB: string;
  endB: string;
  title_hint?: string;
}

interface CalendarCache {
  schema_version: number;
  fetched_at: string;
  conflicts: CalendarCacheConflict[];
}

// A cache older than 26h is treated as absent: the one-shot refreshes it 4x
// a day, so >26h means the producer is dead and the data is yesterday's —
// escalating on it would page Gary about meetings that may have moved.
const CACHE_STALE_MS = 26 * 60 * 60 * 1000;
const ESCALATION_WINDOW_MS = 2 * 60 * 60 * 1000;

// hash16 recipe — pinned identically in tasks/proactive-calendar.md (the
// task file's shell line: printf '%s' "<startA>|<endA>|<startB>|<endB>" |
// shasum -a 256 | cut -c1-16). Run-to-run stability is what dedup rests on.
function hash16(c: CalendarCacheConflict): string {
  return createHash("sha256").update(`${c.startA}|${c.endA}|${c.startB}|${c.endB}`, "utf8").digest("hex").slice(0, 16);
}

function zonedHHMM(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
}

// Producer-silence detection: a dead one-shot producer (launchd job gone,
// Calendar MCP broken, bin/rachel failing) otherwise degrades to an
// eternally-skipped stale/missing cache with every tick "ok" — positive
// silence. Consecutive silent ticks are counted in the sweep state; from the
// 3rd, one normal alert goes through the chokepoint. State is the episode's
// first-observed timestamp: constant while the silence persists (dedup holds)
// and fresh when a recovered producer later dies again (re-arms).
const PRODUCER_SILENCE_THRESHOLD = 3;

async function noteProducerSilence(d: SweepDeps, cfg: ProactiveConfig, pushDeps: Partial<PushDeps>): Promise<void> {
  const statePath = sweepStatePath(d);
  const today = zonedDateString(d.now(), cfg.timezone);
  const state = readSweepState(d, statePath, today);
  const nowMs = d.now().getTime();
  const since = state.calendar_producer_silent_since ?? nowMs;
  const streak = (Number(state.calendar_producer_streak) || 0) + 1;
  d.writeFileFn(
    statePath,
    JSON.stringify(
      { ...state, date: today, calendar_producer_streak: streak, calendar_producer_silent_since: since } satisfies SweepState,
      null,
      2,
    ),
  );
  if (streak >= PRODUCER_SILENCE_THRESHOLD) {
    const hours = Math.floor((nowMs - since) / 3_600_000);
    await d.pushFn(
      "calendar",
      "cal:producer-silent",
      new Date(since).toISOString(),
      "normal",
      `[cal] calendar producer silent — cache stale/missing for ${hours}h`,
      pushDeps,
    );
  }
}

function clearProducerSilence(d: SweepDeps, cfg: ProactiveConfig): void {
  const statePath = sweepStatePath(d);
  const today = zonedDateString(d.now(), cfg.timezone);
  const state = readSweepState(d, statePath, today);
  if (state.calendar_producer_streak === undefined && state.calendar_producer_silent_since === undefined) {
    return;
  }
  const { calendar_producer_streak: _streak, calendar_producer_silent_since: _since, ...rest } = state;
  d.writeFileFn(statePath, JSON.stringify(rest satisfies SweepState, null, 2));
}

async function checkCalendarEscalation(d: SweepDeps, cfg: ProactiveConfig, pushDeps: Partial<PushDeps>): Promise<void> {
  const cachePath = join(d.homeDir, ".rachel", "calendar-cache.json");
  const raw = d.readFileFn(cachePath);
  if (raw === undefined) {
    d.log("[sweep] calendar-escalation: no cache — skipped");
    await noteProducerSilence(d, cfg, pushDeps);
    return;
  }
  let cache: CalendarCache;
  try {
    cache = JSON.parse(raw) as CalendarCache;
  } catch {
    d.log(`[sweep] calendar-escalation: corrupt cache at ${cachePath} — skipped`);
    return;
  }
  if (cache?.schema_version !== 1 || !Array.isArray(cache.conflicts)) {
    d.log(`[sweep] calendar-escalation: corrupt cache at ${cachePath} (unrecognised shape) — skipped`);
    return;
  }
  const nowMs = d.now().getTime();
  const fetchedMs = Date.parse(String(cache.fetched_at));
  if (Number.isNaN(fetchedMs)) {
    d.log(`[sweep] calendar-escalation: unparseable fetched_at (${String(cache.fetched_at)}) — skipped`);
    await noteProducerSilence(d, cfg, pushDeps);
    return;
  }
  if (nowMs - fetchedMs > CACHE_STALE_MS) {
    d.log(`[sweep] calendar-escalation: stale cache (fetched_at ${String(cache.fetched_at)}) — skipped`);
    await noteProducerSilence(d, cfg, pushDeps);
    return;
  }
  clearProducerSilence(d, cfg);
  for (const entry of cache.conflicts) {
    // Defensive re-sort: the producer contract says idA < idB, but the
    // sweep's own event-id/hash must be run-to-run stable even against a
    // one-shot that mis-sorted once — so sort here regardless.
    const c: CalendarCacheConflict =
      String(entry.idA) <= String(entry.idB)
        ? entry
        : { ...entry, idA: entry.idB, idB: entry.idA, startA: entry.startB, endA: entry.endB, startB: entry.startA, endB: entry.endA };
    const startAMs = Date.parse(String(c.startA));
    const startBMs = Date.parse(String(c.startB));
    if (Number.isNaN(startAMs) || Number.isNaN(startBMs)) {
      d.log(`[sweep] calendar-escalation: unparseable conflict times for ${String(c.idA)}+${String(c.idB)} — entry skipped`);
      continue;
    }
    const earlierMs = Math.min(startAMs, startBMs);
    // Window is (now, now + 2h]: a conflict already underway is not a
    // heads-up any more, and one >2h out is the one-shot's normal ping.
    if (!(earlierMs > nowMs && earlierMs - nowMs <= ESCALATION_WINDOW_MS)) {
      continue;
    }
    const minutes = Math.round((earlierMs - nowMs) / 60_000);
    const title = typeof c.title_hint === "string" && c.title_hint !== "" ? c.title_hint : `${c.idA}+${c.idB}`;
    await d.pushFn(
      "calendar",
      `cal:${c.idA}+${c.idB}:2h`,
      hash16(c),
      "urgent",
      `[urgent · cal] Conflict: ${title} — ${zonedHHMM(startAMs, cfg.timezone)} overlaps ${zonedHHMM(startBMs, cfg.timezone)}, starts in ${minutes}m`,
      pushDeps,
    );
  }
}

// --- bridge-stale: the auto-remediating stale-process family (RCA item 11) ---
//
// The launchd bridge runs whatever code it booted with; a merge to main does
// not restart it. On 2026-07-23 the mechanism-B fix sat merged-but-dead for
// six hours — the second occurrence of "merged is not deployed". This family
// closes that loop WITHOUT asking: per Gary's explicit instruction it must
// "fix it — restart the bridge (bootout -> poll-until-gone -> bootstrap) —
// then tell him it was done". So the push is an after-the-fact FYI naming the
// SHA, emitted only once the bootstrap has succeeded. Never a request.
//
// Comparison is against the WORKING TREE's HEAD, not origin/main. A restart
// reloads whatever is checked out on disk — it does not pull. Comparing
// against a remote ref the local checkout is behind would restart into the
// same old code, staleness would never clear, and the remediator would burn
// its whole attempt budget every time. HEAD is exactly the code a restart
// loads, which makes the trigger self-clearing.
//
// Relevance is the three paths whose code the bridge process actually holds
// in memory: rachel.ts (the turn loop), bridge/ (the transport), prompts/
// (the system prompt, composed per turn but read from the process's repo).
// A docs-only or unrelated merge must never cost Gary a restart.
const STALE_WATCH_PATHS = ["rachel.ts", "bridge/", "prompts/"];

// Restart attempts spent on one unchanging target commit before the family
// gives up and alerts instead. The 30-minute tick spacing is the backoff.
const STALE_RESTART_ATTEMPT_CAP = 3;

// Bound on the post-bootout teardown poll. launchctl bootout is ASYNCHRONOUS:
// it returns while the old job may still be draining (the bridge sits in a
// 30s Telegram long-poll, and an immediate bootstrap fails with exit 5
// "Input/output error"). scripts/install.sh learned this on the first real
// deploy and polls `print` until the label is genuinely absent; this family
// does the same, bounded so a job that never dies cannot wedge the tick.
const TEARDOWN_POLL_INTERVAL_MS = 500;
const TEARDOWN_POLL_BUDGET_MS = 30_000;

// A turn_in_flight_since younger than this is treated as a LIVE turn and the
// restart is deferred to the next tick. Matches the bridge's own 10-minute
// turn ceiling plus slack: past that the bridge has already aborted the turn,
// so the timestamp is stale bookkeeping rather than work we would kill.
const TURN_IN_FLIGHT_WINDOW_MS = 11 * 60_000;

// Parses `ps -o etime=` output: [[dd-]hh:]mm:ss. Deliberately NOT lstart —
// on macOS that renders in the local (Irish) locale as "Thu 23 Jul 22:56:31
// 2026", which has broken date parsing in this project before. etime is
// locale-free. (`etimes` is Linux procps only and does not exist on macOS.)
export function parseEtimeMs(etime: string): number | undefined {
  const trimmed = etime.trim();
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (match === null) {
    return undefined;
  }
  const [, dd, hh, mm, ss] = match;
  return ((Number(dd ?? 0) * 24 + Number(hh ?? 0)) * 60 + Number(mm)) * 60_000 + Number(ss) * 1000;
}

function bridgeLabelDomain(): { uid: number; label: string; target: string } {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const label = "com.rachel.telegram-bridge";
  return { uid, label, target: `gui/${uid}/${label}` };
}

// Positive evidence only. A missing, corrupt or unparseable heartbeat is NOT
// treated as a turn in flight: skipping on unknown would permanently disable
// remediation on exactly the bridge most likely to be stale (an old one whose
// heartbeat format predates the reader).
function turnInFlight(d: SweepDeps, nowMs: number): boolean {
  const raw = d.readFileFn(join(d.homeDir, ".rachel", "bridge-heartbeat.json"));
  if (raw === undefined) {
    return false;
  }
  try {
    const heartbeat = JSON.parse(raw) as BridgeHeartbeat;
    if (typeof heartbeat.turn_in_flight_since !== "string") {
      return false;
    }
    const sinceMs = Date.parse(heartbeat.turn_in_flight_since);
    return !Number.isNaN(sinceMs) && nowMs - sinceMs < TURN_IN_FLIGHT_WINDOW_MS;
  } catch {
    return false;
  }
}

// bootout -> poll until genuinely absent -> bootstrap. Returns an error
// string on failure, undefined on success. Never throws: every failure is
// data the caller folds into the attempt counter.
async function restartBridge(d: SweepDeps): Promise<string | undefined> {
  const { uid, label, target } = bridgeLabelDomain();
  const bootout = await d.execFn("launchctl", ["bootout", target]);
  // Exit 3 = "no such process" — already gone, nothing to tear down.
  if (bootout.exitCode !== 0 && bootout.exitCode !== 3) {
    return `bootout exited ${bootout.exitCode}: ${bootout.stderr.trim()}`;
  }
  if (bootout.exitCode === 0) {
    const deadline = d.now().getTime() + TEARDOWN_POLL_BUDGET_MS;
    let gone = false;
    while (d.now().getTime() < deadline) {
      const probe = await d.execFn("launchctl", ["print", target]);
      if (probe.exitCode !== 0) {
        gone = true;
        break;
      }
      await d.sleepFn(TEARDOWN_POLL_INTERVAL_MS);
    }
    // Bootstrapping on top of a still-draining job is what produces a
    // half-loaded service, so a job that never goes away is left alone
    // entirely rather than bootstrapped over.
    if (!gone) {
      return `service still draining after ${TEARDOWN_POLL_BUDGET_MS / 1000}s teardown wait`;
    }
  }
  const plist = join(d.homeDir, "Library", "LaunchAgents", `${label}.plist`);
  let bootstrap = await d.execFn("launchctl", ["bootstrap", `gui/${uid}`, plist]);
  if (bootstrap.exitCode === 5) {
    // Exit 5 right after a clean teardown-wait: launchd occasionally needs a
    // beat longer. One bounded retry, exactly as scripts/install.sh does.
    await d.sleepFn(2000);
    bootstrap = await d.execFn("launchctl", ["bootstrap", `gui/${uid}`, plist]);
  }
  if (bootstrap.exitCode !== 0) {
    return `bootstrap exited ${bootstrap.exitCode}: ${bootstrap.stderr.trim()}`;
  }
  return undefined;
}

async function checkBridgeStale(d: SweepDeps, cfg: ProactiveConfig, pushDeps: Partial<PushDeps>): Promise<void> {
  const { target } = bridgeLabelDomain();
  const print = await d.execFn("launchctl", ["print", target]);
  // A bridge launchd reports as down is bridge-liveness's business — that
  // family already pushes an urgent bridge-down. Restarting a job that is not
  // running is not "remediating staleness", so this family only ever acts on
  // a running-but-stale bridge.
  if (print.exitCode !== 0 || !print.stdout.includes("state = running")) {
    d.log("[sweep] bridge-stale: bridge not running — left to bridge-liveness");
    return;
  }
  const pid = /^\s*pid = (\d+)$/m.exec(print.stdout)?.[1];
  if (pid === undefined) {
    d.log("[sweep] bridge-stale: no pid in launchctl print output — skipped");
    return;
  }

  // Newest commit touching the watched paths, on the checked-out HEAD.
  const log = await d.execFn("git", ["-C", d.repoDir, "log", "-1", "--format=%cI\t%h", "HEAD", "--", ...STALE_WATCH_PATHS]);
  if (log.exitCode !== 0) {
    d.log(`[sweep] bridge-stale: git log exited ${log.exitCode}: ${log.stderr.trim()} — skipped`);
    return;
  }
  const [commitISO, commitSha] = log.stdout.trim().split("\t");
  if (!commitISO || !commitSha) {
    // No commit has ever touched the watched paths — nothing to be stale
    // against. A docs-only history lands here, and so does an empty repo.
    d.log("[sweep] bridge-stale: no commit touching the watched paths — nothing to compare");
    return;
  }
  const commitMs = Date.parse(commitISO);
  if (Number.isNaN(commitMs)) {
    d.log(`[sweep] bridge-stale: unparseable commit date ${commitISO} — skipped`);
    return;
  }

  const ps = await d.execFn("ps", ["-o", "etime=", "-p", pid]);
  const elapsedMs = ps.exitCode === 0 ? parseEtimeMs(ps.stdout) : undefined;
  if (elapsedMs === undefined) {
    // An unreadable start time is never grounds for a restart — the whole
    // point is to act only on proven staleness.
    d.log(`[sweep] bridge-stale: unreadable etime for pid ${pid} (exit ${ps.exitCode}, ${JSON.stringify(ps.stdout.trim())}) — skipped`);
    return;
  }
  const nowMs = d.now().getTime();
  const startMs = nowMs - elapsedMs;
  if (startMs >= commitMs) {
    return;
  }

  // Stale. Before touching a live service, check nothing is in flight.
  if (turnInFlight(d, nowMs)) {
    d.log(`[sweep] bridge-stale: stale against ${commitSha} but a turn is mid-turn — deferring restart to the next tick`);
    return;
  }

  // Thrash cap, keyed on the target SHA so a newer commit re-arms the budget.
  const statePath = sweepStatePath(d);
  const today = zonedDateString(d.now(), cfg.timezone);
  const state = readSweepState(d, statePath, today);
  const sameTarget = state.stale_restart_sha === commitSha;
  const attempts = sameTarget ? Number(state.stale_restart_attempts) || 0 : 0;
  if (attempts >= STALE_RESTART_ATTEMPT_CAP) {
    if (state.stale_restart_alerted !== true) {
      await d.pushFn(
        "bridge-stale",
        "bridge:stale-restart",
        `${commitSha}:failed`,
        "normal",
        `[bridge] Bridge is running code older than ${commitSha} and ${STALE_RESTART_ATTEMPT_CAP} auto-restart attempts failed. Not retrying — needs a look.`,
        pushDeps,
      );
      d.writeFileFn(statePath, JSON.stringify({ ...state, date: today, stale_restart_alerted: true } satisfies SweepState, null, 2));
    }
    return;
  }

  // The attempt is BANKED BEFORE it is made: a restart that hangs or crashes
  // the tick still burns its budget, so a crash-looping remediator cannot
  // bootout the bridge every 30 minutes forever.
  d.writeFileFn(
    statePath,
    JSON.stringify(
      { ...state, date: today, stale_restart_sha: commitSha, stale_restart_attempts: attempts + 1, stale_restart_alerted: false } satisfies SweepState,
      null,
      2,
    ),
  );

  const startedAgo = Math.floor(elapsedMs / 60_000);
  const failure = await restartBridge(d);
  if (failure !== undefined) {
    d.log(`[sweep] bridge-stale: restart attempt ${attempts + 1}/${STALE_RESTART_ATTEMPT_CAP} onto ${commitSha} failed: ${failure}`);
    return;
  }

  // Act-then-FYI. Dedup state is the SHA restarted onto, which does double
  // duty: it names the SHA in the message (Gary's requirement) and guarantees
  // a genuine second restart, onto a different commit, is never silently
  // deduped away — while a repeat push for the same SHA correctly collapses.
  d.log(`[sweep] bridge-stale: restarted bridge onto ${commitSha} (was ${startedAgo}m old)`);
  await d.pushFn(
    "bridge-stale",
    "bridge:stale-restart",
    commitSha,
    "normal",
    `[bridge] Restarted the bridge onto ${commitSha}. It had been running for ${startedAgo}m on code older than that commit. Already done — no action needed.`,
    pushDeps,
  );
}

// --- Memory store lint: periodic detection of prompts/system.md's Memory
// contract (proactive/memoryLint.ts owns the checks; this just wires the
// sweep to it). Dedup key is a hash of the violation SET ({file, code,
// level} per finding, sorted so ordering never matters and message text
// never leaks into the hash) — a persistent unchanged violation collapses to
// one push per state via the chokepoint's own dedup (pushFn is still called
// every tick; push.ts is what recognises the unchanged state and no-ops),
// while a NEW or resolved finding changes the hash and re-arms it. A clean
// store pushes nothing, same shape as pr-red on green.
function memoryLintStateHash(findings: Finding[]): string {
  const sorted = findings
    .map((f) => `${f.file}|${f.code}|${f.level}`)
    .sort();
  return createHash("sha256").update(sorted.join("\n"), "utf8").digest("hex").slice(0, 16);
}

async function checkMemoryLint(d: SweepDeps, pushDeps: Partial<PushDeps>): Promise<void> {
  const memoryDir = dirname(resolveMemoryPath());
  const findings = d.lintFn(memoryDir);
  if (findings.length === 0) {
    return;
  }
  const errorCount = findings.filter((f) => f.level === "error").length;
  const warningCount = findings.filter((f) => f.level === "warning").length;
  const summary = [errorCount > 0 ? `${errorCount} error${errorCount === 1 ? "" : "s"}` : "", warningCount > 0 ? `${warningCount} warning${warningCount === 1 ? "" : "s"}` : ""]
    .filter(Boolean)
    .join(", ");
  const sample = findings
    .slice(0, 5)
    .map((f) => `${f.file}: ${f.code}`)
    .join("; ");
  await d.pushFn(
    "memory-lint",
    "memory:lint",
    memoryLintStateHash(findings),
    "normal",
    `[memory] store-lint found ${summary} — ${sample}`,
    pushDeps,
  );
}

// --- tmp sweep (RCA 2026-07-23 item 16) ---
//
// ~/.rachel/tmp accumulates voice artifacts and downloaded images. The
// bridge's own per-turn cleanup is CORRECT and is deliberately untouched
// here; the debris comes from direct test invocations of the speech scripts
// and from processes killed mid-synthesis, between writing the .wav and
// reaching their cleanup finally-block. Neither can be fixed at the bridge,
// so a periodic sweep is the robust answer.
//
// Age threshold: 1 hour. The longest a tmp file can legitimately still be in
// use is bounded by the bridge's 10-minute turn deadline
// (DEFAULT_TURN_TIMEOUT_MS) — a downloaded image is read across a turn, and
// synthesis (a 300s cap at most) is strictly inside one turn. 1h is 6x that
// ceiling, so this can never race a live turn, while still keeping the
// directory from accumulating for days.
const TMP_MAX_AGE_MS = 60 * 60_000;

// Deliberately silent: routine hygiene must not consume the daily interrupt
// budget or ping Gary. Outcome goes to the launchd log only. Every delete is
// constrained to direct children of ~/.rachel/tmp that lstat as regular
// files — non-recursive, never a directory, never following a symlink out.
function sweepTmpDir(d: SweepDeps): void {
  const tmpDir = join(d.homeDir, ".rachel", "tmp");
  const entries = d.readDirFn(tmpDir);
  if (entries === undefined) {
    return;
  }
  const cutoff = d.now().getTime() - TMP_MAX_AGE_MS;
  let removed = 0;
  for (const name of entries) {
    const path = join(tmpDir, name);
    const st = d.lstatFn(path);
    // Skips directories AND symlinks in one check: lstat describes the entry
    // itself, so a symlink is never a regular file and is never followed.
    if (st === undefined || !st.isFile()) {
      continue;
    }
    if (st.mtime.getTime() >= cutoff) {
      continue;
    }
    try {
      d.unlinkFn(path);
      removed += 1;
    } catch (err) {
      // Best-effort: one unremovable file never aborts the sweep.
      d.log(`[sweep] tmp-sweep could not remove ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (removed > 0) {
    d.log(`[sweep] tmp-sweep removed ${removed} stale file${removed === 1 ? "" : "s"} from ${tmpDir}`);
  }
}

// Exported for the cross-check test pinning this as a subset of rachel.ts's
// DEFAULT_ALLOWED_TOOLS — a narrowing entry outside the default list would
// be silently dropped by resolveAllowedTools.
export const ONESHOT_TOOLS = "Read,Write,Bash,mcp__claude_ai_Google_Calendar__*";

// Calendar one-shot spawn cadence: each due configured hour (h <= current
// Dublin hour, not yet recorded today) collapses into ONE spawn — launchd
// coalesces missed intervals into a single wake-time catch-up run, and so do
// we. Hours are recorded as run when the spawn STARTS, so a hung or timed-out
// one-shot cannot re-spawn-storm on every subsequent tick.
//
// The spawn is raced in-process against oneshotTimeoutMs: even an execFn that
// never settles cannot wedge the tick. The real execFn additionally passes
// timeoutMs to execFile, which kills the child on expiry.
async function runCalendarOneshot(d: SweepDeps, cfg: ProactiveConfig): Promise<void> {
  const now = d.now();
  const today = zonedDateString(now, cfg.timezone);
  const currentHour = Math.floor(zonedMinutesOfDay(now, cfg.timezone) / 60);
  const statePath = join(d.homeDir, ".rachel", "proactive-sweep-state.json");
  const state = readSweepState(d, statePath, today);
  const due = cfg.calendar_oneshot_hours.filter((h) => h <= currentHour && !state.oneshot_hours_run.includes(h));
  if (due.length === 0) {
    return;
  }
  // State is written BEFORE the spawn starts: a failing write then means no
  // child was ever started (no orphaned 15-minute LLM run), while the
  // recorded hours still prevent a respawn storm on every subsequent tick
  // when the one-shot itself hangs or times out.
  d.writeFileFn(
    statePath,
    // Spread preserves failure_streaks — this write must never clobber the
    // escalation counters bookkept at the end of the tick.
    JSON.stringify({ ...state, date: today, oneshot_hours_run: [...state.oneshot_hours_run, ...due] } satisfies SweepState, null, 2),
  );
  const spawn = d.execFn(join(d.repoDir, "bin", "rachel"), ["Read tasks/proactive-calendar.md and follow it."], {
    env: { RACHEL_ALLOWED_TOOLS: ONESHOT_TOOLS },
    stdinNull: true,
    timeoutMs: d.oneshotTimeoutMs,
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), d.oneshotTimeoutMs);
  });
  const result = await Promise.race([spawn, timeout]);
  clearTimeout(timer);
  if (result === "timeout") {
    d.log("[sweep] calendar one-shot timeout");
  } else {
    d.log(`[sweep] calendar one-shot exit ${result.exitCode}`);
  }
}

// How many consecutive same-family failures before the sweep alerts about
// itself.
const ESCALATION_THRESHOLD = 3;

// Escalation delivery is a DIRECT send, deliberately NOT via push(): the
// failing family might BE the push path, and a broken chokepoint alerting
// through itself would never land. No config => throw => caught below.
async function defaultEscalationSend(text: string): Promise<void> {
  const config = loadTelegramConfig();
  if (!config) {
    throw new Error("no Telegram config (RACHEL_TELEGRAM_TOKEN/RACHEL_TELEGRAM_CHAT_ID or ~/.rachel/telegram.json) — cannot send escalation.");
  }
  await sendChunked(config, text);
}

// Self-alert escalation: bump/reset per-family consecutive-failure counters
// (persisted in the sweep state file), and from the 3rd consecutive failure
// of a family send one best-effort direct alert — retried on subsequent
// ticks until a send succeeds, then never repeated for the same unbroken
// streak (the escalation_sent flag persists the success; a family recovery
// clears both counter and flag). Recursion guard: a failing send is logged
// and never escalated about. Family results are never affected by this.
async function escalateSweepFailures(
  d: SweepDeps,
  cfg: ProactiveConfig,
  results: Record<string, FamilyResult>,
  errors: Record<string, string>,
): Promise<void> {
  const statePath = sweepStatePath(d);
  const today = zonedDateString(d.now(), cfg.timezone);
  const state = readSweepState(d, statePath, today);
  // Coerce persisted counters on read: valid-JSON corruption (a "2" string)
  // must not make the threshold comparison silently unreachable.
  const streaks: Record<string, number> = {};
  for (const [family, value] of Object.entries(state.failure_streaks ?? {})) {
    streaks[family] = Number(value) || 0;
  }
  const escalationSent: Record<string, boolean> = { ...(state.escalation_sent ?? {}) };
  for (const [family, result] of Object.entries(results)) {
    if (result === "failed") {
      streaks[family] = (streaks[family] ?? 0) + 1;
    } else {
      delete streaks[family];
      delete escalationSent[family];
    }
  }
  // Sends happen BEFORE the state write so a delivered escalation is what
  // gets persisted; a failed send stays unflagged and retries next tick.
  for (const [family, streak] of Object.entries(streaks)) {
    if (streak < ESCALATION_THRESHOLD || escalationSent[family] === true) continue;
    const text = `[urgent] proactive sweep itself failing: ${family}: ${errors[family] ?? "unknown error"}`;
    try {
      await (d.sendFn ?? defaultEscalationSend)(text);
      escalationSent[family] = true;
    } catch (err) {
      // Recursion guard: log only. Never re-escalate about the escalation.
      d.log(`[sweep] escalation send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    d.writeFileFn(
      statePath,
      JSON.stringify({ ...state, date: today, failure_streaks: streaks, escalation_sent: escalationSent } satisfies SweepState, null, 2),
    );
  } catch (err) {
    d.log(`[sweep] escalation state write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function sweepTick(overrides?: Partial<SweepDeps>): Promise<Record<string, FamilyResult>> {
  const d = resolveSweepDeps(overrides);
  const pushDeps = pushDepsOf(d);
  const cfg = loadConfig(d.baseDir);
  const errors: Record<string, string> = {};
  const results: Record<string, FamilyResult> = {
    flush: await runFamily("flush", d, errors, async () => {
      await d.flushFn(pushDeps);
    }),
    "bridge-liveness": await runFamily("bridge-liveness", d, errors, () => checkBridgeLiveness(d, cfg, pushDeps)),
    "pr-red": await runFamily("pr-red", d, errors, () => checkPrRed(d, cfg, pushDeps)),
    // Escalation reads the cache the one-shot below (eventually) writes; it
    // runs first and as its OWN family so a broken cache read can never
    // block the spawn, and vice versa.
    "calendar-escalation": await runFamily("calendar-escalation", d, errors, () => checkCalendarEscalation(d, cfg, pushDeps)),
    calendar: await runFamily("calendar", d, errors, () => runCalendarOneshot(d, cfg)),
    "memory-lint": await runFamily("memory-lint", d, errors, () => checkMemoryLint(d, pushDeps)),
    // Last: pure local hygiene, alerts nobody, and nothing else depends on it.
    "tmp-sweep": await runFamily("tmp-sweep", d, errors, async () => {
      sweepTmpDir(d);
    }),
  };
  try {
    await escalateSweepFailures(d, cfg, results, errors);
  } catch (err) {
    // A broken escalation bookkeeping path (state file unreadable, ...) must
    // not convert a partially-successful tick into a fatal rejection — the
    // family results still return and the CLI exits on their truth.
    d.log(`[sweep] escalation bookkeeping failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return results;
}

// Only run as a CLI when executed directly (tsx proactive/sweep.ts), not when
// imported by a test — same guard as push.ts/notify.ts/rachel.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const results = await sweepTick();
    // Any family failure exits 1 so the monitor's own death is machine-
    // visible in launchctl's last-exit-status instead of a green tick over
    // dead delivery. Self-alerting escalation (a direct best-effort ping on
    // the 3rd consecutive same-family failure) already ran inside sweepTick.
    process.exit(Object.values(results).some((r) => r === "failed") ? 1 : 0);
  } catch (err) {
    console.error(`[sweep] fatal: ${err instanceof Error ? (err.stack ?? String(err)) : String(err)}`);
    process.exit(1);
  }
}
