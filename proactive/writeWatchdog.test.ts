// Tests for the writeWatchdog CLI: the single writer of
// ~/.rachel/loops/<slug>.watchdog.json entries. The schema lives in
// bridge/telegram-bridge.ts's WatchdogEntry interface; a hand-written file
// drifted from it once (started_at ISO string where the consumer reads
// spawn_time epoch ms) and silently produced "exited:undefined" dedup state
// while defeating hasFreshWakeFile's overlap check. These tests therefore
// include ROUND-TRIP coverage: the file the real CLI subprocess writes is fed
// through the bridge's actual checkWatchdogs consumer, not just re-parsed by
// the producer's own code.

// Defense-in-depth (same posture as telegram-bridge.test.ts): every bridge
// constructed here injects a stub transport, so global fetch must never be
// reached. If any code path falls back to it, throw instead of making a live
// HTTP call.
globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
  throw new Error(`Unexpected real fetch() call in writeWatchdog.test.ts — all transports must be stubbed. Called with: ${String(args[0])}`);
}) as typeof fetch;

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliMain } from "./writeWatchdog.ts";
import { createBridge, defaultFsFn, type WatchdogEntry } from "../bridge/telegram-bridge.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const cliPath = join(repoRoot, "proactive", "writeWatchdog.ts");

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rachel-test-writewatchdog-"));
}

// The full required flag set plus --dir, targeting a throwaway dir. Tests mutate copies.
function validArgs(dir: string, slug = "rt-loop"): string[] {
  return [
    "--slug", slug,
    "--loop-name", "Round Trip Loop",
    "--pid", "99999",
    "--expected-cmd", "claude",
    "--repo", "/Users/harrison/Github/test-repo",
    "--log-path", "/tmp/rt-loop.log",
    "--progress-json-glob", "/fake/.claude/agentic-loop/*test-repo*/*/progress.json",
    "--dir", dir,
  ];
}

function runInProcess(args: string[]): Promise<number> {
  return cliMain(["node", "writeWatchdog.ts", ...args]);
}

// Real subprocess — catches the SO-4 TDZ crash class (a const declared below
// the import.meta CLI guard) that in-process cliMain calls can never see.
// spawnSync's own failure (res.error: ENOENT, timeout kill, ...) is folded
// into stderr so assertion messages show WHY the spawn failed, not just -1.
function runCliSubprocess(args: string[], scriptPath = cliPath): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(tsxBin, [scriptPath, ...args], { encoding: "utf8", timeout: 60_000 });
  const spawnError = res.error ? `\n[spawnSync error] ${String(res.error)}` : "";
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: (res.stderr ?? "") + spawnError };
}

const ALL_14_FIELDS = [
  "slug", "loop_name", "pid", "expected_cmd", "repo", "log_path",
  "progress_json_glob", "progress_json_path", "session_id", "spawn_time",
  "last_check", "wake_floor", "pinged_at", "done",
].sort();

// ---------------------------------------------------------------------------
// Producer shape (in-process)
// ---------------------------------------------------------------------------

test("cliMain writes a watchdog file carrying exactly the 14 WatchdogEntry fields with computed defaults", async () => {
  const dir = tmpDir();
  const before = Date.now();
  const exitCode = await runInProcess(validArgs(dir));
  const after = Date.now();
  assert.equal(exitCode, 0);

  const entry = JSON.parse(readFileSync(join(dir, "rt-loop.watchdog.json"), "utf8")) as WatchdogEntry;
  assert.deepEqual(Object.keys(entry).sort(), ALL_14_FIELDS);
  assert.equal(entry.slug, "rt-loop");
  assert.equal(entry.loop_name, "Round Trip Loop");
  assert.equal(entry.pid, 99999);
  assert.equal(entry.expected_cmd, "claude");
  assert.equal(entry.repo, "/Users/harrison/Github/test-repo");
  assert.equal(entry.log_path, "/tmp/rt-loop.log");
  assert.equal(entry.progress_json_glob, "/fake/.claude/agentic-loop/*test-repo*/*/progress.json");
  // The exact drift that shipped: spawn_time must be epoch ms computed by the
  // CLI itself, never an ISO string.
  assert.equal(typeof entry.spawn_time, "number");
  assert.ok(entry.spawn_time >= before && entry.spawn_time <= after, `spawn_time ${entry.spawn_time} outside [${before}, ${after}]`);
  assert.equal(entry.progress_json_path, null);
  assert.equal(entry.session_id, null);
  assert.equal(entry.last_check, null);
  assert.equal(entry.wake_floor, null);
  assert.equal(entry.pinged_at, null);
  assert.equal(entry.done, false);
});

