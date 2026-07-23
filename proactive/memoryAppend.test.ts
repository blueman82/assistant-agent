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
