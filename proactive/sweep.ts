#!/usr/bin/env -S npx tsx
// Deterministic 30-minute proactive sweep tick (launchd: com.rachel.proactive-sweep).
// Consumes proactive/push.ts as a library — the sweep never touches the state
// store directly; every delivery decision (dedup, quiet, budget) lives in the
// chokepoint. Tick order is fixed: deferred flush FIRST, then bridge-liveness,
// then PR-red, then calendar. Each family runs in its own try/catch so one
// broken family never blocks the others and the tick still exits 0.
import { execFile } from "node:child_process";
import { readFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { push, flushDeferred, getEventState, loadConfig, zonedDateString, zonedMinutesOfDay } from "./push.ts";
import type { ProactiveConfig, PushDeps } from "./push.ts";

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

async function runFamily(family: string, d: SweepDeps, fn: () => Promise<void>): Promise<FamilyResult> {
  try {
    await fn();
    return "ok";
  } catch (err) {
    // Full stack — same convention as push.ts: launchd logs are the only
    // debugging signal.
    d.log(`[sweep] ${family} error: ${err instanceof Error ? (err.stack ?? String(err)) : String(err)}`);
    return "failed";
  }
}

// Bridge-liveness: launchctl state is the ONLY trigger. The detection
// boundary is launchd-level death — a wedged-alive bridge (long-poll loop
// healthy, replies dead) is NOT detected here; that gap is named in the
// design docs, not papered over. Log mtime is message detail only: a healthy
// idle bridge writes almost nothing, so mtime staleness would false-positive
// constantly if used as a trigger.
async function checkBridgeLiveness(d: SweepDeps, pushDeps: Partial<PushDeps>): Promise<void> {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const result = await d.execFn("launchctl", ["print", `gui/${uid}/com.rachel.telegram-bridge`]);
  const down = result.exitCode !== 0 || !result.stdout.includes("state = running");
  if (down) {
    const mtime = d.statMtimeFn(join(d.repoDir, ".rachel", "telegram-bridge.log"));
    const age = mtime === undefined ? "unknown" : `${Math.max(0, Math.floor((d.now().getTime() - mtime.getTime()) / 60_000))}m ago`;
    await d.pushFn("bridge-liveness", "bridge:liveness", "down", "urgent", `[urgent · bridge] Bridge down. Last log ${age}.`, pushDeps);
    return;
  }
  // A first-ever observation of a healthy bridge pushes nothing — recovery
  // is only announced after a recorded "down".
  if (d.getStateFn("bridge-liveness", "bridge:liveness", pushDeps) === "down") {
    await d.pushFn("bridge-liveness", "bridge:liveness", "up", "normal", "[bridge] Bridge recovered.", pushDeps);
  }
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
}

// Sweep-owned state, deliberately OUTSIDE the push store dir — that dir is
// push.ts-only by invariant.
function readSweepState(d: SweepDeps, statePath: string, today: string): SweepState {
  const fresh: SweepState = { schema_version: 1, date: today, oneshot_hours_run: [] };
  const raw = d.readFileFn(statePath);
  if (raw === undefined) {
    return fresh;
  }
  try {
    const parsed = JSON.parse(raw) as SweepState;
    if (parsed.schema_version !== 1 || !Array.isArray(parsed.oneshot_hours_run)) {
      return fresh;
    }
    // A date rollover (Dublin midnight) resets the hours-run list.
    return parsed.date === today ? parsed : fresh;
  } catch {
    return fresh;
  }
}

const ONESHOT_TOOLS = "Read,Write,Bash,mcp__claude_ai_Google_Calendar__*";

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
  const spawn = d.execFn(join(d.repoDir, "bin", "rachel"), ["Read tasks/proactive-calendar.md and follow it."], {
    env: { RACHEL_ALLOWED_TOOLS: ONESHOT_TOOLS },
    stdinNull: true,
    timeoutMs: d.oneshotTimeoutMs,
  });
  d.writeFileFn(
    statePath,
    JSON.stringify({ schema_version: 1, date: today, oneshot_hours_run: [...state.oneshot_hours_run, ...due] } satisfies SweepState, null, 2),
  );
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

export async function sweepTick(overrides?: Partial<SweepDeps>): Promise<void> {
  const d = resolveSweepDeps(overrides);
  const pushDeps = pushDepsOf(d);
  const cfg = loadConfig(d.baseDir);
  await runFamily("flush", d, async () => {
    await d.flushFn(pushDeps);
  });
  await runFamily("bridge-liveness", d, () => checkBridgeLiveness(d, pushDeps));
  await runFamily("pr-red", d, () => checkPrRed(d, cfg, pushDeps));
  await runFamily("calendar", d, () => runCalendarOneshot(d, cfg));
}

// Only run as a CLI when executed directly (tsx proactive/sweep.ts), not when
// imported by a test — same guard as push.ts/notify.ts/rachel.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await sweepTick();
    process.exit(0);
  } catch (err) {
    console.error(`[sweep] fatal: ${err instanceof Error ? (err.stack ?? String(err)) : String(err)}`);
    process.exit(1);
  }
}
