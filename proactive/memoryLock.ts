// Mutual-exclusion lock for MEMORY.md read-modify-write updates.
//
// WHY THIS EXISTS: ~/.rachel/memory/MEMORY.md is updated read-whole-file,
// append-a-pointer-line, write-back by at least three writer classes
// concurrently — the interactive CLI, the Telegram bridge, and roughly 8
// headless one-shots a day (inbox-brief + proactive-calendar). The repo's
// house idiom for state files (proactive/push.ts, proactive/sessionPersist.ts)
// is atomic temp-file + rename — that gives DURABILITY (a reader never sees
// a half-written file) but not MUTUAL EXCLUSION: two concurrent writers can
// both read the old index, both append their own line, both rename, and the
// second rename silently discards the first writer's line forever. This
// module is the actual mutex that idiom doesn't provide.
//
// DESIGN: a plain lockfile with O_EXCL, no dependency — matches the repo's
// no-extra-deps convention (push.ts/sessionPersist.ts use node:fs directly).
// flock needs a native binding; a lockfile library adds a dependency for
// something ~30 lines of node:fs covers.
//
// STALENESS: the lockfile holds { pid, acquired_at }. A lock is stale (and
// safe to break) if EITHER: (a) the holder's pid is no longer alive
// (process crashed mid-write — same kill-0 idiom as
// bridge/telegram-bridge.ts's isPidAlive), OR (b) the lock is older than
// staleMs regardless of pid liveness (a holder that's alive but wedged
// forever on an unrelated await would otherwise block the store forever —
// pid-liveness alone can't catch that). PID-reuse is a known hazard with
// kill-0 alone (the OS can recycle a pid for an unrelated process); the mtime
// backstop bounds the damage to staleMs even if a reused pid looks alive.
//
// TIMEOUT: acquiring throws loud rather than proceeding unlocked. Contrast
// with push.ts's budget.json, which accepts a leaky ±1 read-modify-write
// because the loss is safe-direction (a cap under-counting by one still
// caps). A lost MEMORY.md pointer line is not safe-direction — it is a
// permanently destroyed memory — so silently proceeding unlocked would
// reintroduce the exact bug this module exists to prevent. Timeout instead
// surfaces to the caller (Rachel via the CLI below) to retry or report.
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";

export interface LockOptions {
  staleMs: number;
  pid: number;
  now: () => Date;
  isPidAlive?: (pid: number) => boolean;
}

export interface AcquireLockOptions extends LockOptions {}

export interface WithLockOptions extends LockOptions {
  timeoutMs: number;
  pollMs: number;
}

interface LockFileContents {
  pid: number;
  acquired_at: string;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    // Signal 0 sends nothing — it only probes whether the pid exists and is
    // signalable. Same semantics as bridge/telegram-bridge.ts's isPidAlive
    // (which shells out to `kill -0`); process.kill avoids the extra
    // subprocess here since we don't need the expected-command check.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockFile(path: string): LockFileContents | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
  try {
    return JSON.parse(raw) as LockFileContents;
  } catch {
    // A corrupt lockfile (partial write from a holder that crashed mid-write
    // to the LOCKFILE itself) is treated as stale-by-unparseable — return
    // undefined-shaped so isStale's caller breaks it rather than deadlocking
    // the store forever over a broken lock record.
    return undefined;
  }
}

// True when the lock at `path` is safe to break: absent, corrupt, dead pid,
// or older than staleMs.
function isStale(path: string, opts: LockOptions): boolean {
  const contents = readLockFile(path);
  if (contents === undefined) {
    return true;
  }
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  if (!isPidAlive(contents.pid)) {
    return true;
  }
  const acquiredMs = Date.parse(contents.acquired_at);
  if (Number.isNaN(acquiredMs)) {
    return true;
  }
  return opts.now().getTime() - acquiredMs > opts.staleMs;
}