test("cliMain carries optional --progress-json-path and --session-id through when given", async () => {
  const dir = tmpDir();
  const exitCode = await runInProcess([
    ...validArgs(dir),
    "--progress-json-path", "/fake/progress.json",
    "--session-id", "abc-123",
  ]);
  assert.equal(exitCode, 0);
  const entry = JSON.parse(readFileSync(join(dir, "rt-loop.watchdog.json"), "utf8")) as WatchdogEntry;
  assert.equal(entry.progress_json_path, "/fake/progress.json");
  assert.equal(entry.session_id, "abc-123");
});

test("cliMain overwrites an existing entry wholesale on relaunch, re-arming spawn_time and updating pid", async () => {
  const dir = tmpDir();
  assert.equal(await runInProcess(validArgs(dir)), 0);
  const first = JSON.parse(readFileSync(join(dir, "rt-loop.watchdog.json"), "utf8")) as WatchdogEntry;
  // Date.now() has ms granularity — the pause makes spawn_time re-arming
  // observable as a strict increase.
  await new Promise((r) => setTimeout(r, 10));
  const relaunchArgs = validArgs(dir).map((a, i, all) => (all[i - 1] === "--pid" ? "11111" : a));
  assert.equal(await runInProcess(relaunchArgs), 0);
  const second = JSON.parse(readFileSync(join(dir, "rt-loop.watchdog.json"), "utf8")) as WatchdogEntry;
  assert.deepEqual(Object.keys(second).sort(), ALL_14_FIELDS);
  assert.equal(second.pid, 11111, "the relaunch's pid must win");
  assert.ok(
    second.spawn_time > first.spawn_time,
    `spawn_time must be re-armed by the relaunch: ${second.spawn_time} vs ${first.spawn_time}`,
  );
  assert.equal(second.done, false);
});

test("cliMain creates the target directory when it does not exist yet", async () => {
  const dir = join(tmpDir(), "does-not-exist-yet");
  assert.ok(!existsSync(dir), "precondition: dir must not exist");
  const exitCode = await runInProcess(validArgs(dir));
  assert.equal(exitCode, 0);
  assert.ok(existsSync(join(dir, "rt-loop.watchdog.json")));
});

// ---------------------------------------------------------------------------
// Validation: reject, never sanitise (exit 2, no file written)
// ---------------------------------------------------------------------------

test("cliMain rejects a missing required flag", async () => {
  const dir = tmpDir();
  const args = validArgs(dir).filter((a, i, all) => a !== "--pid" && all[i - 1] !== "--pid");
  const exitCode = await runInProcess(args);
  assert.equal(exitCode, 2);
  assert.ok(!existsSync(join(dir, "rt-loop.watchdog.json")));
});

test("cliMain rejects an unknown flag", async () => {
  const dir = tmpDir();
  const exitCode = await runInProcess([...validArgs(dir), "--spawn-time", "123"]);
  assert.equal(exitCode, 2, "callers never pass a timestamp — the CLI computes spawn_time itself");
  assert.ok(!existsSync(join(dir, "rt-loop.watchdog.json")));
});

test("cliMain rejects a duplicate flag", async () => {
  const dir = tmpDir();
  const exitCode = await runInProcess([...validArgs(dir), "--pid", "12345"]);
  assert.equal(exitCode, 2);
  assert.ok(!existsSync(join(dir, "rt-loop.watchdog.json")));
});

test("cliMain rejects a pid past Number.MAX_SAFE_INTEGER rather than silently rounding it", async () => {
  const dir = tmpDir();
  // 2^53 + 1: passes the digits-only regex, but Number() would round it.
  const args = validArgs(dir).map((a, i, all) => (all[i - 1] === "--pid" ? "9007199254740993" : a));
  const exitCode = await runInProcess(args);
  assert.equal(exitCode, 2);
  assert.ok(!existsSync(join(dir, "rt-loop.watchdog.json")));
});

