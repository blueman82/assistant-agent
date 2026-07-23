// Tests for the MEMORY.md write lock. Two layers:
//  1. Primitive-level: acquire/release/staleness/timeout behaviour of the
//     lock itself, with real fs in a temp dir (no real concurrency needed —
//     these are single-process, deterministic).
//  2. Lost-update demonstration: a controllable read-modify-write append
//     simulates two interleaved writers. Run WITHOUT the lock first to prove
//     the loss is real (SO-15 — a green test that would also pass unlocked
//     proves nothing), then WITH the lock to prove both survive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireMemoryLock, releaseMemoryLock, withMemoryLock, LockContentionError } from "./memoryLock.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rachel-test-memlock-"));
}

// A deferred promise gives an external test full control over when an
// in-flight async step resumes — the only way to force a genuine A-reads,
// B-reads, A-writes, B-writes interleaving instead of accidental
// serialization from a synchronous fs call completing before the next
// microtask runs (the exact trap the advisor flagged: a synchronous
// openSync has no await point, so Promise.all([a(), b()]) can silently
// serialize and prove nothing).
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// Simulates the real MEMORY.md read-modify-write append that Rachel performs
// freehand: read whole file, append a pointer line, write back. `gate` lets
// the caller suspend the writer between read and write to force interleaving.
async function unlockedAppend(path: string, line: string, gate?: Promise<void>): Promise<void> {
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (gate) await gate;
  writeFileSync(path, `${before}${line}\n`);
}

test("lost update: two interleaved unlocked appends silently drop one pointer line", async () => {
  const dir = tmpDir();
  const path = join(dir, "MEMORY.md");
  writeFileSync(path, "# Memory Index\n\n");

  // Force the real race: A reads, B reads (both see the original file),
  // THEN A writes, THEN B writes — B's write has no knowledge of A's line.
  const releaseA = deferred<void>();
  const writerA = unlockedAppend(path, "- [A](a.md) — fact a", releaseA.promise);
  // Let A's read (the synchronous part before the gate) run first.
  await Promise.resolve();
  const writerB = unlockedAppend(path, "- [B](b.md) — fact b");
  await writerB; // B reads (sees no A yet) and writes immediately, no gate.
  releaseA.resolve();
  await writerA; // A now writes, using the read it took BEFORE B's write.

  const final = readFileSync(path, "utf8");
  const hasA = final.includes("- [A](a.md)");
  const hasB = final.includes("- [B](b.md)");
  // This is the failing-for-the-right-reason assertion: without a lock,
  // exactly one of the two pointer lines survives — proving the loss is
  // real, not a fixture artifact.
  assert.ok(!(hasA && hasB), `expected a lost update (only one line survives), but both present: ${final}`);
});

test("lost update is prevented when both appends go through withMemoryLock", async () => {
  const dir = tmpDir();
  const path = join(dir, "MEMORY.md");
  writeFileSync(path, "# Memory Index\n\n");
  const lockPath = `${path}.lock`;

  const releaseA = deferred<void>();
  const writerA = withMemoryLock(
    lockPath,
    async () => {
      await unlockedAppend(path, "- [A](a.md) — fact a", releaseA.promise);
    },
    { staleMs: 30_000, timeoutMs: 5_000, pollMs: 5, now: () => new Date(), pid: process.pid },
  );
  // Give A's acquire + read a tick to run and take the lock before B tries.
  await Promise.resolve();
  await Promise.resolve();

  const writerB = withMemoryLock(
    lockPath,
    async () => {
      await unlockedAppend(path, "- [B](b.md) — fact b");
    },
    { staleMs: 30_000, timeoutMs: 5_000, pollMs: 5, now: () => new Date(), pid: process.pid },
  );

  // B is blocked acquiring the lock (A holds it) until A releases.
  releaseA.resolve();
  await Promise.all([writerA, writerB]);

  const final = readFileSync(path, "utf8");
  assert.ok(final.includes("- [A](a.md)"), `A's line missing: ${final}`);
  assert.ok(final.includes("- [B](b.md)"), `B's line missing: ${final}`);
});