// Thrown by acquireMemoryLock specifically for genuine contention (the lock
// is held and live) — a distinct class, not a string-matched message, so
// withMemoryLock's poll loop can tell "retry me, another holder has it" from
// every other failure (ENOENT, EACCES, ENOTDIR, ...) which is NOT
// contention and will never clear on its own. Retrying on those would
// busy-poll the full timeout and then throw a misleading "timed out"
// message that hides the real errno — same "only the expected condition is
// silent, anything else is loud" idiom as memoryIndex.ts's ENOENT handling.
export class LockContentionError extends Error {
  constructor(path: string) {
    super(`memory lock held: ${path}`);
    this.name = "LockContentionError";
  }
}

// Opaque handle returned by acquireMemoryLock, required by releaseMemoryLock
// — forces callers to release only a lock they actually hold (rather than
// blindly deleting whatever lockfile happens to exist), though it stays a
// light marker rather than an unforgeable token since this is a
// single-process, non-adversarial concurrency primitive.
export interface LockHandle {
  readonly acquiredAt: string;
}

// Single non-blocking attempt: try to create the lockfile exclusively. If it
// already exists and is stale, break it (best-effort delete, ignore ENOENT
// from a racing breaker) and retry the O_EXCL create ONCE — never loop here,
// looping belongs to withMemoryLock's poll. Throws on genuine contention
// (lockfile exists and is live) so callers can decide to poll/retry.
export function acquireMemoryLock(path: string, opts: AcquireLockOptions): LockHandle {
  const acquiredAt = opts.now().toISOString();
  const contents: LockFileContents = { pid: opts.pid, acquired_at: acquiredAt };
  const body = JSON.stringify(contents);

  const tryCreate = (): boolean => {
    let fd: number;
    try {
      // wx = O_CREAT | O_EXCL | O_WRONLY — atomically fails if the file
      // already exists. This IS the mutual-exclusion primitive; unlike
      // temp-file+rename, there is no window where two callers can both
      // succeed.
      fd = openSync(path, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw err;
    }
    try {
      writeSync(fd, body);
    } finally {
      closeSync(fd);
    }
    return true;
  };

  if (tryCreate()) {
    return { acquiredAt };
  }
  if (!isStale(path, opts)) {
    throw new Error(`memory lock held: ${path}`);
  }
  // Break the stale lock and retry exactly once. A racing acquirer could
  // recreate it between our unlink and our retry create — that retry then
  // legitimately fails with EEXIST/contention, which is correct: the other
  // caller won the race fairly.
  try {
    rmSync(path, { force: true });
  } catch {
    /* another breaker may have already removed it — fine */
  }
  if (tryCreate()) {
    return { acquiredAt };
  }
  throw new Error(`memory lock held: ${path}`);
}

// Releases a lock this caller acquired. Only removes the lockfile if it
// still names the SAME acquisition (matched on acquired_at) — otherwise a
// slow releaser could delete a different holder's lock (e.g. one that broke
// ours as stale and acquired its own while we were mid-callback). Missing
// entirely is a silent no-op (already cleaned up by a stale-break).
export function releaseMemoryLock(path: string, handle: LockHandle): void {
  const contents = readLockFile(path);
  if (contents === undefined) {
    return;
  }
  if (contents.acquired_at !== handle.acquiredAt) {
    return;
  }
  try {
    rmSync(path, { force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Acquire, run fn, always release — even on throw. Polls at pollMs intervals
// until timeoutMs elapses, then throws loud (see module header: proceeding
// unlocked would reintroduce the lost-update bug this exists to prevent).
export async function withMemoryLock<T>(path: string, fn: () => Promise<T>, opts: WithLockOptions): Promise<T> {
  const deadline = opts.now().getTime() + opts.timeoutMs;
  let handle: LockHandle | undefined;
  while (handle === undefined) {
    try {
      handle = acquireMemoryLock(path, opts);
    } catch {
      if (opts.now().getTime() >= deadline) {
        throw new Error(`memory lock timed out after ${opts.timeoutMs}ms: ${path}`);
      }
      await sleep(opts.pollMs);
    }
  }
  try {
    return await fn();
  } finally {
    releaseMemoryLock(path, handle);
  }
}

// Whether a lockfile currently exists at path (diagnostic use only — a
// caller must never branch write behaviour on this instead of going through
// withMemoryLock, since existence can change between check and use).
export function lockExists(path: string): boolean {
  return existsSync(path);
}
