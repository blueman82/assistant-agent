// Tests for the memoryAppend CLI: the locked consumer of proactive/memoryLock.ts.
// Rachel is instructed (prompts/system.md) to route MEMORY.md pointer-line
// writes through this CLI instead of a freehand Write, so the lock actually
// guards real traffic. See memoryLock.test.ts for the primitive-level and
// lost-update proofs; these tests cover the CLI's own argument handling,
// the append shape, and that it genuinely goes through the lock (a second
// concurrent call blocks/serializes rather than racing).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMemoryPointer, cliMain } from "./memoryAppend.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rachel-test-memappend-"));
}

test("appendMemoryPointer creates the index with a header when absent", async () => {
  const dir = tmpDir();
  const path = join(dir, "MEMORY.md");
  await appendMemoryPointer(path, "Units preference", "units-preference.md", "Gary uses metric.", {
    staleMs: 30_000,
    timeoutMs: 2_000,
    pollMs: 10,
    now: () => new Date(),
    pid: process.pid,
  });
  const content = readFileSync(path, "utf8");
  assert.equal(content, "# Memory Index\n\n- [Units preference](units-preference.md) — Gary uses metric.\n");
});

test("appendMemoryPointer appends to an existing index without disturbing prior lines", async () => {
  const dir = tmpDir();
  const path = join(dir, "MEMORY.md");
  writeFileSync(path, "# Memory Index\n\n- [Existing](existing.md) — an existing fact.\n");
  await appendMemoryPointer(path, "New fact", "new-fact.md", "a new fact.", {
    staleMs: 30_000,
    timeoutMs: 2_000,
    pollMs: 10,
    now: () => new Date(),
    pid: process.pid,
  });
  const content = readFileSync(path, "utf8");
  assert.equal(
    content,
    "# Memory Index\n\n- [Existing](existing.md) — an existing fact.\n- [New fact](new-fact.md) — a new fact.\n",
  );
});

test("appendMemoryPointer cleans up its lockfile after a successful append", async () => {
  const dir = tmpDir();
  const path = join(dir, "MEMORY.md");
  await appendMemoryPointer(path, "Title", "file.md", "hook.", {
    staleMs: 30_000,
    timeoutMs: 2_000,
    pollMs: 10,
    now: () => new Date(),
    pid: process.pid,
  });
  assert.ok(!existsSync(`${path}.lock`));
});

test("two concurrent appendMemoryPointer calls both survive (the lock's real payoff)", async () => {
  const dir = tmpDir();
  const path = join(dir, "MEMORY.md");
  writeFileSync(path, "# Memory Index\n\n");
  const lockOpts = { staleMs: 30_000, timeoutMs: 5_000, pollMs: 5, now: () => new Date(), pid: process.pid };
  await Promise.all([
    appendMemoryPointer(path, "A", "a.md", "fact a.", lockOpts),
    appendMemoryPointer(path, "B", "b.md", "fact b.", lockOpts),
  ]);
  const content = readFileSync(path, "utf8");
  assert.ok(content.includes("- [A](a.md) — fact a."), `A missing: ${content}`);
  assert.ok(content.includes("- [B](b.md) — fact b."), `B missing: ${content}`);
});

test("cliMain rejects an argument count other than three", async () => {
  const dir = tmpDir();
  const path = join(dir, "MEMORY.md");
  const exitCode = await cliMain(["node", "memoryAppend.ts", "Title only"], { memoryPath: path });
  assert.equal(exitCode, 2);
  assert.ok(!existsSync(path));
});

test("cliMain appends via argv title/file/hook and exits 0", async () => {
  const dir = tmpDir();
  const path = join(dir, "MEMORY.md");
  const exitCode = await cliMain(["node", "memoryAppend.ts", "Title", "title.md", "the hook text."], { memoryPath: path });
  assert.equal(exitCode, 0);
  const content = readFileSync(path, "utf8");
  assert.ok(content.includes("- [Title](title.md) — the hook text."));
});

test("cliMain exits 1 and reports the error when the lock cannot be acquired", async () => {
  const dir = tmpDir();
  const path = join(dir, "MEMORY.md");
  writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));
  const exitCode = await cliMain(["node", "memoryAppend.ts", "Title", "title.md", "hook."], {
    memoryPath: path,
    timeoutMs: 50,
    pollMs: 10,
  });
  assert.equal(exitCode, 1);
});

