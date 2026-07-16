#!/usr/bin/env -S npx tsx

// Telegram front-end for Rachel — owns THE single getUpdates
// consumer for the configured bot token (Telegram allows exactly one).
// Routes ordinary chat messages into a FIFO turn queue dispatched through
// runTurn(), and routes callback_query taps (approve/deny) immediately into
// the Telegram approval surface's handleCallbackQuery — never queued behind
// pending chat turns, since a gate decision may be blocking a turn.

import { tg, sendChunked, sendTyping, setMyCommands, downloadFile, type ApiConfig } from "./api.ts";
import { push, type PushDeps, type Severity } from "../proactive/push.ts";
import { homedir } from "node:os";
import type { TelegramApprovalSurface, TelegramCallbackQuery } from "../gate/surfaces/telegram.ts";
import type { TurnEmit } from "../rachel.ts";
import { readdirSync, readFileSync, writeFileSync, unlinkSync, statSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { getModel, getEffort, setModel, setEffort, getReport } from "../proactive/modelConfig.ts";

export type BridgeRunTurn = (input: string, emit: TurnEmit, signal: AbortSignal) => Promise<void>;

export interface WatchdogEntry {
  slug: string;
  loop_name: string;
  pid: number;
  expected_cmd: string;          // "claude" — used to guard against pid recycling
  repo: string;
  log_path: string;
  progress_json_glob: string;   // <home>/.claude/agentic-loop/*<repo-fragment>*/*/progress.json — fully expanded, no ~
  progress_json_path: string | null;
  session_id: string | null;
  spawn_time: number;           // ms since epoch
  last_check: number | null;    // ms since epoch; null on first poll
  wake_floor: number | null;    // ms since epoch; set after a sleep gap
  pinged_at: number | null;     // ms since epoch; null until first stall ping
  done: boolean;
}

export interface FsFunctions {
  readdir: (dir: string) => string[];           // returns filenames
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
  unlink: (path: string) => void;
  stat: (path: string) => { mtimeMs: number };
  mkdirSync: (path: string, opts: { recursive: boolean }) => void;
  existsSync: (path: string) => boolean;
  rename: (from: string, to: string) => void;   // same-dir rename — the atomic-write half
  glob: (pattern: string) => string[];          // returns matching paths
}

export interface CreateBridgeOptions {
  config: ApiConfig;
  runTurn: BridgeRunTurn;
  getSessionId: () => string | undefined;
  resetSession: () => void;
  telegramSurface?: TelegramApprovalSurface;
  pollIntervalMs?: number;
  typingIntervalMs?: number;
  // Injectable for tests — avoids hitting the real filesystem/network.
  downloadFileFn?: (config: ApiConfig, fileId: string, destPath: string) => Promise<void>;
  watchdogDir?: string;                              // defaults to ~/.rachel/loops (expanded, not ~)
  fsFn?: FsFunctions;                               // defaults to real node:fs wrappers
  isPidAliveFn?: (pid: number, expectedCmd?: string) => boolean;  // defaults to kill -0 check; injectable for tests
  conflictBackoffMs?: number;  // defaults to CONFLICT_BACKOFF_MS (65s); injectable for tests to avoid real waits
  nowFn?: () => Date;          // clock seam — heartbeat timestamps + push() quiet-hours/dedup decisions
  heartbeatPath?: string;      // defaults to ~/.rachel/bridge-heartbeat.json (expanded, not ~)
  pushBaseDir?: string;        // push() state-store dir — defaults to ~/.rachel/proactive (expanded, not ~)
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number };
    text?: string;
    caption?: string;
    photo?: Array<{ file_id: string; file_size?: number; width: number; height: number }>;
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  };
  callback_query?: TelegramCallbackQuery;
}

const DEFAULT_TYPING_INTERVAL_MS = 5000;
const CONFLICT_BACKOFF_MS = 65_000;   // Telegram releases getUpdates lock in ~30-60s; 65s gives safe margin
const CONFLICT_EXIT_THRESHOLD = 5;    // 5 consecutive 409s (~5 min) = genuine second consumer, not launchd race

export interface Bridge {
  // Runs one getUpdates cycle (and processes whatever it returns) — the
  // seam tests drive directly instead of the infinite run() loop.
  drainOnce(): Promise<void>;
  // Starts the real infinite poll + FIFO-drain loop. Resolves only when
  // stop() is called (or a fatal error occurs).
  run(): Promise<void>;
  stop(): Promise<void>;
}

// STALL_THRESHOLD_MS: 60 awake-minutes of mtime silence → stall ping.
// Twin constant: skills/dashboard/app/src/lib/collect/sessions.ts STALLED_THRESHOLD_MS.
const STALL_THRESHOLD_MS = 60 * 60 * 1000;