test("cliMain rejects a non-numeric pid", async () => {
  const dir = tmpDir();
  const args = validArgs(dir).map((a, i, all) => (all[i - 1] === "--pid" ? "abc" : a));
  const exitCode = await runInProcess(args);
  assert.equal(exitCode, 2);
  assert.ok(!existsSync(join(dir, "rt-loop.watchdog.json")));
});

test("cliMain rejects an unexpanded ~ path where the schema demands fully expanded absolute paths", async () => {
  const dir = tmpDir();
  const args = validArgs(dir).map((a, i, all) => (all[i - 1] === "--repo" ? "~/Github/test-repo" : a));
  const exitCode = await runInProcess(args);
  assert.equal(exitCode, 2, "Node fs never expands ~ — a ~ path must be rejected loudly, not written");
  assert.ok(!existsSync(join(dir, "rt-loop.watchdog.json")));
});

test("cliMain rejects a relative log path", async () => {
  const dir = tmpDir();
  const args = validArgs(dir).map((a, i, all) => (all[i - 1] === "--log-path" ? "loops/rt-loop.log" : a));
  const exitCode = await runInProcess(args);
  assert.equal(exitCode, 2);
  assert.ok(!existsSync(join(dir, "rt-loop.watchdog.json")));
});

test("cliMain rejects a slug containing a path separator", async () => {
  const dir = tmpDir();
  const args = validArgs(dir).map((a, i, all) => (all[i - 1] === "--slug" ? "../evil" : a));
  const exitCode = await runInProcess(args);
  assert.equal(exitCode, 2, "the slug becomes the filename — a separator escapes the watchdog dir");
});

test("cliMain rejects a newline in loop-name rather than writing it into ping text", async () => {
  const dir = tmpDir();
  const args = validArgs(dir).map((a, i, all) => (all[i - 1] === "--loop-name" ? "Evil\nLoop" : a));
  const exitCode = await runInProcess(args);
  assert.equal(exitCode, 2);
  assert.ok(!existsSync(join(dir, "rt-loop.watchdog.json")));
});

// ---------------------------------------------------------------------------
// Real subprocess (SO-4: TDZ crash class is invisible to in-process calls)
// ---------------------------------------------------------------------------

test("the CLI run as a real subprocess exits 0 and writes the file", () => {
  const dir = tmpDir();
  const { status, stdout, stderr } = runCliSubprocess(validArgs(dir));
  assert.equal(status, 0, `expected exit 0, got ${status}; stderr: ${stderr}`);
  assert.ok(stdout.includes("rt-loop.watchdog.json"), `stdout should name the written file, got: ${stdout}`);
  assert.ok(existsSync(join(dir, "rt-loop.watchdog.json")));
});

test("the CLI run as a real subprocess exits 2 on invalid input without writing", () => {
  const dir = tmpDir();
  const args = validArgs(dir).map((a, i, all) => (all[i - 1] === "--pid" ? "not-a-pid" : a));
  const { status, stderr } = runCliSubprocess(args);
  assert.equal(status, 2, `expected exit 2, got ${status}; stderr: ${stderr}`);
  assert.ok(!existsSync(join(dir, "rt-loop.watchdog.json")));
});

// ---------------------------------------------------------------------------
// ROUND-TRIP: the CLI's real output file through the bridge's real consumer
// ---------------------------------------------------------------------------

// Stub Telegram transport, same shape as telegram-bridge.test.ts's: answers
// getUpdates with an empty batch, everything else ok:true, records calls.
function makeStubTransport() {
  const calls: { url: string; body: unknown }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    if (url.includes("/getUpdates")) {
      return { ok: true, json: async () => ({ ok: true, result: [] }) } as Response;
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };
  return { transport, calls };
}

// 12:00 Dublin in summer — outside the 22:30-08:00 quiet window, so the exit
// ping delivers immediately instead of deferring to the digest.
const DAYTIME = () => new Date("2026-07-15T11:00:00Z");

interface RoundTripSetup {
  base: string;
  watchdogDir: string;
  wakeDir: string;
  watchdogPath: string;
  entry: WatchdogEntry;
}

