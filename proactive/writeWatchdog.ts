#!/usr/bin/env -S npx tsx
// Writer CLI for the loop watchdog: emits a schema-valid
// ~/.rachel/loops/<slug>.watchdog.json entry for the bridge's checkWatchdogs
// consumer (bridge/telegram-bridge.ts). This is the ONLY sanctioned writer —
// prompts/system.md's loop-launcher flow invokes it instead of hand-authoring
// the JSON, because a hand-written file drifted from the schema once
// (started_at ISO string where the consumer reads spawn_time epoch ms) and
// silently produced "exited:undefined" dedup state while defeating
// hasFreshWakeFile's overlap check. Same drift-prevention pattern as
// proactive/memoryAppend.ts for MEMORY.md pointer lines.
//
// The WatchdogEntry import below is the enforcement mechanism: the entry is
// built as a typed object literal, so a future required field added to the
// interface becomes a typecheck failure HERE rather than silent drift.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WatchdogEntry } from "../bridge/telegram-bridge.ts";

// The slug becomes the filename (<slug>.watchdog.json) and the wake-file
// candidates (<slug>.json / <slug>.done), so it must be a plain filename
// fragment: no separators, no leading dot, no whitespace or control chars.
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// loop_name / expected_cmd / session_id are interpolated into ping text and
// state strings — a newline or CR there corrupts downstream formats.
const NEWLINE_RE = /[\n\r]/;
// pid as the consumer needs it: a plain positive integer.
const PID_RE = /^[1-9][0-9]*$/;

// Required flags map positionally onto WatchdogEntry's caller-supplied
// fields; everything else (spawn_time, last_check, wake_floor, pinged_at,
// done) is computed here — callers never pass a timestamp.
const REQUIRED_FLAGS = [
  "--slug",
  "--loop-name",
  "--pid",
  "--expected-cmd",
  "--repo",
  "--log-path",
  "--progress-json-glob",
] as const;
const OPTIONAL_FLAGS = ["--progress-json-path", "--session-id", "--dir"] as const;
const KNOWN_FLAGS: readonly string[] = [...REQUIRED_FLAGS, ...OPTIONAL_FLAGS];

// Path fields must be fully expanded absolute paths: Node's fs never expands
// `~`, and a relative path silently depends on the consumer's cwd. Reject
// loudly, never sanitise — a `~` here is the caller's real bug.
const PATH_FLAGS: readonly string[] = ["--repo", "--log-path", "--progress-json-glob", "--progress-json-path", "--dir"];

const USAGE =
  "[write-watchdog] usage: writeWatchdog.ts --slug <slug> --loop-name <name> --pid <pid> " +
  "--expected-cmd <cmd> --repo <abs-path> --log-path <abs-path> --progress-json-glob <abs-glob> " +
  "[--progress-json-path <abs-path>] [--session-id <id>] [--dir <abs-path>] " +
  "(spawn_time/last_check/wake_floor/pinged_at/done are computed, never passed)";

// Parses --flag value pairs. Returns the flag map, or an error string for
// anything malformed: unknown flag, missing value, duplicate, or a stray
// positional argument.
function parseFlags(args: string[]): Map<string, string> | string {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i] as string;
    if (!KNOWN_FLAGS.includes(flag)) {
      return `unknown argument: ${flag}`;
    }
    if (flags.has(flag)) {
      return `duplicate flag: ${flag}`;
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return `flag ${flag} is missing a value`;
    }
    flags.set(flag, value);
  }
  return flags;
}

// Returns the first problem found, or undefined when every flag value is safe
// to write into the entry. Reject, never sanitise.
function validateFlags(flags: Map<string, string>): string | undefined {
  for (const flag of REQUIRED_FLAGS) {
    if (!flags.has(flag)) return `missing required flag: ${flag}`;
  }
  const slug = flags.get("--slug") as string;
  if (!SLUG_RE.test(slug)) {
    return `invalid --slug ${JSON.stringify(slug)}: must match ${String(SLUG_RE)} (it becomes the watchdog filename)`;
  }
  const pid = flags.get("--pid") as string;
  if (!PID_RE.test(pid)) {
    return `invalid --pid ${JSON.stringify(pid)}: must be a positive integer`;
  }
  for (const flag of ["--loop-name", "--expected-cmd", "--session-id"]) {
    const value = flags.get(flag);
    if (value === undefined) continue;
    if (value === "" || NEWLINE_RE.test(value)) {
      return `invalid ${flag}: must be non-empty with no newline or carriage return`;
    }
  }
  for (const flag of PATH_FLAGS) {
    const value = flags.get(flag);
    if (value === undefined) continue;
    if (!value.startsWith("/") || NEWLINE_RE.test(value)) {
      return `invalid ${flag} ${JSON.stringify(value)}: must be a fully expanded absolute path (no ~, no relative paths — Node fs never expands ~)`;
    }
  }
  return undefined;
}

// The typed literal that makes schema drift a typecheck failure: a 15th
// required field on WatchdogEntry breaks this assignment.
function buildEntry(flags: Map<string, string>, spawnTime: number): WatchdogEntry {
  return {
    slug: flags.get("--slug") as string,
    loop_name: flags.get("--loop-name") as string,
    pid: Number(flags.get("--pid")),
    expected_cmd: flags.get("--expected-cmd") as string,
    repo: flags.get("--repo") as string,
    log_path: flags.get("--log-path") as string,
    progress_json_glob: flags.get("--progress-json-glob") as string,
    progress_json_path: flags.get("--progress-json-path") ?? null,
    session_id: flags.get("--session-id") ?? null,
    spawn_time: spawnTime,
    last_check: null,
    wake_floor: null,
    pinged_at: null,
    done: false,
  };
}

export async function cliMain(argv: string[]): Promise<number> {
  const parsed = parseFlags(argv.slice(2));
  if (typeof parsed === "string") {
    console.error(`[write-watchdog] ${parsed}\n${USAGE}`);
    return 2;
  }
  const problem = validateFlags(parsed);
  if (problem !== undefined) {
    console.error(`[write-watchdog] ${problem}\n${USAGE}`);
    return 2;
  }
  const entry = buildEntry(parsed, Date.now());
  const dir = parsed.get("--dir") ?? join(homedir(), ".rachel", "loops");
  const path = join(dir, `${entry.slug}.watchdog.json`);
  try {
    mkdirSync(dir, { recursive: true });
    // House atomic-write idiom: temp file + same-dir rename, so the bridge's
    // poll loop can never read a half-written entry.
    const tmpPath = `${path}.tmp.${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify(entry, null, 2) + "\n");
    renameSync(tmpPath, path);
    console.log(`[write-watchdog] wrote ${path} (spawn_time=${entry.spawn_time})`);
    return 0;
  } catch (err) {
    console.error(`[write-watchdog] ${err instanceof Error ? err.stack ?? String(err) : String(err)}`);
    return 1;
  }
}

// Only run as a CLI when executed directly, not when imported by a test —
// same guard as memoryAppend.ts/push.ts/sweep.ts. MUST stay the last
// statement in this module (SO-4): the top-level await runs during module
// evaluation, so any `const` declared below it would be in its temporal dead
// zone for every CLI code path.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await cliMain(process.argv));
}