export function defaultFsFn(): FsFunctions {
  return {
    readdir: (dir) => readdirSync(dir) as string[],
    readFile: (path) => readFileSync(path, "utf8"),
    writeFile: (path, content) => writeFileSync(path, content, "utf8"),
    unlink: (path) => unlinkSync(path),
    stat: (path) => statSync(path),
    mkdirSync: (path, opts) => mkdirSync(path, opts),
    existsSync: (path) => existsSync(path),
    rename: (from, to) => renameSync(from, to),
    // glob: two-level readdir walk for the one pattern used in this feature.
    // Pattern (fully expanded, no ~): <base>/*<fragment>*/*/progress.json
    // Walk: list slug-level dirs containing <fragment>, then session-id dirs under each.
    glob: (pattern) => {
      // Split on first "/*" to get the fixed base dir and the rest of the pattern.
      const starIdx = pattern.indexOf("/*");
      if (starIdx === -1) return [];
      const base = pattern.slice(0, starIdx);
      const rest = pattern.slice(starIdx + 2); // strip leading "/*"
      const parts = rest.split("/");
      if (parts.length !== 3) return []; // expect: <fragment>* / * / <filename>
      const [fragmentStar, , filename] = parts as [string, string, string];
      const fragment = fragmentStar.replace(/\*/g, "");
      if (!existsSync(base)) return [];
      const results: string[] = [];
      try {
        for (const slug of readdirSync(base)) {
          if (!slug.includes(fragment)) continue;
          const slugDir = join(base, slug);
          try {
            for (const sessionId of readdirSync(slugDir)) {
              const candidate = join(slugDir, sessionId, filename!);
              if (existsSync(candidate)) results.push(candidate);
            }
          } catch { /* not a directory or unreadable */ }
        }
      } catch { /* base unreadable */ }
      return results;
    },
  };
}

export function isPidAlive(pid: number, expectedCmd?: string): boolean {
  try {
    execSync(`kill -0 ${pid}`, { stdio: "ignore" });
    if (expectedCmd) {
      const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: "utf8" }).trim();
      return cmd.includes(expectedCmd);
    }
    return true;
  } catch {
    return false;
  }
}

function parseSessionId(logPath: string, fs: FsFunctions): string | null {
  try {
    const content = fs.readFile(logPath).slice(0, 4096);
    for (const line of content.split("\n")) {
      if (!line.includes('"subtype":"init"') && !line.includes('"subtype": "init"')) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (typeof obj["session_id"] === "string") return obj["session_id"];
      } catch { /* not valid JSON — skip */ }
    }
  } catch { /* log not yet written */ }
  return null;
}

function resolveProgressPath(entry: WatchdogEntry, fs: FsFunctions): string | null {
  const candidates = fs.glob(entry.progress_json_glob);
  if (entry.session_id) {
    const match = candidates.find((p) => p.includes(`/${entry.session_id}/`));
    return match ?? null;
  }
  // Fallback: most recently modified candidate with mtime > spawn_time
  let best: string | null = null;
  let bestMtime = entry.spawn_time;
  for (const p of candidates) {
    try {
      const m = fs.stat(p).mtimeMs;
      if (m > bestMtime) { best = p; bestMtime = m; }
    } catch { /* ignore unreadable */ }
  }
  return best;
}

function readLoopStopCounts(progressPath: string, fs: FsFunctions): Record<string, number> {
  try {
    const obj = JSON.parse(fs.readFile(progressPath)) as Record<string, unknown>;
    const counts = obj["loop_stop_counts"];
    if (counts && typeof counts === "object" && !Array.isArray(counts)) {
      return counts as Record<string, number>;
    }
  } catch { /* progress.json absent or malformed */ }
  return {};
}