// Writes the watchdog file via the REAL CLI subprocess — never via internals.
function writeViaRealCli(slug: string): RoundTripSetup {
  const base = tmpDir();
  const watchdogDir = join(base, "loops");
  const wakeDir = join(base, "wake");
  mkdirSync(wakeDir, { recursive: true });
  const { status, stderr } = runCliSubprocess(validArgs(watchdogDir, slug));
  assert.equal(status, 0, `CLI subprocess failed: ${stderr}`);
  const watchdogPath = join(watchdogDir, `${slug}.watchdog.json`);
  const entry = JSON.parse(readFileSync(watchdogPath, "utf8")) as WatchdogEntry;
  return { base, watchdogDir, wakeDir, watchdogPath, entry };
}

async function runOneWatchdogPoll(setup: RoundTripSetup) {
  const { transport, calls } = makeStubTransport();
  const bridge = createBridge({
    config: { token: "t", chatId: "12345", transport },
    runTurn: async () => {},
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    watchdogDir: setup.watchdogDir,
    wakeDir: setup.wakeDir,
    fsFn: defaultFsFn(),               // the REAL fs — reads the CLI's real file
    isPidAliveFn: () => false,         // the loop has exited
    pushBaseDir: join(setup.base, "proactive"),
    heartbeatPath: join(setup.base, "bridge-heartbeat.json"),
    nowFn: DAYTIME,
  });
  await bridge.drainOnce();
  await bridge.stop();
  return calls;
}

test("round-trip: a CLI-written file drives checkWatchdogs to a numeric-spawn_time exit ping, never exited:undefined", async () => {
  const setup = writeViaRealCli("rt-exit-loop");
  const calls = await runOneWatchdogPoll(setup);

  const sent = calls
    .filter((c) => c.url.includes("/sendMessage"))
    .map((c) => String((c.body as Record<string, unknown>)["text"]));
  assert.ok(
    sent.some((s) => s.includes('Loop "Round Trip Loop"') && s.includes("has exited")),
    `expected a delivered exit ping, got: ${JSON.stringify(sent)}`,
  );

  // The dedup state must carry the CLI's numeric spawn_time — the original
  // hand-written file produced state "exited:undefined" here.
  const store = JSON.parse(readFileSync(join(setup.base, "proactive", "loop-watchdog.json"), "utf8")) as {
    events: Record<string, { state: string }>;
  };
  const recorded = store.events["loop-exit:rt-exit-loop"];
  assert.ok(recorded, `loop-exit event missing from store: ${JSON.stringify(store.events)}`);
  assert.equal(typeof setup.entry.spawn_time, "number");
  assert.equal(recorded.state, `exited:${setup.entry.spawn_time}`);
  assert.ok(!recorded.state.includes("undefined"), `dedup state regressed to: ${recorded.state}`);

  // Consumed: the exit ping must not re-fire on every subsequent poll.
  assert.ok(!existsSync(setup.watchdogPath), "watchdog file must be consumed after the exit ping");
});

test("round-trip: hasFreshWakeFile's overlap check actually works against a CLI-written spawn_time", async () => {
  const setup = writeViaRealCli("rt-wake-loop");
  // The loop reported for itself: a consumed wake file newer than spawn_time.
  // (.done is invisible to checkWakeFiles but counted by hasFreshWakeFile.)
  // With the old hand-written file spawn_time was undefined, mtimeMs >
  // undefined was always false, and this suppression never happened.
  writeFileSync(join(setup.wakeDir, "rt-wake-loop.done"), JSON.stringify({ id: "rt-wake-loop" }));
  const calls = await runOneWatchdogPoll(setup);

  const sent = calls
    .filter((c) => c.url.includes("/sendMessage"))
    .map((c) => String((c.body as Record<string, unknown>)["text"]));
  assert.ok(
    !sent.some((s) => s.includes("has exited")),
    `exit ping must be suppressed by the fresh wake file, got: ${JSON.stringify(sent)}`,
  );
  // Still consumed — suppression must not leave the entry to re-evaluate forever.
  assert.ok(!existsSync(setup.watchdogPath), "watchdog file must be consumed even when the ping is suppressed");
});