// --- Critical 1: input sanitisation (reviewer-found, confirmed reproduced) ---
// A newline in `title` writes a SECOND line into the index that parses as a
// legitimate-looking pointer to an arbitrary file — the same bug class as
// PR #63's bracketed-title parser bug, now on the write side. The lock does
// its job (the corrupt write is still atomic and race-free); the bug is that
// nothing validates the argument shape before formatting the pointer line.
test("cliMain rejects a newline in title rather than injecting a second line", async () => {
  const dir = tmpDir();
  const path = join(dir, "MEMORY.md");
  const exitCode = await cliMain(["node", "memoryAppend.ts", "Evil\n- [Fake](x.md) — injected", "a.md", "hook"], {
    memoryPath: path,
  });
  assert.equal(exitCode, 2, "must reject loudly, not silently sanitise or succeed");
  assert.ok(!existsSync(path), "index must be untouched — no partial or corrupt write");
});

test("cliMain rejects a carriage return in hook", async () => {
  const dir = tmpDir();
  const path = join(dir, "MEMORY.md");
  const exitCode = await cliMain(["node", "memoryAppend.ts", "Title", "a.md", "hook\r\n- [Fake](x.md) — injected"], {
    memoryPath: path,
  });
  assert.equal(exitCode, 2);
  assert.ok(!existsSync(path));
});

test("cliMain rejects brackets/parens in title that would break the pointer-line format", async () => {
  const dir = tmpDir();
  const path = join(dir, "MEMORY.md");
  const exitCode = await cliMain(["node", "memoryAppend.ts", "Title](evil.md) — [Injected", "a.md", "hook"], {
    memoryPath: path,
  });
  assert.equal(exitCode, 2);
  assert.ok(!existsSync(path));
});

test("cliMain rejects a file argument that is not a bare *.md filename", async () => {
  const dir = tmpDir();
  const path = join(dir, "MEMORY.md");
  const exitCode = await cliMain(["node", "memoryAppend.ts", "Title", "../../etc/passwd", "hook"], {
    memoryPath: path,
  });
  assert.equal(exitCode, 2);
  assert.ok(!existsSync(path));
});

test("cliMain rejects parens/brackets in the file argument", async () => {
  const dir = tmpDir();
  const path = join(dir, "MEMORY.md");
  const exitCode = await cliMain(["node", "memoryAppend.ts", "Title", "a)(b.md", "hook"], { memoryPath: path });
  assert.equal(exitCode, 2);
  assert.ok(!existsSync(path));
});

// --- Critical 2: first-ever write on a fresh install (reviewer-found, confirmed reproduced) ---
// mkdirSync lived INSIDE the locked callback, but the lockfile is created at
// <path>.lock in that same not-yet-existent directory — so the lock's own
// openSync throws ENOENT before the callback (and its mkdirSync) ever runs.
// withMemoryLock's poll loop swallowed that ENOENT as ordinary contention and
// busy-polled the full timeout before failing with a misleading "timed out".
test("appendMemoryPointer succeeds promptly when the memory directory does not exist yet", async () => {
  const dir = tmpDir();
  const path = join(dir, "does-not-exist-yet", "MEMORY.md");
  assert.ok(!existsSync(join(dir, "does-not-exist-yet")), "precondition: parent dir must not exist yet");
  const start = Date.now();
  await appendMemoryPointer(path, "First Fact", "first.md", "a hook", {
    staleMs: 30_000,
    timeoutMs: 10_000,
    pollMs: 50,
    now: () => new Date(),
    pid: process.pid,
  });
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 2_000, `expected a prompt success, took ${elapsedMs}ms (fresh-install regression would take ~10s and throw)`);
  const content = readFileSync(path, "utf8");
  assert.ok(content.includes("- [First Fact](first.md) — a hook"));
});

// Control: confirms the fix didn't break the ordinary already-exists path.
test("appendMemoryPointer still succeeds normally when the memory directory already exists", async () => {
  const dir = tmpDir();
  const path = join(dir, "MEMORY.md");
  writeFileSync(path, "# Memory Index\n\n");
  await appendMemoryPointer(path, "Normal", "normal.md", "a normal fact.", {
    staleMs: 30_000,
    timeoutMs: 2_000,
    pollMs: 10,
    now: () => new Date(),
    pid: process.pid,
  });
  const content = readFileSync(path, "utf8");
  assert.ok(content.includes("- [Normal](normal.md) — a normal fact."));
});