async function checkWatchdogs(opts: {
  watchdogDir: string;
  pollPeriodMs: number;
  fs: FsFunctions;
  isPidAlive: (pid: number, expectedCmd?: string) => boolean;  // injectable for tests (stress-test fix 1)
  // Delivers a loop-watchdog ping through the push() chokepoint (never
  // rejects — the caller wraps push() with a direct-send fallback).
  pushPing: (eventId: string, state: string, text: string) => Promise<void>;
}): Promise<void> {
  const { watchdogDir, pollPeriodMs, fs, isPidAlive: pidAliveCheck, pushPing } = opts;

  if (!fs.existsSync(watchdogDir)) return;

  let files: string[];
  try {
    files = fs.readdir(watchdogDir).filter((f) => f.endsWith(".watchdog.json"));
  } catch { return; }

  const now = Date.now();

  for (const filename of files) {
    const watchdogPath = join(watchdogDir, filename);
    let entry: WatchdogEntry;
    try {
      entry = JSON.parse(fs.readFile(watchdogPath)) as WatchdogEntry;
    } catch { continue; }

    if (entry.done) {
      // Already consumed — remove stale file defensively.
      try { fs.unlink(watchdogPath); } catch { /* best-effort */ }
      continue;
    }

    const pidAlive = pidAliveCheck(entry.pid, entry.expected_cmd);

    if (!pidAlive) {
      // EVENT PATH: pid-gone → read stop counts + log tail, inject synthetic turn.
      const progressPath = entry.progress_json_path ?? resolveProgressPath(entry, fs);
      const counts = progressPath ? readLoopStopCounts(progressPath, fs) : {};
      const status = progressPath ? (() => {
        try { return (JSON.parse(fs.readFile(progressPath)) as Record<string, unknown>)["status"] ?? "unknown"; } catch { return "unknown"; }
      })() : "unknown";

      const nonZeroCategories = Object.entries(counts)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k}:${v}`)
        .join(", ") || "none";

      // Routed through the push() chokepoint (quiet-hours aware). State
      // carries spawn_time so a relaunched loop with the same slug re-arms
      // instead of deduping against a previous run's exit. The watchdog file
      // is consumed (done + unlink below) even if delivery totally failed —
      // a deliberate tradeoff: losing one exit ping beats a re-ping storm on
      // every subsequent poll while the send path is down.
      await pushPing(
        `loop-exit:${entry.slug}`,
        `exited:${entry.spawn_time}`,
        `[watchdog] Loop "${entry.loop_name}" (slug: ${entry.slug}) has exited. ` +
        `progress.json status=${String(status)}, loop_stop_counts={${nonZeroCategories}}. ` +
        `Log: ${entry.log_path}.`
      );

      entry.done = true;
      try { fs.writeFile(watchdogPath, JSON.stringify(entry, null, 2)); } catch { /* best-effort */ }
      try { fs.unlink(watchdogPath); } catch { /* best-effort */ }
      continue;
    }

    // ALIVE PATH — sleep-aware clock update first.
    // Use a fixed 5-minute gap rather than a multiple of pollPeriodMs: the cycle
    // time is dominated by the server-side long-poll timeout (30s), not the
    // configured poll interval, so 5 * pollPeriodMs would fire on every normal
    // cycle and defeat the sleep-detection logic entirely.
    if (entry.last_check !== null && now - entry.last_check > 5 * 60_000) {
      entry.wake_floor = now; // machine slept; restart the silence window
    }
    entry.last_check = now;

    // Session-id binding: read from log on first non-empty cycle.
    if (entry.session_id === null) {
      const sid = parseSessionId(entry.log_path, fs);
      if (sid !== null) entry.session_id = sid;
    }

    // Resolve progress.json path deterministically once session_id is known.
    if (entry.progress_json_path === null && entry.session_id !== null) {
      const resolved = resolveProgressPath(entry, fs);
      if (resolved !== null) entry.progress_json_path = resolved;
    }

    // Liveness: max(progress.json mtime, spawn_time, wake_floor).
    let liveMtime = entry.spawn_time;
    if (entry.progress_json_path) {
      try { liveMtime = Math.max(liveMtime, fs.stat(entry.progress_json_path).mtimeMs); } catch { /* absent */ }
    }
    if (entry.wake_floor !== null) liveMtime = Math.max(liveMtime, entry.wake_floor);

    const stalled = liveMtime + STALL_THRESHOLD_MS < now;

    if (stalled && entry.pinged_at === null) {
      // STALL PATH: first stall ping.
      const lastUnit = (() => {
        if (!entry.progress_json_path) return "none (loop never registered progress.json)";
        try {
          const obj = JSON.parse(fs.readFile(entry.progress_json_path)) as Record<string, unknown>;
          const units = obj["work_units"];
          if (units && typeof units === "object") {
            const entries = Array.isArray(units)
              ? units
              : Object.values(units);
            const last = entries.filter((u): u is Record<string, unknown> => typeof u === "object" && u !== null).pop();
            return String(last?.["title"] ?? last?.["id"] ?? "unknown");
          }
        } catch { /* ignore */ }
        return "unknown";
      })();
      // Routed through the push() chokepoint. The pinged_at debounce above
      // is KEPT as its own layer rather than superseded by chokepoint dedup:
      // the two are not behaviour-equivalent (verified against the watchdog
      // tests — e.g. a sleep/wake bumps wake_floor into a fresh stall onset,
      // which would read as a new chokepoint state and re-ping a
      // still-stalled loop that pinged_at correctly keeps quiet, and the
      // mtime-advance-clears-debounce re-arm below has no store analogue).
      await pushPing(
        `loop-stall:${entry.slug}`,
        `stalled:${new Date(liveMtime).toISOString()}`,
        `[watchdog] Loop "${entry.loop_name}" (slug: ${entry.slug}, pid: ${entry.pid}) has gone quiet for 60+ min. ` +
        `Last known unit: ${lastUnit}. Log: ${entry.log_path}.`
      );
      entry.pinged_at = now;
    }

    // Clear stall debounce if progress.json mtime advanced past the ping.
    if (
      entry.pinged_at !== null &&
      entry.progress_json_path !== null
    ) {
      try {
        const currentMtime = fs.stat(entry.progress_json_path).mtimeMs;
        if (currentMtime > entry.pinged_at) entry.pinged_at = null;
      } catch { /* ignore */ }
    }

    // Persist watchdog state after every alive-path cycle.
    try { fs.writeFile(watchdogPath, JSON.stringify(entry, null, 2)); } catch { /* best-effort */ }
  }
}

export interface CheckLaunchAllowedOpts {
  watchdogDir: string;
  fs: FsFunctions;
  isPidAlive: (pid: number, expectedCmd?: string) => boolean;
  staleThresholdMs?: number;   // defaults to STALL_THRESHOLD_MS (60 min)
}

export interface LaunchAllowedResult {
  allowed: boolean;
  reason?: string;   // set when allowed=false; Rachel relays this verbatim
}

export function checkLaunchAllowed(repo: string, opts: CheckLaunchAllowedOpts): LaunchAllowedResult {
  const { watchdogDir, fs, isPidAlive: pidAliveCheck } = opts;
  const staleThresholdMs = opts.staleThresholdMs ?? STALL_THRESHOLD_MS;
  const repoBasename = repo.split("/").filter(Boolean).pop() ?? repo;
  const now = Date.now();

  // Check 1: live Rachel-tracked watchdog for this repo.
  if (fs.existsSync(watchdogDir)) {
    try {
      for (const filename of fs.readdir(watchdogDir).filter((f) => f.endsWith(".watchdog.json"))) {
        let entry: WatchdogEntry;
        try { entry = JSON.parse(fs.readFile(join(watchdogDir, filename))) as WatchdogEntry; }
        catch { continue; }
        if (entry.done) continue;
        if (!entry.repo.includes(repoBasename)) continue;
        if (pidAliveCheck(entry.pid, entry.expected_cmd)) {
          return { allowed: false, reason: `Loop "${entry.loop_name}" is already running on that repo (pid ${entry.pid}).` };
        }
      }
    } catch { /* watchdogDir unreadable — treat as empty */ }
  }

  // Check 2: any progress.json under ~/.claude/agentic-loop/ for this repo
  // with status != "complete" and mtime ≤ staleThresholdMs ago.
  const agenticBase = join(homedir(), ".claude", "agentic-loop");
  const candidates = fs.glob(`${agenticBase}/*${repoBasename}*/*/progress.json`);
  for (const path of candidates) {
    try {
      const obj = JSON.parse(fs.readFile(path)) as Record<string, unknown>;
      const status = String(obj["status"] ?? "unknown");
      if (status === "complete") continue;
      const mtime = fs.stat(path).mtimeMs;
      const ageMs = now - mtime;
      if (ageMs <= staleThresholdMs) {
        const agoMin = Math.round(ageMs / 60_000);
        return { allowed: false, reason: `A loop on that repo is active (progress.json status=${status}, last activity ${agoMin} min ago).` };
      }
    } catch { /* skip unreadable */ }
  }

  return { allowed: true };
}

export function createBridge(options: CreateBridgeOptions): Bridge {
  const { config, runTurn, getSessionId, resetSession } = options;
  const downloadFileFn = options.downloadFileFn ?? downloadFile;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const typingIntervalMs = options.typingIntervalMs ?? DEFAULT_TYPING_INTERVAL_MS;

  // Tilde expansion: watchdogDir must be an absolute path — Node's fs never expands ~.
  const watchdogDir = options.watchdogDir ?? join(homedir(), ".rachel", "loops");
  const resolvedFs = options.fsFn ?? defaultFsFn();
  const resolvedIsPidAlive = options.isPidAliveFn ?? isPidAlive;
  const resolvedConflictBackoffMs = options.conflictBackoffMs ?? CONFLICT_BACKOFF_MS;
  const nowFn = options.nowFn ?? (() => new Date());
  const heartbeatPath = options.heartbeatPath ?? join(homedir(), ".rachel", "bridge-heartbeat.json");

  try { resolvedFs.mkdirSync(watchdogDir, { recursive: true }); } catch { /* already exists */ }

  const fifo: string[] = [];
  let offset: number | undefined;
  let stopped = false;
  let currentAbort: AbortController | undefined;
  let draining = false;
  let backoffMs = 1000;
  const MAX_BACKOFF_MS = 30_000;

  // Heartbeat: written once per successful poll iteration. Deliberately NOT
  // written during 409-conflict backoff — the sweep's wedge detection reads
  // staleness as "poll loop silent", and the 10-minute threshold there
  // clears the legitimate 5x65s backoff window.
  let turnInFlightSince: Date | null = null;   // set while drainFifo has a turn running
  let lastHeartbeatMs = 0;
  let heartbeatWriteFailing = false;

  function writeHeartbeat(): void {
    try {
      // Strictly monotonic per iteration even under a coarse or frozen
      // clock, so consecutive heartbeats are always distinguishable.
      const nowMs = Math.max(nowFn().getTime(), lastHeartbeatMs + 1);
      lastHeartbeatMs = nowMs;
      const heartbeat = {
        schema_version: 1,
        last_poll_at: new Date(nowMs).toISOString(),
        queue_depth: fifo.length,
        turn_in_flight_since: turnInFlightSince === null ? null : turnInFlightSince.toISOString(),
      };
      // Temp-file + rename in the same directory — push.ts's atomic-write
      // idiom. A sweep reading mid-write never sees a torn file.
      resolvedFs.mkdirSync(dirname(heartbeatPath), { recursive: true });
      const tmpPath = `${heartbeatPath}.tmp-${process.pid}`;
      resolvedFs.writeFile(tmpPath, JSON.stringify(heartbeat, null, 2));
      resolvedFs.rename(tmpPath, heartbeatPath);
      heartbeatWriteFailing = false;
    } catch (err) {
      // A heartbeat failure must NEVER break polling, and must not spam the
      // log every tick — log once on entering the failing state, re-arm on
      // recovery.
      if (!heartbeatWriteFailing) {
        heartbeatWriteFailing = true;
        console.error(`[telegram-bridge] heartbeat write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Health state machine — mutated only in run() loop below.
  // health: current state; consecutive409: 409 streak; lastError: last failure for /status.
  type BridgeHealth = "healthy" | "conflict" | "failed";
  let health: BridgeHealth = "healthy";
  let consecutive409 = 0;
  let lastError: { message: string; at: string; recovered: boolean } | null = null;

  async function reply(text: string): Promise<void> {
    await sendChunked(config, text);
  }

  // Proactive-alert plumbing: startup notice, watchdog pings, and health
  // transitions route through proactive/push.ts's push() chokepoint so they
  // pick up quiet-hours deferral, dedup, and budget like every other
  // proactive ping. The FATAL 5x409 exit alert deliberately does NOT — the
  // process is dying and that alert keeps its direct awaited send.
  const pushBaseDir = options.pushBaseDir ?? join(homedir(), ".rachel", "proactive");
  const bridgePushDeps: Partial<PushDeps> = {
    now: nowFn,
    baseDir: pushBaseDir,
    sendFn: (text: string) => sendChunked(config, text),
  };
  // A push() failure must never crash the bridge, and an alert must never be
  // lost to the chokepoint plumbing: on any push() throw we fall back to a
  // direct sendChunked (giving up quiet-hours/dedup semantics for that one
  // alert — the safe direction). Never rejects. push() itself treats a
  // sent-but-unrecorded event as "sent" (post-send bookkeeping failures do
  // not throw), so this fallback only fires for PRE-send failures and can
  // never double-deliver an alert push() already sent.
  async function pushAlert(family: string, eventId: string, state: string, severity: Severity, text: string): Promise<void> {
    try {
      await push(family, eventId, state, severity, text, bridgePushDeps);
    } catch (err) {
      console.error(`[telegram-bridge] push() failed for ${family}/${eventId}: ${err instanceof Error ? err.message : String(err)} — falling back to direct send`);
      try {
        await sendChunked(config, text);
      } catch (sendErr) {
        console.error(`[telegram-bridge] direct-send fallback also failed for ${family}/${eventId}: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
      }
    }
  }
  // Startup state is pinned per process: run() re-entry within one process
  // dedups at the chokepoint, while a crash-restart (new process, new boot
  // time) re-arms and announces itself.
  const startupState = `boot:${nowFn().toISOString()}`;

  async function handleMessage(msg: NonNullable<TelegramUpdate["message"]>): Promise<void> {
    const fromChatId = String(msg.chat.id);
    if (fromChatId !== config.chatId) {
      // Audit row for rejected ingress — a message from an unauthorised
      // chat must never reach the agent.
      console.error(`[telegram-bridge] rejected message from unauthorised chat_id=${fromChatId}`);
      return;
    }

    const text = (msg.text ?? "").trim();

    if (text === "/reset") {
      resetSession();
      await reply("Session reset.");
      return;
    }
    if (text === "/status") {
      const sessionId = getSessionId();
      const lastErrLine = lastError !== null
        ? `\nlast error: ${lastError.message} (${lastError.at}${lastError.recovered ? ", recovered" : ", ongoing"})`
        : "";
      await reply(
        `uptime: ${Math.floor(process.uptime())}s\n` +
          `health: ${health}\n` +
          `session: ${sessionId ?? "(none)"}\n` +
          `model: ${getModel()}\n` +
          `effort: ${getEffort()}\n` +
          `turn in flight: ${currentAbort ? "yes" : "no"}` +
          lastErrLine,
      );
      return;
    }
    if (text === "/stop") {
      if (currentAbort) {
        currentAbort.abort();
        await reply("Stopped.");
      } else {
        await reply("No turn in flight.");
      }
      return;
    }
    // /model and /effort take an optional argument (unlike /reset, /status,
    // /stop above, which are exact-match) — split on whitespace rather than
    // exact- or prefix-matching the whole string so trailing/interior
    // whitespace around the argument doesn't block parsing.
    const parts = text.split(/\s+/).filter((p) => p.length > 0);
    if (parts[0] === "/model") {
      const arg = parts[1];
      if (arg === undefined) {
        const report = getReport();
        await reply(`model: ${report.model}\nvalid options: ${report.validModels.join(", ")}`);
      } else {
        const result = setModel(arg);
        if (result.ok) {
          await reply(`model set to ${result.value} — takes effect on the next turn.`);
        } else {
          await reply(result.message);
        }
      }
      return;
    }
    if (parts[0] === "/effort") {
      const arg = parts[1];
      if (arg === undefined) {
        const report = getReport();
        await reply(`effort: ${report.effort}\nvalid options: ${report.validEfforts.join(", ")}`);
      } else {
        const result = setEffort(arg);
        if (result.ok) {
          await reply(`effort set to ${result.value} — takes effect on the next turn.`);
        } else {
          await reply(result.message);
        }
      }
      return;
    }

    // Handle photo or image document messages.
    if (msg.photo || msg.document) {
      let fileId: string | undefined;
      let ext = "jpg";

      if (msg.photo && msg.photo.length > 0) {
        // Telegram sends photo array ascending by size — last is largest.
        const largest = msg.photo[msg.photo.length - 1]!;
        fileId = largest.file_id;
        ext = "jpg";
      } else if (msg.document) {
        const mime = msg.document.mime_type ?? "";
        // Only handle image/* — skip PDFs, plain text, and other types.
        if (!mime.startsWith("image/")) {
          await reply("I can only receive images. Try sending a JPEG or PNG.");
          return;
        }
        fileId = msg.document.file_id;
        if (msg.document.file_name) {
          const dot = msg.document.file_name.lastIndexOf(".");
          ext = dot >= 0 ? msg.document.file_name.slice(dot + 1) : "jpg";
        } else {
          // Derive from mime, e.g. image/png -> png
          ext = mime.split("/")[1] ?? "jpg";
        }
        // Clamp to safe alphanumeric characters only.
        ext = ext.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "bin";
      }

      if (!fileId) return;

      const tmpDir = `${homedir()}/.rachel/tmp`;
      const destPath = `${tmpDir}/${fileId}.${ext}`;
      try {
        await downloadFileFn(config, fileId, destPath);
      } catch (err) {
        console.error(`[telegram-bridge] failed to download image: ${err instanceof Error ? err.message : String(err)}`);
        try {
          await reply("Failed to download image — please try again.");
        } catch (replyErr) {
          console.error(`[telegram-bridge] also failed to send failure reply: ${replyErr instanceof Error ? replyErr.message : String(replyErr)}`);
        }
        return;
      }

      const caption = (msg.caption ?? "").trim();
      const input = caption ? `[image: ${destPath}]\n${caption}` : `[image: ${destPath}]`;
      fifo.push(input);
      return;
    }

    if (!text) return;
    fifo.push(text);
  }

  async function handleCallbackQuery(cb: TelegramCallbackQuery): Promise<void> {
    if (String(cb.from.id) !== config.chatId) {
      // Still routed to the surface (not dropped here) — its own auth check
      // calls answerCallbackQuery so the tapping client's button spinner
      // resolves instead of hanging forever. Only logged here for the audit
      // trail of rejected ingress.
      console.error(`[telegram-bridge] unauthorised callback_query from from_id=${cb.from.id}`);
    }
    if (options.telegramSurface) {
      await options.telegramSurface.handleCallbackQuery(cb);
    }
  }

  async function drainFifo(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (fifo.length > 0) {
        const text = fifo.shift()!;
        const abortController = new AbortController();
        currentAbort = abortController;
        turnInFlightSince = nowFn();

        const typingTimer = setInterval(() => {
          sendTyping(config).catch(() => {
            // Best-effort — a failed typing indicator must never affect the turn.
          });
        }, typingIntervalMs);
        // Fire once immediately so the indicator appears without waiting a
        // full interval for a short turn.
        sendTyping(config).catch(() => {});

        const buffer: string[] = [];
        try {
          await runTurn(text, (line, kind) => {
            if (kind === "text") buffer.push(line);
          }, abortController.signal);
        } catch (err) {
          buffer.push(`[Rachel] error: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          clearInterval(typingTimer);
          currentAbort = undefined;
          turnInFlightSince = null;
        }

        const replyText = buffer.join("\n").trim();
        await reply(replyText || "(no output)");
      }
    } finally {
      draining = false;
    }
  }

  async function processUpdates(updates: TelegramUpdate[]): Promise<void> {
    for (const update of updates) {
      offset = update.update_id + 1;
      try {
        if (update.callback_query) {
          // Callbacks are routed immediately — never queued behind pending
          // chat turns, since a gate decision may be blocking one.
          await handleCallbackQuery(update.callback_query);
          continue;
        }
        if (update.message) {
          await handleMessage(update.message);
        }
      } catch (err) {
        // offset has already advanced past this update — Telegram will never
        // redeliver it, so a throw here (e.g. a transient reply() failure
        // acking /reset, /status, or /stop) must not be allowed to propagate
        // to run()'s generic poll-error backoff, which would look like a
        // getUpdates failure rather than the real cause. Log and move on to
        // the next update in this batch instead of losing the whole poll.
        console.error(`[telegram-bridge] error handling update ${update.update_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Kick the FIFO drain off without blocking this poll cycle — a
    // long-running turn (or one waiting on /stop) must never stall getUpdates,
    // since /stop itself has to arrive via the next poll.
    void drainFifo().catch((err) => {
      console.error(`[telegram-bridge] drain error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  async function pollOnce(): Promise<void> {
    const params = new URLSearchParams({ timeout: "30" });
    if (offset !== undefined) params.set("offset", String(offset));
    const result = (await tg(config, `getUpdates?${params.toString()}`, {})) as TelegramUpdate[];
    backoffMs = 1000;
    await processUpdates(result ?? []);
    await checkWatchdogs({
      watchdogDir,
      pollPeriodMs: pollIntervalMs,
      fs: resolvedFs,
      isPidAlive: resolvedIsPidAlive,
      pushPing: (eventId, state, text) => pushAlert("loop-watchdog", eventId, state, "normal", text),
    });
    writeHeartbeat();
  }

  return {
    async drainOnce() {
      await pollOnce();
    },

    async run() {
      setMyCommands(config, [
        { command: "reset", description: "Reset the conversation session" },
        { command: "status", description: "Show bridge status" },
        { command: "stop", description: "Abort the in-flight turn" },
      ]).catch((err) => {
        console.error(`[telegram-bridge] setMyCommands failed: ${err instanceof Error ? err.message : String(err)}`);
      });

      // Startup alert — best-effort, non-blocking, through the chokepoint at
      // NORMAL severity: a restart is informational, so a 3am crash-restart
      // defers overnight and lands in the morning digest instead of waking
      // Gary (the urgent alert for a dying bridge is the FATAL exit path,
      // which precedes the restart). A restart is the only signal Gary gets
      // for a non-409 death (OOM, uncaught exception, reboot): those exits
      // can't alert themselves, so the NEXT boot announces it happened.
      void pushAlert("bridge-startup", "bridge:startup", startupState, "normal", "Rachel bridge started.");

      while (!stopped) {
        try {
          await pollOnce();
          // Successful poll — reset 409 counter and alert Gary on recovery.
          consecutive409 = 0;
          if (health !== "healthy") {
            const prev = health;
            health = "healthy";
            if (lastError !== null) lastError = { ...lastError, recovered: true };
            const msg = prev === "conflict"
              ? "Rachel bridge recovered from Telegram conflict — back online."
              : "Rachel bridge recovered from poll error — back online.";
            console.log(`[telegram-bridge] recovered from ${prev} state.`);
            void pushAlert("bridge-health", "bridge:health", "healthy", "normal", msg);
          }
          // Yield to the macrotask queue so that bridge.stop() → stopped=true
          // is observable before the next iteration. A zero-delay setTimeout is
          // sufficient — the getUpdates long poll already governs real cadence
          // (30s server-side timeout), so we don't want to add extra latency here.
          await new Promise((r) => setTimeout(r, 0));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const isConflict = message.includes("409") || message.toLowerCase().includes("conflict");

          if (isConflict) {
            consecutive409++;
            lastError = { message, at: new Date().toISOString(), recovered: false };

            if (health !== "conflict") {
              health = "conflict";
              console.error(`[telegram-bridge] 409 conflict (${consecutive409}/${CONFLICT_EXIT_THRESHOLD}): ${message} — backing off ${resolvedConflictBackoffMs / 1000}s, will auto-recover.`);
              void pushAlert("bridge-health", "bridge:health", "conflict", "normal",
                `Rachel bridge: Telegram 409 conflict detected. Backing off ${resolvedConflictBackoffMs / 1000}s and retrying — will auto-recover if this is a launchd restart race.`
              );
            } else {
              console.error(`[telegram-bridge] 409 conflict (${consecutive409}/${CONFLICT_EXIT_THRESHOLD}): ${message}`);
            }

            if (consecutive409 >= CONFLICT_EXIT_THRESHOLD) {
              console.error(`[telegram-bridge] FATAL: 409 conflict persisted for ${consecutive409} consecutive attempts — genuine second consumer, exiting.`);
              // Await the alert before exiting — fire-and-forget would be killed by process.exit
              // before the HTTP request completes. "Never block the poll loop" doesn't apply here
              // since we're exiting immediately after.
              await sendChunked(config,
                `Rachel bridge FATAL: Telegram 409 conflict persisted for ${consecutive409} attempts (~${Math.round(consecutive409 * resolvedConflictBackoffMs / 60_000)} min). Genuine second consumer detected. Exiting — launchd will restart.`
              ).catch((alertErr) => {
                console.error(`[telegram-bridge] FATAL: failed to send exit alert: ${alertErr instanceof Error ? alertErr.message : String(alertErr)}`);
              });
              process.exit(1);
            }

            await new Promise((resolve) => setTimeout(resolve, resolvedConflictBackoffMs));
          } else {
            // Non-conflict error — reset 409 streak regardless of current state.
            consecutive409 = 0;
            lastError = { message, at: new Date().toISOString(), recovered: false };
            if (health !== "failed") {
              health = "failed";
              console.error(`[telegram-bridge] poll error (entering failed state): ${message}`);
              void pushAlert("bridge-health", "bridge:health", "failed", "normal", `Rachel bridge poll error: ${message}. Retrying with backoff.`);
            } else {
              console.error(`[telegram-bridge] poll error: ${message}`);
            }
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
          }
        }
      }
    },

    async stop() {
      stopped = true;
      if (currentAbort) {
        currentAbort.abort();
      }
    },
  };
}

// Only start the real bridge when this file is executed directly, not when
// imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadTelegramConfig } = await import("../gate/surfaces/telegram.ts");
  // Import rachel.ts's OWN telegramSurface instance — the one its
  // send-gate hook actually races against — rather than constructing a
  // second, disconnected surface here. A callback tap must resolve the same
  // instance the gate is waiting on.
  const { runTurn, getSessionId, resetSession, telegramSurface } = await import("../rachel.ts");

  const telegramConfig = loadTelegramConfig();
  if (!telegramConfig) {
    console.error("[telegram-bridge] no Telegram config found (RACHEL_TELEGRAM_TOKEN/RACHEL_TELEGRAM_CHAT_ID or ~/.rachel/telegram.json) — exiting.");
    process.exit(2);
  }
  if (!telegramSurface) {
    console.error("[telegram-bridge] rachel.ts loaded but its telegramSurface is undefined — config mismatch, exiting.");
    process.exit(2);
  }

  const bridge = createBridge({
    config: telegramConfig,
    runTurn,
    getSessionId,
    resetSession,
    telegramSurface,
  });

  process.on("SIGINT", () => void bridge.stop().then(() => process.exit(0)));
  process.on("SIGTERM", () => void bridge.stop().then(() => process.exit(0)));

  console.log("[telegram-bridge] starting.");
  await bridge.run();
}