test("acquireMemoryLock creates a lockfile that a second acquire cannot take", async () => {
  const dir = tmpDir();
  const lockPath = join(dir, "MEMORY.md.lock");
  // Use this test process's own pid so the default isPidAlive genuinely
  // reports it as live — an arbitrary fixed number risks colliding with a
  // real-but-unrelated dead pid on the machine and silently reclaiming it,
  // which would defeat the point of this test.
  const handle = acquireMemoryLock(lockPath, { staleMs: 30_000, pid: process.pid, now: () => new Date() });
  assert.ok(existsSync(lockPath));

  // A second acquire with a short timeout must fail loud (not silently
  // proceed unlocked) while the first holder's lock is live.
  await assert.rejects(
    () =>
      withMemoryLock(lockPath, async () => {}, {
        staleMs: 30_000,
        timeoutMs: 50,
        pollMs: 10,
        now: () => new Date(),
        pid: 888888,
      }),
    /timed out/i,
  );

  releaseMemoryLock(lockPath, handle);
  assert.ok(!existsSync(lockPath));
});

test("a stale lock (dead pid) is broken and reclaimed rather than blocking forever", async () => {
  const dir = tmpDir();
  const lockPath = join(dir, "MEMORY.md.lock");
  // Simulate a crashed holder: a lockfile naming a pid that isn't alive.
  writeFileSync(lockPath, JSON.stringify({ pid: 999999999, acquired_at: new Date().toISOString() }));

  let ran = false;
  await withMemoryLock(
    lockPath,
    async () => {
      ran = true;
    },
    { staleMs: 30_000, timeoutMs: 2_000, pollMs: 10, now: () => new Date(), pid: process.pid, isPidAlive: () => false },
  );
  assert.ok(ran, "callback should have run after the stale lock was reclaimed");
});

test("a live-pid lock past the mtime staleness window is also reclaimed (mtime backstop)", async () => {
  const dir = tmpDir();
  const lockPath = join(dir, "MEMORY.md.lock");
  const oldAcquiredAt = new Date(Date.now() - 60_000).toISOString();
  // pid is "alive" per the injected check, but the lock is far older than
  // staleMs — covers a holder that's alive but wedged (e.g. hung forever on
  // an unrelated await), not just a dead process.
  writeFileSync(lockPath, JSON.stringify({ pid: 123, acquired_at: oldAcquiredAt }));

  let ran = false;
  await withMemoryLock(
    lockPath,
    async () => {
      ran = true;
    },
    { staleMs: 30_000, timeoutMs: 2_000, pollMs: 10, now: () => new Date(), pid: process.pid, isPidAlive: () => true },
  );
  assert.ok(ran, "callback should have run after the mtime-stale lock was reclaimed");
});

test("withMemoryLock throws loud on timeout rather than proceeding unlocked", async () => {
  const dir = tmpDir();
  const lockPath = join(dir, "MEMORY.md.lock");
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));

  let ran = false;
  await assert.rejects(
    () =>
      withMemoryLock(
        lockPath,
        async () => {
          ran = true;
        },
        { staleMs: 30_000, timeoutMs: 50, pollMs: 10, now: () => new Date(), pid: 42, isPidAlive: () => true },
      ),
    /timed out/i,
  );
  assert.equal(ran, false, "callback must never run when the lock could not be acquired");
});

test("withMemoryLock releases the lock even when the callback throws", async () => {
  const dir = tmpDir();
  const lockPath = join(dir, "MEMORY.md.lock");

  await assert.rejects(
    () =>
      withMemoryLock(
        lockPath,
        async () => {
          throw new Error("boom");
        },
        { staleMs: 30_000, timeoutMs: 2_000, pollMs: 10, now: () => new Date(), pid: process.pid },
      ),
    /boom/,
  );
  assert.ok(!existsSync(lockPath), "lockfile must be cleaned up after a callback failure");
});

test("withMemoryLock leaves no leftover files in the lock's directory", async () => {
  const dir = tmpDir();
  const lockPath = join(dir, "MEMORY.md.lock");
  await withMemoryLock(lockPath, async () => {}, { staleMs: 30_000, timeoutMs: 2_000, pollMs: 10, now: () => new Date(), pid: process.pid });
  assert.deepEqual(readdirSync(dir), []);
});
