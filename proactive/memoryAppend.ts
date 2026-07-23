#!/usr/bin/env -S npx tsx
// Locked consumer of proactive/memoryLock.ts: appends one pointer line to
// MEMORY.md under the mutex, so concurrent writers (the interactive CLI, the
// Telegram bridge, headless one-shots) never lose each other's updates. This
// is the ONLY writer of pointer lines that goes through the lock — see the
// module header on memoryLock.ts for why a lock nothing calls would be dead
// code. prompts/system.md's Memory contract instructs Rachel to invoke this
// CLI for index writes instead of a freehand Write tool call. That routing
// is a PROMPT CONTRACT, not code-enforced: a freehand Write still bypasses
// the lock entirely, same trust class as the ad-hoc-backgrounding
// constraints block. PR #64's write-gate hook is a plausible future place to
// enforce this in code (block a raw Write to MEMORY.md, require this CLI
// instead) — not built here since that PR is a sibling, not a dependency.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveMemoryPath } from "./memoryIndex.ts";
import { withMemoryLock } from "./memoryLock.ts";
import type { WithLockOptions } from "./memoryLock.ts";

const DEFAULT_HEADER = "# Memory Index\n\n";

// No newline/CR in any argument: the index format is one pointer line per
// entry, and a newline in title/hook (or a bare filename) writes a SECOND
// line that parses as a legitimate-looking pointer to an arbitrary file —
// the same injection class as PR #63's bracketed-title parser bug, now on
// the write side. `]`/`(`/`)` are rejected in title/hook for the same
// reason: `- [Title](file.md) — hook` is a fixed positional format, and any
// of those characters inside title/hook can close the markdown link early
// or splice in a fake `](...)` pointer. Loud rejection, not silent
// sanitisation — a caller passing a newline has a real bug worth surfacing,
// and quietly stripping/escaping would silently write something other than
// what was asked for.
const FORBIDDEN_IN_TEXT_RE = /[\n\r[\]()]/;
// file must be a bare "*.md" filename: no path separators (no traversal
// outside ~/.rachel/memory/), no brackets/parens (same pointer-line
// injection risk as above).
const VALID_FILE_RE = /^[^/\\\n\r[\]()]+\.md$/;

export interface ValidationError {
  field: "title" | "file" | "hook";
  reason: string;
}

// Pure validator, exported for the CLI's argument check — returns the first
// problem found, or undefined when all three arguments are safe to format
// into a pointer line.
export function validatePointerArgs(title: string, file: string, hook: string): ValidationError | undefined {
  if (FORBIDDEN_IN_TEXT_RE.test(title)) {
    return { field: "title", reason: "must not contain a newline, carriage return, or [ ] ( )" };
  }
  if (!VALID_FILE_RE.test(file)) {
    return { field: "file", reason: "must be a bare *.md filename with no path separators or [ ] ( )" };
  }
  if (FORBIDDEN_IN_TEXT_RE.test(hook)) {
    return { field: "hook", reason: "must not contain a newline, carriage return, or [ ] ( )" };
  }
  return undefined;
}

function formatPointerLine(title: string, file: string, hook: string): string {
  return `- [${title}](${file}) — ${hook}`;
}

// Absent-is-empty is the documented contract for this store (matches
// memoryIndex.ts's composeSystemPrompt): a missing index is a fresh file
// with the standard header, not an error.
function readIndex(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_HEADER;
    }
    throw new Error(`cannot read memory index ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Appends one pointer line under the memory lock. The read-modify-write
// happens entirely INSIDE the locked callback — reading outside the lock
// would reopen the exact race this module exists to close.
export async function appendMemoryPointer(
  path: string,
  title: string,
  file: string,
  hook: string,
  lockOpts: WithLockOptions,
): Promise<void> {
  const lockPath = `${path}.lock`;
  await withMemoryLock(
    lockPath,
    async () => {
      const before = readIndex(path);
      const separator = before.endsWith("\n") || before === "" ? "" : "\n";
      const next = `${before}${separator}${formatPointerLine(title, file, hook)}\n`;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, next);
    },
    lockOpts,
  );
}

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 50;

export interface CliOverrides {
  memoryPath?: string;
  staleMs?: number;
  timeoutMs?: number;
  pollMs?: number;
}

const USAGE = "[memory-append] usage: memoryAppend.ts <title> <file> <hook> (exactly three arguments)";

// CLI contract: exactly three positional arguments, matching push.ts's
// fixed-arity convention — title, the pointer's target filename, and the
// one-line hook shown in the index. No message-file indirection here (push.ts
// uses a file for multi-line/shell-unsafe text); a memory hook is a single
// short line by contract (prompts/system.md), so argv is fine.
export async function cliMain(argv: string[], overrides?: CliOverrides): Promise<number> {
  const args = argv.slice(2);
  if (args.length !== 3) {
    console.error(USAGE);
    return 2;
  }
  const [title, file, hook] = args as [string, string, string];
  const memoryPath = overrides?.memoryPath ?? resolveMemoryPath();
  const lockOpts: WithLockOptions = {
    staleMs: overrides?.staleMs ?? DEFAULT_STALE_MS,
    timeoutMs: overrides?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    pollMs: overrides?.pollMs ?? DEFAULT_POLL_MS,
    now: () => new Date(),
    pid: process.pid,
  };
  try {
    await appendMemoryPointer(memoryPath, title, file, hook, lockOpts);
    console.log(`[memory-append] appended "${title}" -> ${file}`);
    return 0;
  } catch (err) {
    console.error(`[memory-append] ${err instanceof Error ? err.stack ?? String(err) : String(err)}`);
    return 1;
  }
}

// Only run as a CLI when executed directly, not when imported by a test —
// same guard as push.ts/sweep.ts/notify.ts/rachel.ts. MUST stay the last
// statement in this module (same layout as push.ts/sweep.ts): the top-level
// await runs during module evaluation, so any `const` declared below it
// would be in its temporal dead zone for every CLI code path.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await cliMain(process.argv));
}
