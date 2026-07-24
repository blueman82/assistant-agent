import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultExecFn, sweepTick } from "./sweep.ts";
import type { SweepDeps } from "./sweep.ts";
import type { Severity } from "./push.ts";

// Dublin 12:00 in summer (IST = UTC+1) — outside the default quiet window,
// and past the 8 and 11 entries of the default calendar_oneshot_hours.
const DAYTIME = () => new Date("2026-07-15T11:00:00Z");

const RUNNING_STDOUT = "com.rachel.telegram-bridge = {\n\tstate = running\n\tprogram = /usr/bin/env\n}";

interface PushCall {
  family: string;
  eventId: string;
  state: string;
  severity: Severity;
  text: string;
}

interface ExecCall {
  cmd: string;
  args: string[];
  opts?: { env?: Record<string, string>; stdinNull?: boolean; timeoutMs?: number };
}

// Fully-stubbed harness: no real gh, launchctl, Telegram, or filesystem
// outside the mkdtemp baseDir. Default config disables the pr-red and
// calendar families so each test exercises exactly one behaviour.
function makeHarness(config: object = { calendar_oneshot_hours: [], pr_watch_repos: [] }) {
  const baseDir = mkdtempSync(join(tmpdir(), "rachel-sweep-test-"));
  const homeDir = mkdtempSync(join(tmpdir(), "rachel-sweep-home-"));
  writeFileSync(join(baseDir, "config.json"), JSON.stringify(config));
  const order: string[] = [];
  const pushes: PushCall[] = [];
  const logs: string[] = [];
  const execCalls: ExecCall[] = [];
  const getStateCalls: Array<{ family: string; eventId: string }> = [];
  const files = new Map<string, string>();
  const deps: SweepDeps = {
    now: DAYTIME,
    execFn: async (cmd, args, opts) => {
      order.push(`exec:${cmd}`);
      execCalls.push({ cmd, args, opts });
      return { stdout: RUNNING_STDOUT, stderr: "", exitCode: 0 };
    },
    oneshotTimeoutMs: 1000,
    pushFn: async (family, eventId, state, severity, text) => {
      order.push(`push:${family}`);
      pushes.push({ family, eventId, state, severity, text });
      return "sent";
    },
    flushFn: async () => {
      order.push("flush");
      return "empty";
    },
    getStateFn: (family, eventId) => {
      getStateCalls.push({ family, eventId });
      return undefined;
    },
    statMtimeFn: () => new Date(DAYTIME().getTime() - 23 * 60_000),
    readFileFn: (path) => files.get(path),
    writeFileFn: (path, content) => {
      files.set(path, content);
    },
    lintFn: () => [],
    baseDir,
    homeDir,
    repoDir: "/repo",
    log: (line) => logs.push(line),
  };
  return { deps, order, pushes, logs, execCalls, getStateCalls, files, baseDir, homeDir };
}

test("tick calls flushFn before any execFn call", async () => {
  const h = makeHarness();
  await sweepTick(h.deps);
  assert.equal(h.order[0], "flush");
  assert.ok(h.order.some((entry) => entry === "exec:launchctl"), "launchctl was consulted after the flush");
});

test("bridge-liveness queries launchctl print for the gui domain bridge job", async () => {
  const h = makeHarness();
  await sweepTick(h.deps);
  const call = h.execCalls.find((c) => c.cmd === "launchctl");
  assert.ok(call, "launchctl was invoked");
  assert.equal(call.args[0], "print");
  assert.match(call.args[1] ?? "", /^gui\/\d+\/com\.rachel\.telegram-bridge$/);
});

test("launchctl exit 1 pushes one urgent bridge-down event", async () => {
  const h = makeHarness();
  h.deps.execFn = async (cmd, args, opts) => {
    h.order.push(`exec:${cmd}`);
    return { stdout: "", stderr: "Could not find service", exitCode: 1 };
  };
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 1);
  const p = h.pushes[0]!;
  assert.equal(p.family, "bridge-liveness");
  assert.equal(p.eventId, "bridge:liveness");
  assert.equal(p.state, "down");
  assert.equal(p.severity, "urgent");
  assert.ok(p.text.startsWith("[urgent · bridge]"), `text starts with the urgent bridge tag: ${p.text}`);
});

test("launchctl exit 0 without 'state = running' in stdout is also down", async () => {
  const h = makeHarness();
  h.deps.execFn = async () => ({ stdout: "com.rachel.telegram-bridge = {\n\tstate = waiting\n}", stderr: "", exitCode: 0 });
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 1);
  assert.equal(h.pushes[0]!.state, "down");
});

test("bridge-down text carries the log mtime age when the log exists", async () => {
  const h = makeHarness();
  h.deps.execFn = async () => ({ stdout: "", stderr: "", exitCode: 1 });
  const statPaths: string[] = [];
  h.deps.statMtimeFn = (path) => {
    statPaths.push(path);
    return new Date(DAYTIME().getTime() - 23 * 60_000);
  };
  await sweepTick(h.deps);
  assert.ok(h.pushes[0]!.text.includes("Last log 23m ago"), `text names the mtime age: ${h.pushes[0]!.text}`);
  assert.deepEqual(statPaths, ["/repo/.rachel/telegram-bridge.log"], "the bridge log under repoDir is what gets statted");
});

test("bridge-down text names launchctl's stderr when the launchctl call itself failed", async () => {
  const h = makeHarness();
  h.deps.execFn = async () => ({ stdout: "", stderr: "Could not find service", exitCode: 1 });
  await sweepTick(h.deps);
  assert.ok(
    h.pushes[0]!.text.includes("launchctl: Could not find service"),
    `infra failure diagnosable from the ping text: ${h.pushes[0]!.text}`,
  );
});

test("bridge-down text says unknown when the log file is missing", async () => {
  const h = makeHarness();
  h.deps.execFn = async () => ({ stdout: "", stderr: "", exitCode: 1 });
  h.deps.statMtimeFn = () => undefined;
  await sweepTick(h.deps);
  assert.ok(h.pushes[0]!.text.includes("unknown"), `text says unknown: ${h.pushes[0]!.text}`);
});

test("a healthy bridge never seen before pushes nothing", async () => {
  const h = makeHarness();
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 0);
  assert.deepEqual(h.getStateCalls, [{ family: "bridge-liveness", eventId: "bridge:liveness" }]);
});

test("a healthy bridge previously recorded down pushes one normal recovery event", async () => {
  const h = makeHarness();
  h.deps.getStateFn = () => "down";
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 1);
  const p = h.pushes[0]!;
  assert.equal(p.family, "bridge-liveness");
  assert.equal(p.eventId, "bridge:liveness");
  assert.equal(p.state, "up");
  assert.equal(p.severity, "normal");
  assert.equal(p.text, "[bridge] Bridge recovered.");
});

test("a pushFn throw in the bridge family is logged and the tick still resolves", async () => {
  const h = makeHarness();
  h.deps.execFn = async () => ({ stdout: "", stderr: "", exitCode: 1 });
  h.deps.pushFn = async () => {
    throw new Error("telegram unreachable");
  };
  await sweepTick(h.deps);
  assert.ok(
    h.logs.some((line) => line.startsWith("[sweep] bridge-liveness error:")),
    `bridge error was logged: ${JSON.stringify(h.logs)}`,
  );
});

test("a flushFn throw is logged and the bridge check still runs", async () => {
  const h = makeHarness();
  h.deps.flushFn = async () => {
    throw new Error("corrupt deferred queue");
  };
  await sweepTick(h.deps);
  assert.ok(h.logs.some((line) => line.startsWith("[sweep] flush error:")));
  assert.ok(h.order.includes("exec:launchctl"), "bridge family still ran after the flush error");
});

// --- PR-red family ---

// Routes a stubbed gh: `pr list` per repo, `pr checks` per PR, launchctl
// healthy. `checks` responses are keyed "<repo>#<number>" and carry the exit
// code non-zero when any check fails — exactly how the real gh behaves.
function ghExecFn(
  h: ReturnType<typeof makeHarness>,
  prLists: Record<string, { stdout: string; exitCode: number }>,
  checks: Record<string, { stdout: string; exitCode: number }>,
): SweepDeps["execFn"] {
  return async (cmd, args, opts) => {
    h.order.push(`exec:${cmd}`);
    h.execCalls.push({ cmd, args, opts });
    if (cmd === "launchctl") {
      return { stdout: RUNNING_STDOUT, stderr: "", exitCode: 0 };
    }
    if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
      const repo = args[args.indexOf("--repo") + 1]!;
      const res = prLists[repo] ?? { stdout: "[]", exitCode: 0 };
      return { stdout: res.stdout, stderr: res.exitCode === 0 ? "" : "gh boom", exitCode: res.exitCode };
    }
    if (cmd === "gh" && args[0] === "pr" && args[1] === "checks") {
      const repo = args[args.indexOf("--repo") + 1]!;
      const res = checks[`${repo}#${args[2]}`] ?? { stdout: "[]", exitCode: 0 };
      return { stdout: res.stdout, stderr: "", exitCode: res.exitCode };
    }
    throw new Error(`unexpected exec: ${cmd} ${args.join(" ")}`);
  };
}

test("one red PR among two watched repos pushes exactly one normal pr-red event", async () => {
  const h = makeHarness({ calendar_oneshot_hours: [], pr_watch_repos: ["owner/repo", "owner/other"] });
  h.deps.execFn = ghExecFn(
    h,
    {
      "owner/repo": { stdout: JSON.stringify([{ number: 41, headRefOid: "abc1234deadbeef" }]), exitCode: 0 },
      "owner/other": { stdout: JSON.stringify([{ number: 7, headRefOid: "fedcba9876543" }]), exitCode: 0 },
    },
    {
      // gh pr checks exits non-zero when checks fail — that exit code is
      // DATA, not an exec error.
      "owner/repo#41": {
        stdout: JSON.stringify([
          { name: "ci", state: "FAILURE", bucket: "fail" },
          { name: "lint", state: "SUCCESS", bucket: "pass" },
        ]),
        exitCode: 8,
      },
      "owner/other#7": { stdout: JSON.stringify([{ name: "ci", state: "SUCCESS", bucket: "pass" }]), exitCode: 0 },
    },
  );
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 1);
  const p = h.pushes[0]!;
  assert.equal(p.family, "pr-red");
  assert.equal(p.eventId, "pr:owner/repo#41");
  assert.equal(p.state, "abc1234deadbeef:failure");
  assert.equal(p.severity, "normal");
  assert.equal(p.text, "[pr] owner/repo #41 checks failing (abc1234)");
  assert.ok(!h.logs.some((line) => line.includes("pr-red error")), `no pr-red error logged: ${JSON.stringify(h.logs)}`);
});

test("gh pr list and pr checks are invoked with the documented argument shapes", async () => {
  const h = makeHarness({ calendar_oneshot_hours: [], pr_watch_repos: ["owner/repo"] });
  h.deps.execFn = ghExecFn(
    h,
    { "owner/repo": { stdout: JSON.stringify([{ number: 41, headRefOid: "abc1234deadbeef" }]), exitCode: 0 } },
    { "owner/repo#41": { stdout: "[]", exitCode: 0 } },
  );
  await sweepTick(h.deps);
  const list = h.execCalls.find((c) => c.cmd === "gh" && c.args[1] === "list");
  assert.deepEqual(list?.args, ["pr", "list", "--repo", "owner/repo", "--author", "@me", "--state", "open", "--json", "number,headRefOid"]);
  const checks = h.execCalls.find((c) => c.cmd === "gh" && c.args[1] === "checks");
  assert.deepEqual(checks?.args, ["pr", "checks", "41", "--repo", "owner/repo", "--json", "name,bucket,state"]);
});

test("integration: the same red PR across two ticks dedups through the real push chokepoint", async () => {
  const { push, getEventState } = await import("./push.ts");
  const h = makeHarness({ calendar_oneshot_hours: [], pr_watch_repos: ["owner/repo"] });
  const sent: string[] = [];
  const results: string[] = [];
  h.deps.sendFn = async (text) => {
    sent.push(text);
  };
  h.deps.pushFn = async (...args) => {
    const result = await push(...args);
    results.push(result);
    return result;
  };
  h.deps.getStateFn = getEventState;
  h.deps.execFn = ghExecFn(
    h,
    { "owner/repo": { stdout: JSON.stringify([{ number: 41, headRefOid: "abc1234deadbeef" }]), exitCode: 0 } },
    { "owner/repo#41": { stdout: JSON.stringify([{ name: "ci", state: "FAILURE", bucket: "fail" }]), exitCode: 8 } },
  );
  await sweepTick(h.deps);
  assert.deepEqual(results, ["sent"]);
  assert.equal(sent.length, 1);
  assert.equal(getEventState("pr-red", "pr:owner/repo#41", { baseDir: h.baseDir }), "abc1234deadbeef:failure");
  await sweepTick(h.deps);
  assert.deepEqual(results, ["sent", "dedup"], "second identical tick dedups");
  assert.equal(sent.length, 1, "no second Telegram delivery");
});

test("a checkless PR (gh checks exit 1, EMPTY stdout) is skipped with a log and later PRs are still checked", async () => {
  const h = makeHarness({ calendar_oneshot_hours: [], pr_watch_repos: ["owner/repo"] });
  h.deps.execFn = ghExecFn(
    h,
    {
      "owner/repo": {
        stdout: JSON.stringify([
          { number: 41, headRefOid: "abc1234deadbeef" },
          { number: 42, headRefOid: "beefbeef1234567" },
        ]),
        exitCode: 0,
      },
    },
    {
      // A PR with no checks at all: gh exits 1 with EMPTY stdout — this must
      // not abort the family (live-verified failure mode on checkless repos).
      "owner/repo#41": { stdout: "", exitCode: 1 },
      "owner/repo#42": { stdout: JSON.stringify([{ name: "ci", state: "FAILURE", bucket: "fail" }]), exitCode: 8 },
    },
  );
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 1, "the red PR after the checkless one is still pushed");
  assert.equal(h.pushes[0]!.eventId, "pr:owner/repo#42");
  assert.ok(
    h.logs.some((line) => line.includes("owner/repo#41")),
    `checkless PR logged with repo#number: ${JSON.stringify(h.logs)}`,
  );
});

test("a broken repo (gh pr list exit 1) cannot blind the remaining repos", async () => {
  const h = makeHarness({ calendar_oneshot_hours: [], pr_watch_repos: ["owner/broken", "owner/good"] });
  h.deps.execFn = ghExecFn(
    h,
    {
      "owner/broken": { stdout: "", exitCode: 1 },
      "owner/good": { stdout: JSON.stringify([{ number: 9, headRefOid: "cafecafe1234567" }]), exitCode: 0 },
    },
    { "owner/good#9": { stdout: JSON.stringify([{ name: "ci", state: "FAILURE", bucket: "fail" }]), exitCode: 8 } },
  );
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 1, "the good repo's red PR is still pushed");
  assert.equal(h.pushes[0]!.eventId, "pr:owner/good#9");
  assert.ok(
    h.logs.some((line) => line.includes("owner/broken")),
    `broken repo logged: ${JSON.stringify(h.logs)}`,
  );
});

test("a TIMED_OUT check with bucket fail is red (state-string-only detection misses it)", async () => {
  const h = makeHarness({ calendar_oneshot_hours: [], pr_watch_repos: ["owner/repo"] });
  h.deps.execFn = ghExecFn(
    h,
    { "owner/repo": { stdout: JSON.stringify([{ number: 41, headRefOid: "abc1234deadbeef" }]), exitCode: 0 } },
    { "owner/repo#41": { stdout: JSON.stringify([{ name: "ci", state: "TIMED_OUT", bucket: "fail" }]), exitCode: 8 } },
  );
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 1);
  assert.equal(h.pushes[0]!.state, "abc1234deadbeef:failure");
});

test("pass and skipping buckets are not red", async () => {
  const h = makeHarness({ calendar_oneshot_hours: [], pr_watch_repos: ["owner/repo"] });
  h.deps.execFn = ghExecFn(
    h,
    { "owner/repo": { stdout: JSON.stringify([{ number: 41, headRefOid: "abc1234deadbeef" }]), exitCode: 0 } },
    {
      "owner/repo#41": {
        stdout: JSON.stringify([
          { name: "ci", state: "SUCCESS", bucket: "pass" },
          { name: "optional", state: "SKIPPED", bucket: "skipping" },
        ]),
        exitCode: 0,
      },
    },
  );
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 0);
});

test("empty pr_watch_repos makes the pr-red family a silent no-op (zero gh calls)", async () => {
  const h = makeHarness();
  await sweepTick(h.deps);
  assert.equal(h.execCalls.filter((c) => c.cmd === "gh").length, 0);
});

// --- Calendar one-shot spawn cadence + timeout ---

const STATE_PATH = (h: ReturnType<typeof makeHarness>) => join(h.homeDir, ".rachel", "proactive-sweep-state.json");

function rachelSpawns(h: ReturnType<typeof makeHarness>): ExecCall[] {
  return h.execCalls.filter((c) => c.cmd.endsWith("/bin/rachel"));
}

test("due one-shot hours spawn exactly one bin/rachel run with the narrowed tool env", async () => {
  // Clock is 12:00 Dublin: hours 8 and 11 are due, 14/17 are not.
  const h = makeHarness({ calendar_oneshot_hours: [8, 11, 14, 17], pr_watch_repos: [] });
  await sweepTick(h.deps);
  const spawns = rachelSpawns(h);
  assert.equal(spawns.length, 1);
  const spawn = spawns[0]!;
  assert.equal(spawn.cmd, "/repo/bin/rachel");
  assert.deepEqual(spawn.args, ["Read tasks/proactive-calendar.md and follow it."]);
  assert.equal(spawn.opts?.env?.["RACHEL_ALLOWED_TOOLS"], "Read,Write,Bash,mcp__claude_ai_Google_Calendar__*");
  assert.equal(spawn.opts?.stdinNull, true);
  assert.equal(spawn.opts?.timeoutMs, h.deps.oneshotTimeoutMs);
});

test("a spawn records ALL due hours in the sweep state file (wake-time catch-up collapses)", async () => {
  const h = makeHarness({ calendar_oneshot_hours: [8, 11, 14, 17], pr_watch_repos: [] });
  await sweepTick(h.deps);
  const state = JSON.parse(h.files.get(STATE_PATH(h)) ?? "{}") as { schema_version: number; date: string; oneshot_hours_run: number[] };
  assert.equal(state.schema_version, 1);
  assert.equal(state.date, "2026-07-15");
  assert.deepEqual(state.oneshot_hours_run, [8, 11]);
});

test("a second tick in the same hour spawns nothing (hours already recorded)", async () => {
  const h = makeHarness({ calendar_oneshot_hours: [8, 11, 14, 17], pr_watch_repos: [] });
  await sweepTick(h.deps);
  await sweepTick(h.deps);
  assert.equal(rachelSpawns(h).length, 1, "only the first tick spawned");
});

test("no configured hour is due yet: zero spawns", async () => {
  // Clock is 12:00 Dublin; only 14 and 17 are configured.
  const h = makeHarness({ calendar_oneshot_hours: [14, 17], pr_watch_repos: [] });
  await sweepTick(h.deps);
  assert.equal(rachelSpawns(h).length, 0);
});

test("a Dublin date rollover resets the hours-run list", async () => {
  const h = makeHarness({ calendar_oneshot_hours: [8, 11, 14, 17], pr_watch_repos: [] });
  h.files.set(
    STATE_PATH(h),
    JSON.stringify({ schema_version: 1, date: "2026-07-14", oneshot_hours_run: [8, 11, 14, 17] }),
  );
  await sweepTick(h.deps);
  assert.equal(rachelSpawns(h).length, 1, "yesterday's record does not suppress today's spawn");
  const state = JSON.parse(h.files.get(STATE_PATH(h))!) as { date: string; oneshot_hours_run: number[] };
  assert.equal(state.date, "2026-07-15");
  assert.deepEqual(state.oneshot_hours_run, [8, 11]);
});

test("a never-resolving one-shot exec cannot wedge the tick (timeout logged, tick completes)", async () => {
  const h = makeHarness({ calendar_oneshot_hours: [8, 11, 14, 17], pr_watch_repos: [] });
  h.deps.oneshotTimeoutMs = 50;
  const baseExec = h.deps.execFn;
  h.deps.execFn = (cmd, args, opts) => {
    if (cmd.endsWith("/bin/rachel")) {
      h.execCalls.push({ cmd, args, opts });
      return new Promise(() => {
        // never settles — a wedged LLM one-shot
      });
    }
    return baseExec(cmd, args, opts);
  };
  await sweepTick(h.deps);
  assert.ok(
    h.logs.some((line) => line === "[sweep] calendar one-shot timeout"),
    `timeout logged: ${JSON.stringify(h.logs)}`,
  );
});

test("a completed one-shot logs the literal exit-code line", async () => {
  const h = makeHarness({ calendar_oneshot_hours: [8, 11, 14, 17], pr_watch_repos: [] });
  await sweepTick(h.deps);
  assert.ok(
    h.logs.some((line) => line === "[sweep] calendar one-shot exit 0"),
    `exact exit line logged: ${JSON.stringify(h.logs)}`,
  );
});

test("one-shot due-hour comparison runs in Dublin time, not UTC", async () => {
  // 13:30Z is 14:30 Dublin in summer: hour 14 is due. A UTC implementation
  // sees hour 13 and skips.
  const h = makeHarness({ calendar_oneshot_hours: [14], pr_watch_repos: [] });
  h.deps.now = () => new Date("2026-07-15T13:30:00Z");
  await sweepTick(h.deps);
  assert.equal(rachelSpawns(h).length, 1);
});

test("a configured hour is due at that hour exactly (boundary: 08:00 Dublin, hours [8])", async () => {
  // 07:00Z is 08:00 Dublin exactly — kills an h < currentHour mutant.
  const h = makeHarness({ calendar_oneshot_hours: [8], pr_watch_repos: [] });
  h.deps.now = () => new Date("2026-07-15T07:00:00Z");
  await sweepTick(h.deps);
  assert.equal(rachelSpawns(h).length, 1);
});

test("a timed-out one-shot does not respawn on the next tick (hours recorded before the race)", async () => {
  const h = makeHarness({ calendar_oneshot_hours: [8, 11, 14, 17], pr_watch_repos: [] });
  h.deps.oneshotTimeoutMs = 50;
  const baseExec = h.deps.execFn;
  h.deps.execFn = (cmd, args, opts) => {
    if (cmd.endsWith("/bin/rachel")) {
      h.execCalls.push({ cmd, args, opts });
      return new Promise(() => {
        // never settles
      });
    }
    return baseExec(cmd, args, opts);
  };
  await sweepTick(h.deps);
  await sweepTick(h.deps);
  assert.equal(rachelSpawns(h).length, 1, "exactly one spawn across both ticks");
});

test("a corrupt sweep-state file logs one reset line and the spawn still happens", async () => {
  const h = makeHarness({ calendar_oneshot_hours: [8, 11, 14, 17], pr_watch_repos: [] });
  h.files.set(STATE_PATH(h), "not json {");
  await sweepTick(h.deps);
  assert.equal(rachelSpawns(h).length, 1);
  assert.ok(
    h.logs.some((line) => line.includes("corrupt sweep state")),
    `reset logged: ${JSON.stringify(h.logs)}`,
  );
});

test("integration: the tick's flush passthrough delivers a pre-seeded deferred entry via the real flushDeferred", async () => {
  const { flushDeferred } = await import("./push.ts");
  const h = makeHarness();
  writeFileSync(
    join(h.baseDir, "deferred.json"),
    JSON.stringify({
      schema_version: 1,
      entries: [
        { family: "pr-red", event_id: "pr:owner/repo#3", state: "aaa:failure", text: "[pr] owner/repo #3 checks failing (aaa)", queued_at: 1, reason: "quiet" },
      ],
    }),
  );
  const sent: string[] = [];
  h.deps.sendFn = async (text) => {
    sent.push(text);
  };
  h.deps.flushFn = flushDeferred;
  await sweepTick(h.deps);
  assert.equal(sent.length, 1, "the deferred digest went out through the injected sendFn");
  assert.ok(sent[0]!.startsWith("[digest] 1 item (1 overnight):"), `digest header: ${sent[0]}`);
  assert.ok(sent[0]!.includes("[pr] owner/repo #3 checks failing (aaa)"));
});

test("gh exit 1 on pr list logs a pr-red error and the tick completes", async () => {
  const h = makeHarness({ calendar_oneshot_hours: [], pr_watch_repos: ["owner/repo"] });
  h.deps.execFn = ghExecFn(h, { "owner/repo": { stdout: "", exitCode: 1 } }, {});
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 0);
  assert.ok(
    h.logs.some((line) => line.startsWith("[sweep] pr-red error") && line.includes("owner/repo")),
    `pr-red error logged with the repo named: ${JSON.stringify(h.logs)}`,
  );
});

// --- Review fixes: evidence preservation, alert resilience, exit status ---

test("defaultExecFn preserves the spawn error message when the binary does not exist", async () => {
  // Local exec of a nonexistent binary — no network, no real tool.
  const result = await defaultExecFn("/nonexistent-binary-rachel-sweep-test", []);
  assert.notEqual(result.exitCode, 0);
  assert.ok(result.stderr.includes("ENOENT"), `stderr carries the spawn failure: ${JSON.stringify(result.stderr)}`);
});

test("a throwing statMtimeFn cannot kill the urgent bridge-down ping (falls back to unknown)", async () => {
  const h = makeHarness();
  h.deps.execFn = async () => ({ stdout: "", stderr: "", exitCode: 1 });
  h.deps.statMtimeFn = () => {
    const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
    err.code = "EACCES";
    throw err;
  };
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 1, "the urgent down ping is still delivered");
  assert.equal(h.pushes[0]!.state, "down");
  assert.ok(h.pushes[0]!.text.includes("unknown"), `age falls back to unknown: ${h.pushes[0]!.text}`);
});

test("a failing sweep-state write prevents the one-shot spawn (no orphaned child)", async () => {
  const h = makeHarness({ calendar_oneshot_hours: [8, 11, 14, 17], pr_watch_repos: [] });
  h.deps.writeFileFn = () => {
    throw new Error("disk full");
  };
  await sweepTick(h.deps);
  assert.equal(rachelSpawns(h).length, 0, "the spawn never started");
  assert.ok(h.logs.some((line) => line.startsWith("[sweep] calendar error:")));
});

test("sweepTick reports per-family results and a healthy tick is all ok", async () => {
  const h = makeHarness();
  const results = await sweepTick(h.deps);
  assert.deepEqual(results, {
    flush: "ok",
    "bridge-liveness": "ok",
    "bridge-stale": "ok",
    "pr-red": "ok",
    "calendar-escalation": "ok",
    calendar: "ok",
    "memory-lint": "ok",
  });
});

test("a failing family is reported as failed so the CLI can exit non-zero", async () => {
  const h = makeHarness();
  h.deps.flushFn = async () => {
    throw new Error("corrupt deferred queue");
  };
  const results = await sweepTick(h.deps);
  assert.equal(results["flush"], "failed");
  assert.equal(results["bridge-liveness"], "ok");
});

// --- Bridge heartbeat: wedged-alive + drain-stall detection ---

const HEARTBEAT_PATH = (h: ReturnType<typeof makeHarness>) => join(h.homeDir, ".rachel", "bridge-heartbeat.json");

function seedHeartbeat(
  h: ReturnType<typeof makeHarness>,
  opts: { lastPollAgoMs: number; turnInFlightAgoMs?: number; queueDepth?: number },
): { turnInFlightSince: string | null } {
  const turnInFlightSince =
    opts.turnInFlightAgoMs === undefined ? null : new Date(DAYTIME().getTime() - opts.turnInFlightAgoMs).toISOString();
  h.files.set(
    HEARTBEAT_PATH(h),
    JSON.stringify({
      schema_version: 1,
      last_poll_at: new Date(DAYTIME().getTime() - opts.lastPollAgoMs).toISOString(),
      queue_depth: opts.queueDepth ?? 0,
      turn_in_flight_since: turnInFlightSince,
    }),
  );
  return { turnInFlightSince };
}

test("heartbeat 11min stale with launchctl alive pushes one urgent wedged bridge-down event", async () => {
  const h = makeHarness();
  seedHeartbeat(h, { lastPollAgoMs: 11 * 60_000 });
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 1);
  const p = h.pushes[0]!;
  assert.equal(p.family, "bridge-liveness");
  assert.equal(p.eventId, "bridge:liveness");
  assert.equal(p.state, "down");
  assert.equal(p.severity, "urgent");
  assert.ok(p.text.startsWith("[urgent · bridge]"), `urgent bridge tag: ${p.text}`);
  assert.ok(p.text.toLowerCase().includes("wedged"), `message identifies the wedge: ${p.text}`);
});

test("heartbeat 6min stale (past the whole 5x65s conflict-backoff window) with launchctl alive pushes nothing", async () => {
  const h = makeHarness();
  seedHeartbeat(h, { lastPollAgoMs: 6 * 60_000 });
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 0);
});

test("missing heartbeat file with launchctl alive pushes nothing and logs the pre-U2b unknown", async () => {
  const h = makeHarness();
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 0);
  assert.ok(
    h.logs.some((line) => line.includes("no heartbeat file")),
    `unknown (pre-U2b) logged, never alarmed: ${JSON.stringify(h.logs)}`,
  );
});

test("corrupt heartbeat JSON logs and pushes nothing (treated as unknown, not wedged)", async () => {
  const h = makeHarness();
  h.files.set(HEARTBEAT_PATH(h), "not json {");
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 0);
  assert.ok(
    h.logs.some((line) => line.includes("heartbeat")),
    `corrupt heartbeat logged: ${JSON.stringify(h.logs)}`,
  );
});

test("a wedged bridge suppresses the recovery push (no up ping while the heartbeat is stale)", async () => {
  const h = makeHarness();
  h.deps.getStateFn = () => "down";
  seedHeartbeat(h, { lastPollAgoMs: 11 * 60_000 });
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 1);
  assert.equal(h.pushes[0]!.state, "down");
});

test("a fresh heartbeat with prior state down still pushes the recovery event", async () => {
  const h = makeHarness();
  h.deps.getStateFn = () => "down";
  seedHeartbeat(h, { lastPollAgoMs: 60_000 });
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 1);
  assert.equal(h.pushes[0]!.state, "up");
});

test("turn_in_flight_since 31min old with a fresh poll pushes one normal drain-stall event carrying duration and queue depth", async () => {
  const h = makeHarness();
  const { turnInFlightSince } = seedHeartbeat(h, { lastPollAgoMs: 60_000, turnInFlightAgoMs: 31 * 60_000, queueDepth: 3 });
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 1);
  const p = h.pushes[0]!;
  assert.equal(p.family, "bridge-liveness");
  assert.equal(p.eventId, "bridge:drain-stall");
  assert.equal(p.state, `${turnInFlightSince}:30`, "state pairs the timestamp with the escalation bucket so a new turn AND a deepening stall both re-arm the ping");
  assert.equal(p.severity, "normal");
  assert.equal(p.text, "[bridge] turn running 31m, queue depth 3");
});

test("a deepening stall re-arms the drain-stall ping as it crosses each escalation bucket", async () => {
  // The same wedged turn never changes turn_in_flight_since. Keying dedup on
  // that alone means one ping and then permanent silence — the worst case
  // reporting the least. Each bucket crossing must produce a distinct state.
  // Assert on the bucket SUFFIX, never the whole state: seedHeartbeat anchors
  // turn_in_flight_since to DAYTIME() - ago, so each iteration gets a different
  // timestamp prefix. Comparing whole states would pass even if stallBucket
  // returned a constant — the prefix alone would make them distinct.
  const buckets: string[] = [];
  for (const minutes of [31, 65, 130, 260, 500]) {
    const h = makeHarness();
    seedHeartbeat(h, { lastPollAgoMs: 60_000, turnInFlightAgoMs: minutes * 60_000, queueDepth: 1 });
    await sweepTick(h.deps);
    assert.equal(h.pushes.length, 1, `expected a push at ${minutes}m`);
    buckets.push(h.pushes[0]!.state.split(":").pop()!);
  }
  assert.deepEqual(buckets, ["30", "60", "120", "240", "480"], `each threshold must land in its own bucket, got: ${JSON.stringify(buckets)}`);
});

test("two sweeps inside the same escalation bucket dedup to one ping", async () => {
  // Escalation must not become a ping every 30 minutes forever. The SAME
  // wedged turn (one fixed turn_in_flight_since) observed at 35m and 50m is
  // still inside the 30m bucket, so both sweeps must produce identical state
  // for the chokepoint to collapse them.
  const h1 = makeHarness();
  const { turnInFlightSince } = seedHeartbeat(h1, { lastPollAgoMs: 60_000, turnInFlightAgoMs: 35 * 60_000, queueDepth: 1 });
  await sweepTick(h1.deps);
  const h2 = makeHarness();
  seedHeartbeat(h2, { lastPollAgoMs: 60_000, turnInFlightAgoMs: 50 * 60_000, queueDepth: 1 });
  await sweepTick(h2.deps);
  // Compare the bucket suffix, not the whole state — the harness derives a
  // different base timestamp per seed, but the real bridge holds one fixed.
  const bucketOf = (s: string) => s.split(":").pop();
  assert.equal(bucketOf(h1.pushes[0]!.state), bucketOf(h2.pushes[0]!.state), "35m and 50m are both in the 30m bucket");
  assert.equal(h1.pushes[0]!.state, `${turnInFlightSince}:30`, "state is the turn timestamp paired with its bucket");
});

test("turn_in_flight_since 20min old pushes nothing (under the 30min threshold)", async () => {
  const h = makeHarness();
  seedHeartbeat(h, { lastPollAgoMs: 60_000, turnInFlightAgoMs: 20 * 60_000, queueDepth: 3 });
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 0);
});

test("wedge and drain-stall fire in the same tick as independent events", async () => {
  const h = makeHarness();
  seedHeartbeat(h, { lastPollAgoMs: 11 * 60_000, turnInFlightAgoMs: 40 * 60_000, queueDepth: 2 });
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 2);
  const ids = h.pushes.map((p) => p.eventId).sort();
  assert.deepEqual(ids, ["bridge:drain-stall", "bridge:liveness"]);
});

test("a heartbeat exactly 10 minutes stale is not wedged (strict threshold)", async () => {
  const h = makeHarness();
  seedHeartbeat(h, { lastPollAgoMs: 10 * 60_000 });
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 0);
});

test("a heartbeat 10 minutes and one second stale is wedged", async () => {
  const h = makeHarness();
  seedHeartbeat(h, { lastPollAgoMs: 10 * 60_000 + 1000 });
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 1);
  assert.equal(h.pushes[0]!.state, "down");
});

test("a turn in flight exactly 30 minutes is not a drain stall (strict threshold)", async () => {
  const h = makeHarness();
  seedHeartbeat(h, { lastPollAgoMs: 60_000, turnInFlightAgoMs: 30 * 60_000, queueDepth: 1 });
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 0);
});

test("a turn in flight 30 minutes and one second is a drain stall", async () => {
  const h = makeHarness();
  seedHeartbeat(h, { lastPollAgoMs: 60_000, turnInFlightAgoMs: 30 * 60_000 + 1000, queueDepth: 1 });
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 1);
  assert.equal(h.pushes[0]!.eventId, "bridge:drain-stall");
  assert.equal(h.pushes[0]!.text, "[bridge] turn running 30m, queue depth 1");
});

test("integration: a NEW in-flight turn re-arms the drain-stall ping through the real chokepoint", async () => {
  const { push, getEventState } = await import("./push.ts");
  const h = makeHarness();
  const sent: string[] = [];
  h.deps.sendFn = async (text) => {
    sent.push(text);
  };
  h.deps.pushFn = push;
  h.deps.getStateFn = getEventState;
  seedHeartbeat(h, { lastPollAgoMs: 60_000, turnInFlightAgoMs: 31 * 60_000, queueDepth: 2 });
  await sweepTick(h.deps);
  await sweepTick(h.deps);
  assert.equal(sent.filter((t) => t.includes("turn running")).length, 1, "identical stall dedups");
  seedHeartbeat(h, { lastPollAgoMs: 60_000, turnInFlightAgoMs: 45 * 60_000, queueDepth: 2 });
  await sweepTick(h.deps);
  assert.equal(sent.filter((t) => t.includes("turn running")).length, 2, "a different turn_in_flight_since re-arms");
});

// --- Heartbeat-missing grace deadline (48h) ---

function seedSweepState(h: ReturnType<typeof makeHarness>, extra: object, date = "2026-07-15"): void {
  h.files.set(STATE_PATH(h), JSON.stringify({ schema_version: 1, date, oneshot_hours_run: [], ...extra }));
}

test("first tick observing a missing heartbeat records heartbeat_missing_since and pushes nothing", async () => {
  const h = makeHarness();
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 0);
  const state = JSON.parse(h.files.get(STATE_PATH(h))!) as { heartbeat_missing_since?: number };
  assert.equal(state.heartbeat_missing_since, DAYTIME().getTime(), "first-observed-missing timestamp recorded");
});

test("a heartbeat missing for 47h with launchctl alive stays silent (inside the deploy-ordering grace)", async () => {
  const h = makeHarness();
  seedSweepState(h, { heartbeat_missing_since: DAYTIME().getTime() - 47 * 60 * 60 * 1000 });
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 0);
});

test("a heartbeat missing for 49h pushes one normal bridge:heartbeat-missing event whose state is the first-observed date", async () => {
  const h = makeHarness();
  const since = DAYTIME().getTime() - 49 * 60 * 60 * 1000;
  // Seeded with a stale date: the grace timestamp must survive the Dublin
  // date rollover, like the failure streaks.
  seedSweepState(h, { heartbeat_missing_since: since }, "2026-07-13");
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 1);
  const p = h.pushes[0]!;
  assert.equal(p.family, "bridge-liveness");
  assert.equal(p.eventId, "bridge:heartbeat-missing");
  assert.equal(p.severity, "normal");
  assert.equal(p.state, new Date(since).toISOString(), "state is the first-observed date so a resolved-then-rebroken heartbeat re-arms");
  assert.ok(p.text.includes("wedge detection inactive"), `text names the dead detection: ${p.text}`);
});

test("integration: the heartbeat-missing alert dedups through the real chokepoint on the next tick", async () => {
  const { push, getEventState } = await import("./push.ts");
  const h = makeHarness();
  const sent: string[] = [];
  h.deps.sendFn = async (text) => {
    sent.push(text);
  };
  h.deps.pushFn = push;
  h.deps.getStateFn = getEventState;
  seedSweepState(h, { heartbeat_missing_since: DAYTIME().getTime() - 49 * 60 * 60 * 1000 });
  await sweepTick(h.deps);
  await sweepTick(h.deps);
  assert.equal(sent.filter((t) => t.includes("wedge detection inactive")).length, 1, "one alert per unbroken missing streak");
});

test("a heartbeat appearing clears heartbeat_missing_since from the sweep state", async () => {
  const h = makeHarness();
  seedSweepState(h, { heartbeat_missing_since: DAYTIME().getTime() - 49 * 60 * 60 * 1000 });
  seedHeartbeat(h, { lastPollAgoMs: 60_000 });
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 0);
  const state = JSON.parse(h.files.get(STATE_PATH(h))!) as { heartbeat_missing_since?: number };
  assert.equal(state.heartbeat_missing_since, undefined, "grace tracking cleared once the heartbeat exists");
});

test("integration: a wedged bridge delivers ONE urgent push through the real chokepoint inside quiet hours and dedups on the next tick", async () => {
  const { push, getEventState } = await import("./push.ts");
  const h = makeHarness();
  // 23:30 Dublin — inside the quiet window; only urgent deliveries go out.
  h.deps.now = () => new Date("2026-07-15T22:30:00Z");
  const sent: string[] = [];
  h.deps.sendFn = async (text) => {
    sent.push(text);
  };
  h.deps.pushFn = push;
  h.deps.getStateFn = getEventState;
  h.files.set(
    HEARTBEAT_PATH(h),
    JSON.stringify({
      schema_version: 1,
      last_poll_at: new Date(h.deps.now().getTime() - 11 * 60_000).toISOString(),
      queue_depth: 0,
      turn_in_flight_since: null,
    }),
  );
  await sweepTick(h.deps);
  assert.equal(sent.length, 1, "the urgent wedge ping bypasses quiet hours");
  assert.ok(sent[0]!.includes("wedged"), `delivered text identifies the wedge: ${sent[0]}`);
  assert.equal(getEventState("bridge-liveness", "bridge:liveness", { baseDir: h.baseDir }), "down");
  await sweepTick(h.deps);
  assert.equal(sent.length, 1, "an identical second tick dedups — no re-ping");
});

// --- Self-alert escalation: 3 consecutive same-family failures ---

const ESCALATION_PREFIX = "[urgent] proactive sweep itself failing";

function escalations(sent: string[]): string[] {
  return sent.filter((text) => text.startsWith(ESCALATION_PREFIX));
}

function failingFlushHarness() {
  const h = makeHarness();
  const sent: string[] = [];
  h.deps.sendFn = async (text) => {
    sent.push(text);
  };
  h.deps.flushFn = async () => {
    throw new Error("corrupt deferred queue");
  };
  return { h, sent };
}

test("the 3rd consecutive failure of one family sends exactly one escalation naming the family and last error — none at 1-2, none at 4", async () => {
  const { h, sent } = failingFlushHarness();
  await sweepTick(h.deps);
  await sweepTick(h.deps);
  assert.equal(escalations(sent).length, 0, "no escalation before the 3rd consecutive failure");
  await sweepTick(h.deps);
  assert.deepEqual(escalations(sent), ["[urgent] proactive sweep itself failing: flush: corrupt deferred queue"]);
  await sweepTick(h.deps);
  assert.equal(escalations(sent).length, 1, "an unbroken streak escalates exactly once");
  assert.ok(!h.pushes.some((p) => p.text.startsWith(ESCALATION_PREFIX)), "escalation is a direct send, never routed via push()");
});

test("a family success resets the streak and a fresh 3-streak escalates again", async () => {
  const { h, sent } = failingFlushHarness();
  const failingFlush = h.deps.flushFn;
  await sweepTick(h.deps);
  await sweepTick(h.deps);
  h.deps.flushFn = async () => "empty";
  await sweepTick(h.deps);
  assert.equal(escalations(sent).length, 0, "a success before the 3rd failure means no escalation");
  h.deps.flushFn = failingFlush;
  await sweepTick(h.deps);
  await sweepTick(h.deps);
  await sweepTick(h.deps);
  assert.equal(escalations(sent).length, 1, "a fresh 3-streak after a reset escalates once");
});

test("a failed escalation send is logged, never re-escalated about, retried on later ticks, and never repeated once one succeeds", async () => {
  const { h } = failingFlushHarness();
  let attempts = 0;
  let failSend = true;
  h.deps.sendFn = async () => {
    attempts++;
    if (failSend) throw new Error("telegram is the thing that is down");
  };
  await sweepTick(h.deps);
  await sweepTick(h.deps);
  const results = await sweepTick(h.deps);
  assert.equal(results["flush"], "failed", "family results are unaffected by the escalation send outcome");
  assert.equal(attempts, 1, "one attempt on the 3rd consecutive failure");
  assert.ok(
    h.logs.some((line) => line.includes("escalation send failed")),
    `send failure logged: ${JSON.stringify(h.logs)}`,
  );
  await sweepTick(h.deps);
  assert.equal(attempts, 2, "tick 4 retries ONLY because tick 3's send failed");
  failSend = false;
  await sweepTick(h.deps);
  assert.equal(attempts, 3, "retry keeps going until one send succeeds");
  await sweepTick(h.deps);
  assert.equal(attempts, 3, "once a send succeeded, no repeats until the streak resets");
});

test("string-corrupted failure_streaks values are coerced on read so the threshold still fires", async () => {
  const { h, sent } = failingFlushHarness();
  seedSweepState(h, { failure_streaks: { flush: "2" } });
  await sweepTick(h.deps);
  assert.deepEqual(escalations(sent), ["[urgent] proactive sweep itself failing: flush: corrupt deferred queue"]);
});

test("two families failing simultaneously escalate independently, each naming its own family and error", async () => {
  const h = makeHarness();
  const sent: string[] = [];
  h.deps.sendFn = async (text) => {
    sent.push(text);
  };
  h.deps.flushFn = async () => {
    throw new Error("corrupt deferred queue");
  };
  h.deps.execFn = async (cmd) => {
    if (cmd === "launchctl") throw new Error("launchctl exploded");
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  await sweepTick(h.deps);
  await sweepTick(h.deps);
  await sweepTick(h.deps);
  const esc = escalations(sent);
  // Three families depend on launchctl now: bridge-liveness and bridge-stale
  // both consult it, and the flush is broken independently.
  assert.equal(esc.length, 3, `one escalation per failing family: ${JSON.stringify(esc)}`);
  assert.ok(esc.some((t) => t.includes("flush: corrupt deferred queue")));
  assert.ok(esc.some((t) => t.includes("bridge-liveness: launchctl exploded")));
  assert.ok(esc.some((t) => t.includes("bridge-stale: launchctl exploded")));
});

test("an escalation bookkeeping failure (state file unreadable) is logged and never rejects the tick", async () => {
  const h = makeHarness();
  h.deps.readFileFn = () => {
    throw new Error("EIO: state file unreadable");
  };
  const results = await sweepTick(h.deps);
  assert.equal(results["bridge-liveness"], "failed", "the heartbeat read failure still surfaces as a family failure");
  assert.ok(
    h.logs.some((line) => line.includes("escalation bookkeeping failed")),
    `bookkeeping failure logged, tick resolved: ${JSON.stringify(h.logs)}`,
  );
});

test("failure streaks persist in the sweep state file and survive a Dublin date rollover", async () => {
  const { h, sent } = failingFlushHarness();
  await sweepTick(h.deps);
  await sweepTick(h.deps);
  const state = JSON.parse(h.files.get(STATE_PATH(h))!) as { failure_streaks?: Record<string, number> };
  assert.equal(state.failure_streaks?.["flush"], 2, "streak counter persisted in the sweep state file");
  h.deps.now = () => new Date("2026-07-16T11:00:00Z");
  await sweepTick(h.deps);
  assert.equal(escalations(sent).length, 1, "the streak survives the date rollover — 3rd consecutive failure still escalates");
});

// --- Calendar <2h escalation: deterministic cache consumer ---

const CACHE_PATH = (h: ReturnType<typeof makeHarness>) => join(h.homeDir, ".rachel", "calendar-cache.json");

// Fixture pair: startA 13:30 Dublin (+01:00 in July) = 90 minutes after the
// DAYTIME clock (12:00 Dublin). Hash pins hand-computed via
// `printf '%s' "<startA>|<endA>|<startB>|<endB>" | shasum -a 256 | cut -c1-16`.
const CONFLICT_90M = {
  idA: "aaa",
  idB: "bbb",
  startA: "2026-07-15T13:30:00+01:00",
  endA: "2026-07-15T14:30:00+01:00",
  startB: "2026-07-15T14:00:00+01:00",
  endB: "2026-07-15T15:00:00+01:00",
  title_hint: "Design review / 1:1 with Rory",
};
const HASH_90M = "142488339621fc63";
const CONFLICT_RESCHEDULED = { ...CONFLICT_90M, startA: "2026-07-15T13:45:00+01:00" };
const HASH_RESCHEDULED = "e2e9525c79c8fc5f";

function seedCache(
  h: ReturnType<typeof makeHarness>,
  conflicts: object[],
  fetchedAt: string = DAYTIME().toISOString(),
): void {
  h.files.set(CACHE_PATH(h), JSON.stringify({ schema_version: 1, fetched_at: fetchedAt, conflicts }));
}

test("a cached conflict starting 90m out pushes one urgent :2h escalation with the pinned hash16 state", async () => {
  const h = makeHarness();
  seedCache(h, [CONFLICT_90M]);
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 1);
  const p = h.pushes[0]!;
  assert.equal(p.family, "calendar");
  assert.equal(p.eventId, "cal:aaa+bbb:2h");
  assert.equal(p.state, HASH_90M, "state is the first 16 hex chars of sha256 over startA|endA|startB|endB");
  assert.equal(p.severity, "urgent");
  assert.equal(p.text, "[urgent · cal] Conflict: Design review / 1:1 with Rory — 13:30 overlaps 14:00, starts in 90m");
});

test("a cached conflict starting 3h out pushes nothing", async () => {
  const h = makeHarness();
  seedCache(h, [
    {
      ...CONFLICT_90M,
      startA: "2026-07-15T15:00:00+01:00",
      endA: "2026-07-15T16:00:00+01:00",
      startB: "2026-07-15T15:30:00+01:00",
      endB: "2026-07-15T16:30:00+01:00",
    },
  ]);
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 0);
});

test("a conflict whose earlier event already started pushes nothing (the window is (now, now+2h])", async () => {
  const h = makeHarness();
  seedCache(h, [
    {
      ...CONFLICT_90M,
      startA: "2026-07-15T11:30:00+01:00", // 30m in the past (clock is 12:00 Dublin)
      endA: "2026-07-15T14:30:00+01:00",
    },
  ]);
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 0);
});

test("a missing calendar cache is a logged skip, never an alarm or a family error", async () => {
  const h = makeHarness();
  const results = await sweepTick(h.deps);
  assert.equal(h.pushes.length, 0);
  assert.equal(results["calendar-escalation"], "ok");
  assert.ok(
    h.logs.some((line) => line.includes("calendar-escalation") && line.includes("no cache")),
    `skip logged: ${JSON.stringify(h.logs)}`,
  );
});

test("a corrupt calendar cache is a logged skip, never an alarm", async () => {
  const h = makeHarness();
  h.files.set(CACHE_PATH(h), "not json {");
  const results = await sweepTick(h.deps);
  assert.equal(h.pushes.length, 0);
  assert.equal(results["calendar-escalation"], "ok");
  assert.ok(
    h.logs.some((line) => line.includes("calendar-escalation") && line.includes("corrupt")),
    `corrupt skip logged: ${JSON.stringify(h.logs)}`,
  );
});

test("a cache fetched 27h ago is stale (>26h) and skipped without alarm", async () => {
  const h = makeHarness();
  seedCache(h, [CONFLICT_90M], new Date(DAYTIME().getTime() - 27 * 60 * 60 * 1000).toISOString());
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 0);
  assert.ok(
    h.logs.some((line) => line.includes("calendar-escalation") && line.includes("stale")),
    `stale skip logged: ${JSON.stringify(h.logs)}`,
  );
});

test("a cache fetched 25h ago is NOT stale (26h boundary) and still escalates", async () => {
  const h = makeHarness();
  seedCache(h, [CONFLICT_90M], new Date(DAYTIME().getTime() - 25 * 60 * 60 * 1000).toISOString());
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 1);
});

test("integration: the :2h escalation dedups through the real chokepoint and a reschedule re-arms it", async () => {
  const { push, getEventState } = await import("./push.ts");
  const h = makeHarness();
  const sent: string[] = [];
  h.deps.sendFn = async (text) => {
    sent.push(text);
  };
  h.deps.pushFn = push;
  h.deps.getStateFn = getEventState;
  seedCache(h, [CONFLICT_90M]);
  await sweepTick(h.deps);
  await sweepTick(h.deps);
  assert.equal(sent.filter((t) => t.startsWith("[urgent · cal]")).length, 1, "identical schedule dedups");
  assert.equal(getEventState("calendar", "cal:aaa+bbb:2h", { baseDir: h.baseDir }), HASH_90M);
  // Reschedule: startA moves 15 minutes — the hash changes, so the SAME
  // event-id re-arms (red-team pin: dedup is per schedule-state, not per pair).
  seedCache(h, [CONFLICT_RESCHEDULED]);
  await sweepTick(h.deps);
  assert.equal(sent.filter((t) => t.startsWith("[urgent · cal]")).length, 2, "a reschedule re-arms the escalation");
  assert.equal(getEventState("calendar", "cal:aaa+bbb:2h", { baseDir: h.baseDir }), HASH_RESCHEDULED);
});

test("Math.min earlier-start: the lexicographically-lower ID's event 3h out with the other event 90m out still escalates on the 90m start", async () => {
  // Kills a startAMs-only mutant: A (lower id) starts 3h out, B starts 90m
  // out, and they overlap — the WINDOW check must use the earlier of the two.
  const h = makeHarness();
  seedCache(h, [
    {
      idA: "aaa",
      idB: "bbb",
      startA: "2026-07-15T15:00:00+01:00", // 3h out
      endA: "2026-07-15T16:00:00+01:00",
      startB: "2026-07-15T13:30:00+01:00", // 90m out
      endB: "2026-07-15T15:30:00+01:00",
      title_hint: "Offsite / Standup",
    },
  ]);
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 1);
  assert.ok(h.pushes[0]!.text.includes("starts in 90m"), `window keyed on the earlier start: ${h.pushes[0]!.text}`);
});

test("a conflict whose earlier start is exactly now+2h escalates (inclusive upper bound)", async () => {
  const h = makeHarness();
  seedCache(h, [
    {
      ...CONFLICT_90M,
      startA: "2026-07-15T14:00:00+01:00", // exactly 2h after the 12:00 Dublin clock
      endA: "2026-07-15T15:00:00+01:00",
      startB: "2026-07-15T14:30:00+01:00",
      endB: "2026-07-15T15:30:00+01:00",
    },
  ]);
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 1);
});

test("a conflict whose earlier start is exactly now pushes nothing (exclusive lower bound)", async () => {
  const h = makeHarness();
  seedCache(h, [
    {
      ...CONFLICT_90M,
      startA: "2026-07-15T12:00:00+01:00", // exactly the 12:00 Dublin clock
      endA: "2026-07-15T15:00:00+01:00",
      startB: "2026-07-15T14:30:00+01:00",
      endB: "2026-07-15T15:30:00+01:00",
    },
  ]);
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 0);
});

test("valid-JSON wrong-shape caches (schema_version 2, missing conflicts) are logged skips, not family failures", async () => {
  const h = makeHarness();
  h.files.set(CACHE_PATH(h), JSON.stringify({ schema_version: 2, fetched_at: DAYTIME().toISOString(), conflicts: [CONFLICT_90M] }));
  let results = await sweepTick(h.deps);
  assert.equal(h.pushes.length, 0);
  assert.equal(results["calendar-escalation"], "ok");
  h.files.set(CACHE_PATH(h), JSON.stringify({ schema_version: 1, fetched_at: DAYTIME().toISOString() }));
  results = await sweepTick(h.deps);
  assert.equal(h.pushes.length, 0);
  assert.equal(results["calendar-escalation"], "ok");
  assert.ok(
    h.logs.filter((line) => line.includes("calendar-escalation") && line.includes("unrecognised shape")).length >= 2,
    `both wrong shapes logged: ${JSON.stringify(h.logs)}`,
  );
});

test("a mis-sorted producer entry is defensively re-sorted: same event-id and same hash16 as the correctly-sorted cache", async () => {
  const h = makeHarness();
  // CONFLICT_90M with every A/B field swapped — a producer that mis-sorted.
  seedCache(h, [
    {
      idA: "bbb",
      idB: "aaa",
      startA: CONFLICT_90M.startB,
      endA: CONFLICT_90M.endB,
      startB: CONFLICT_90M.startA,
      endB: CONFLICT_90M.endA,
      title_hint: CONFLICT_90M.title_hint,
    },
  ]);
  await sweepTick(h.deps);
  assert.equal(h.pushes.length, 1);
  assert.equal(h.pushes[0]!.eventId, "cal:aaa+bbb:2h", "event-id re-sorted to lexicographic order");
  assert.equal(h.pushes[0]!.state, HASH_90M, "hash computed over the re-sorted field order");
});

// --- Calendar producer-silence detection ---

// A dead one-shot producer (launchd job gone, MCP broken, bin/rachel failing)
// otherwise degrades to an eternally-skipped stale/missing cache with every
// tick "ok" — positive silence. Three consecutive silent ticks push one
// normal alert.

function advanceClock(h: ReturnType<typeof makeHarness>, startMs: number): () => void {
  let tick = 0;
  return () => {
    const t = tick++; // capture by value — the closure must not see later increments
    h.deps.now = () => new Date(startMs + t * 30 * 60_000);
  };
}

function producerPushes(h: ReturnType<typeof makeHarness>): PushCall[] {
  return h.pushes.filter((p) => p.eventId === "cal:producer-silent");
}

test("three consecutive missing-cache ticks push one normal producer-silent alert; two do not", async () => {
  const h = makeHarness();
  const next = advanceClock(h, DAYTIME().getTime());
  next();
  await sweepTick(h.deps);
  next();
  await sweepTick(h.deps);
  assert.equal(producerPushes(h).length, 0, "no alert before the 3rd consecutive silent tick");
  next();
  await sweepTick(h.deps);
  const alerts = producerPushes(h);
  assert.equal(alerts.length, 1);
  const p = alerts[0]!;
  assert.equal(p.family, "calendar");
  assert.equal(p.severity, "normal");
  assert.equal(p.text, "[cal] calendar producer silent — cache stale/missing for 1h");
  assert.equal(p.state, new Date(DAYTIME().getTime()).toISOString(), "state is the first-observed-silent timestamp so a new silence episode re-arms");
});

test("stale-beyond-26h ticks count as producer silence exactly like a missing cache", async () => {
  const h = makeHarness();
  const staleFetch = new Date(DAYTIME().getTime() - 27 * 60 * 60 * 1000).toISOString();
  seedCache(h, [CONFLICT_90M], staleFetch);
  const next = advanceClock(h, DAYTIME().getTime());
  next();
  await sweepTick(h.deps);
  next();
  await sweepTick(h.deps);
  next();
  await sweepTick(h.deps);
  assert.equal(producerPushes(h).length, 1);
});

test("a fresh cache resets the producer-silence streak and a new episode re-arms with a new state", async () => {
  const h = makeHarness();
  const start = DAYTIME().getTime();
  const next = advanceClock(h, start);
  next();
  await sweepTick(h.deps); // missing 1
  next();
  await sweepTick(h.deps); // missing 2
  seedCache(h, [], new Date(start + 2 * 30 * 60_000).toISOString());
  next();
  await sweepTick(h.deps); // fresh — resets
  h.files.delete(CACHE_PATH(h));
  next();
  await sweepTick(h.deps); // missing 1 of new episode (t = start+90m)
  next();
  await sweepTick(h.deps); // missing 2
  assert.equal(producerPushes(h).length, 0, "the reset means no alert until a fresh 3-streak");
  next();
  await sweepTick(h.deps); // missing 3 — alert
  const alerts = producerPushes(h);
  assert.equal(alerts.length, 1);
  assert.equal(
    alerts[0]!.state,
    new Date(start + 3 * 30 * 60_000).toISOString(),
    "the new episode's first-observed timestamp is the state — a resolved-then-rebroken producer re-arms",
  );
});

// --- Memory store lint: 6th family ---

function memoryLintPushes(h: ReturnType<typeof makeHarness>) {
  return h.pushes.filter((p) => p.family === "memory-lint");
}

test("a clean memory store pushes nothing", async () => {
  const h = makeHarness();
  h.deps.lintFn = () => [];
  await sweepTick(h.deps);
  assert.deepEqual(memoryLintPushes(h), []);
});

test("findings push exactly one normal-severity memory-lint event with a fixed event-id", async () => {
  const h = makeHarness();
  h.deps.lintFn = () => [
    { file: "units-preference.md", code: "missing-frontmatter", level: "error", message: "no leading frontmatter block" },
  ];
  await sweepTick(h.deps);
  const pushes = memoryLintPushes(h);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0]!.eventId, "memory:lint");
  assert.equal(pushes[0]!.severity, "normal");
});

test("an unchanged violation set does not change state across ticks (chokepoint dedup can hold)", async () => {
  const h = makeHarness();
  h.deps.lintFn = () => [
    { file: "units-preference.md", code: "missing-frontmatter", level: "error", message: "no leading frontmatter block" },
  ];
  await sweepTick(h.deps);
  await sweepTick(h.deps);
  const pushes = memoryLintPushes(h);
  assert.equal(pushes.length, 2, "pushFn is called every tick — dedup itself lives in the real chokepoint, not the sweep");
  assert.equal(pushes[0]!.state, pushes[1]!.state, "an unchanged violation set produces the same state both ticks");
});

test("a new violation changes the pushed state (re-arms dedup)", async () => {
  const h = makeHarness();
  h.deps.lintFn = () => [
    { file: "units-preference.md", code: "missing-frontmatter", level: "error", message: "no leading frontmatter block" },
  ];
  await sweepTick(h.deps);
  const firstState = memoryLintPushes(h)[0]!.state;
  h.deps.lintFn = () => [
    { file: "units-preference.md", code: "missing-frontmatter", level: "error", message: "no leading frontmatter block" },
    { file: "other.md", code: "missing-date", level: "warning", message: "frontmatter is missing the date field" },
  ];
  await sweepTick(h.deps);
  const secondState = memoryLintPushes(h)[1]!.state;
  assert.notEqual(firstState, secondState, "adding a finding must change the hashed state so it re-alerts");
});

test("the same violation set in a different order hashes to the same state (order-independent)", async () => {
  const h = makeHarness();
  h.deps.lintFn = () => [
    { file: "a.md", code: "missing-date", level: "warning", message: "m1" },
    { file: "b.md", code: "missing-frontmatter", level: "error", message: "m2" },
  ];
  await sweepTick(h.deps);
  const firstState = memoryLintPushes(h)[0]!.state;
  h.deps.lintFn = () => [
    { file: "b.md", code: "missing-frontmatter", level: "error", message: "m2-different-wording" },
    { file: "a.md", code: "missing-date", level: "warning", message: "m1-different-wording" },
  ];
  await sweepTick(h.deps);
  const secondState = memoryLintPushes(h)[1]!.state;
  assert.equal(firstState, secondState, "state hashes the {file, code, level} set, not message text or order");
});

test("a lintFn throw is logged and the rest of the tick still runs", async () => {
  const h = makeHarness();
  h.deps.lintFn = () => {
    throw new Error("boom");
  };
  await sweepTick(h.deps);
  assert.ok(h.logs.some((line) => line.includes("memory-lint error")), `expected a memory-lint error log: ${JSON.stringify(h.logs)}`);
  assert.ok(h.order.some((entry) => entry === "exec:launchctl"), "bridge-liveness still ran after the memory-lint family failed");
});

test("integration: an unchanged violation set dedups through the real chokepoint and a new violation re-arms it", async () => {
  const { push, getEventState } = await import("./push.ts");
  const h = makeHarness();
  const sent: string[] = [];
  h.deps.sendFn = async (text) => {
    sent.push(text);
  };
  h.deps.pushFn = push;
  h.deps.getStateFn = getEventState;
  h.deps.lintFn = () => [
    { file: "units-preference.md", code: "missing-frontmatter", level: "error", message: "no leading frontmatter block" },
  ];
  await sweepTick(h.deps);
  await sweepTick(h.deps);
  assert.equal(sent.filter((t) => t.startsWith("[memory]")).length, 1, "an unchanged violation set dedups — only the first tick's send lands");
  const stateAfterFirst = getEventState("memory-lint", "memory:lint", { baseDir: h.baseDir });
  h.deps.lintFn = () => [
    { file: "units-preference.md", code: "missing-frontmatter", level: "error", message: "no leading frontmatter block" },
    { file: "other.md", code: "missing-date", level: "warning", message: "frontmatter is missing the date field" },
  ];
  await sweepTick(h.deps);
  assert.equal(sent.filter((t) => t.startsWith("[memory]")).length, 2, "a new violation changes the state and re-arms the ping");
  assert.notEqual(getEventState("memory-lint", "memory:lint", { baseDir: h.baseDir }), stateAfterFirst);
});

// --- bridge-stale: the auto-remediating stale-process family (RCA item 11) ---
//
// Every test here drives a fully-stubbed execFn: launchctl, ps and git are all
// fakes, and sleepFn is a no-op. No test in this file may ever bootout the
// live com.rachel.telegram-bridge — the grep guard at the bottom pins that.

const STALE_PID = 4242;
const RUNNING_WITH_PID = `com.rachel.telegram-bridge = {\n\tstate = running\n\tpid = ${STALE_PID}\n}`;

interface StaleOpts {
  // Elapsed time of the bridge process, as `ps -o etime=` renders it.
  etime?: string;
  // Committer date of the newest commit touching the relevant paths.
  commitISO?: string;
  commitSha?: string;
  // Number of `launchctl print` polls after bootout that still find the
  // service before it finally goes absent.
  pollsBeforeGone?: number;
  bootoutExit?: number;
  bootstrapExit?: number;
  running?: boolean;
}

// Stubs the whole external surface the bridge-stale family touches. Records
// every launchctl subcommand in order so the bootout -> poll -> bootstrap
// sequence can be asserted directly.
function staleExecFn(h: ReturnType<typeof makeHarness>, o: StaleOpts = {}): SweepDeps["execFn"] {
  const commitISO = o.commitISO ?? "2026-07-15T09:00:00Z";
  const running = o.running ?? true;
  let printsSinceBootout = 0;
  let bootedOut = false;
  return async (cmd, args, opts) => {
    h.execCalls.push({ cmd, args, opts });
    if (cmd === "launchctl") {
      const sub = args[0];
      h.order.push(`launchctl:${sub}`);
      if (sub === "print") {
        if (bootedOut) {
          printsSinceBootout += 1;
          if (printsSinceBootout <= (o.pollsBeforeGone ?? 0)) {
            return { stdout: RUNNING_WITH_PID, stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "Could not find service", exitCode: 113 };
        }
        return running
          ? { stdout: RUNNING_WITH_PID, stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "Could not find service", exitCode: 113 };
      }
      if (sub === "bootout") {
        bootedOut = true;
        return { stdout: "", stderr: "", exitCode: o.bootoutExit ?? 0 };
      }
      if (sub === "bootstrap") {
        bootedOut = false;
        return { stdout: "", stderr: o.bootstrapExit ? "bootstrap failed" : "", exitCode: o.bootstrapExit ?? 0 };
      }
    }
    if (cmd === "ps") {
      h.order.push("ps");
      return { stdout: `${o.etime ?? "10:00:00"}\n`, stderr: "", exitCode: 0 };
    }
    if (cmd === "git") {
      h.order.push("git");
      return { stdout: `${commitISO}\t${o.commitSha ?? "9e8b1ec"}\n`, stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
}

// A harness with the sleep stubbed out — the poll loop must never really wait.
function staleHarness(o: StaleOpts = {}) {
  const h = makeHarness();
  h.deps.execFn = staleExecFn(h, o);
  h.deps.sleepFn = async () => {};
  return h;
}

test("a bridge started before the newest relevant commit is restarted without asking", async () => {
  // DAYTIME is 2026-07-15T11:00:00Z; etime 01:00:00 puts the process start at
  // 10:00Z, which is AFTER the 09:00Z commit... so make the process older.
  const h = staleHarness({ etime: "05:00:00", commitISO: "2026-07-15T09:00:00Z" });
  await sweepTick(h.deps);
  const subs = h.execCalls.filter((c) => c.cmd === "launchctl").map((c) => c.args[0]);
  assert.ok(subs.includes("bootout"), "the stale bridge was booted out");
  assert.ok(subs.includes("bootstrap"), "the bridge was bootstrapped again");
  const fyi = h.pushes.find((p) => p.family === "bridge-stale");
  assert.ok(fyi, "an FYI was pushed");
  assert.equal(fyi.severity, "normal");
  assert.ok(fyi.text.includes("9e8b1ec"), `the FYI names the SHA it restarted onto: ${fyi.text}`);
});

test("the restart FYI is an after-the-fact statement, never a request for approval", async () => {
  const h = staleHarness({ etime: "05:00:00" });
  await sweepTick(h.deps);
  const fyi = h.pushes.find((p) => p.family === "bridge-stale");
  assert.ok(fyi);
  assert.doesNotMatch(fyi.text, /\?|approve|shall I|should I|may I|would you like/i, `no approval language: ${fyi.text}`);
  assert.match(fyi.text, /restarted/i, "states the restart as already done");
});

test("the restart is pushed only AFTER the bootstrap, never before the bootout", async () => {
  const h = staleHarness({ etime: "05:00:00" });
  await sweepTick(h.deps);
  const pushIdx = h.order.indexOf("push:bridge-stale");
  const bootstrapIdx = h.order.indexOf("launchctl:bootstrap");
  assert.ok(bootstrapIdx >= 0 && pushIdx > bootstrapIdx, `act then notify: ${h.order.join(",")}`);
});

test("a bridge started after the newest relevant commit is left alone", async () => {
  // etime 01:00:00 => started 10:00Z, newer than the 09:00Z commit.
  const h = staleHarness({ etime: "01:00:00", commitISO: "2026-07-15T09:00:00Z" });
  await sweepTick(h.deps);
  const subs = h.execCalls.filter((c) => c.cmd === "launchctl").map((c) => c.args[0]);
  assert.equal(subs.includes("bootout"), false, "a fresh bridge is never restarted");
  assert.equal(h.pushes.filter((p) => p.family === "bridge-stale").length, 0);
});

test("staleness is measured against commits touching rachel.ts, bridge/ and prompts/ only", async () => {
  const h = staleHarness({ etime: "05:00:00" });
  await sweepTick(h.deps);
  const gitCall = h.execCalls.find((c) => c.cmd === "git");
  assert.ok(gitCall, "git was consulted");
  const args = gitCall.args;
  const sep = args.indexOf("--");
  assert.ok(sep > 0, `paths are passed after a -- separator: ${args.join(" ")}`);
  assert.deepEqual(args.slice(sep + 1), ["rachel.ts", "bridge/", "prompts/"]);
  assert.ok(args.includes("HEAD"), "the comparison is against the checked-out HEAD, not a remote ref");
});

test("a merge touching only irrelevant paths yields no relevant commit and triggers no restart", async () => {
  const h = makeHarness();
  // git finds nothing touching the watched paths since forever: empty stdout.
  h.deps.execFn = async (cmd, args, opts) => {
    h.execCalls.push({ cmd, args, opts });
    if (cmd === "git") return { stdout: "\n", stderr: "", exitCode: 0 };
    if (cmd === "ps") return { stdout: "99:00:00\n", stderr: "", exitCode: 0 };
    if (cmd === "launchctl") {
      h.order.push(`launchctl:${args[0]}`);
      return { stdout: RUNNING_WITH_PID, stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  h.deps.sleepFn = async () => {};
  await sweepTick(h.deps);
  assert.equal(h.order.includes("launchctl:bootout"), false, "no relevant commit means nothing to be stale against");
  assert.equal(h.pushes.filter((p) => p.family === "bridge-stale").length, 0);
});

test("bootout is followed by polling until the service is genuinely absent, before bootstrap", async () => {
  const h = staleHarness({ etime: "05:00:00", pollsBeforeGone: 3 });
  await sweepTick(h.deps);
  const seq = h.order.filter((e) => e.startsWith("launchctl:"));
  const bootoutIdx = seq.indexOf("launchctl:bootout");
  const bootstrapIdx = seq.indexOf("launchctl:bootstrap");
  assert.ok(bootoutIdx >= 0 && bootstrapIdx > bootoutIdx, "bootout precedes bootstrap");
  const pollsBetween = seq.slice(bootoutIdx + 1, bootstrapIdx).filter((e) => e === "launchctl:print").length;
  assert.ok(pollsBetween >= 4, `polled until absent (${pollsBetween} prints) rather than bootstrapping immediately`);
});

test("a service that never goes away is not bootstrapped on top of itself", async () => {
  const h = staleHarness({ etime: "05:00:00", pollsBeforeGone: 10_000 });
  await sweepTick(h.deps);
  const subs = h.execCalls.filter((c) => c.cmd === "launchctl").map((c) => c.args[0]);
  assert.equal(subs.includes("bootstrap"), false, "never bootstrap while the old job is still draining");
});

test("a bridge mid-turn is not restarted; the next tick can retry", async () => {
  const h = staleHarness({ etime: "05:00:00" });
  h.deps.readFileFn = (path) => {
    if (path.endsWith("bridge-heartbeat.json")) {
      return JSON.stringify({
        schema_version: 1,
        last_poll_at: new Date(DAYTIME().getTime() - 60_000).toISOString(),
        queue_depth: 1,
        turn_in_flight_since: new Date(DAYTIME().getTime() - 60_000).toISOString(),
      });
    }
    return h.files.get(path);
  };
  await sweepTick(h.deps);
  const subs = h.execCalls.filter((c) => c.cmd === "launchctl").map((c) => c.args[0]);
  assert.equal(subs.includes("bootout"), false, "never restart while a turn is in flight");
  assert.ok(h.logs.some((l) => l.includes("mid-turn")), `the skip is logged: ${h.logs.join(" | ")}`);
});

test("a missing heartbeat is not treated as evidence of a turn in flight", async () => {
  // Skipping on unknown would permanently disable remediation on a bridge
  // whose heartbeat file is broken — exactly the bridge most likely stale.
  const h = staleHarness({ etime: "05:00:00" });
  await sweepTick(h.deps);
  const subs = h.execCalls.filter((c) => c.cmd === "launchctl").map((c) => c.args[0]);
  assert.ok(subs.includes("bootout"), "no heartbeat evidence means proceed, not skip");
});

test("a long-finished turn does not block the restart", async () => {
  const h = staleHarness({ etime: "05:00:00" });
  h.deps.readFileFn = (path) => {
    if (path.endsWith("bridge-heartbeat.json")) {
      return JSON.stringify({
        schema_version: 1,
        last_poll_at: new Date(DAYTIME().getTime() - 60_000).toISOString(),
        queue_depth: 0,
        turn_in_flight_since: new Date(DAYTIME().getTime() - 3 * 60 * 60_000).toISOString(),
      });
    }
    return h.files.get(path);
  };
  await sweepTick(h.deps);
  const subs = h.execCalls.filter((c) => c.cmd === "launchctl").map((c) => c.args[0]);
  assert.ok(subs.includes("bootout"), "a turn_in_flight_since older than the turn ceiling is stale bookkeeping, not a live turn");
});

test("a failed restart does not thrash: attempts are capped across ticks and the family never throws", async () => {
  const h = staleHarness({ etime: "05:00:00", bootstrapExit: 5 });
  const results = [];
  for (let i = 0; i < 6; i += 1) {
    results.push(await sweepTick(h.deps));
  }
  for (const r of results) {
    assert.notEqual(r["bridge-stale"], undefined, "the family ran");
    assert.equal(r["bridge-stale"], "ok", "a failed restart is handled, never thrown out of the sweep");
  }
  const bootouts = h.execCalls.filter((c) => c.cmd === "launchctl" && c.args[0] === "bootout").length;
  assert.ok(bootouts <= 3, `attempts are capped, got ${bootouts} bootouts across 6 ticks`);
  assert.ok(bootouts >= 1, "at least one attempt was made");
});

test("a capped-out failure is reported once under a state distinct from the success state", async () => {
  const h = staleHarness({ etime: "05:00:00", bootstrapExit: 5 });
  for (let i = 0; i < 6; i += 1) await sweepTick(h.deps);
  const failures = h.pushes.filter((p) => p.family === "bridge-stale" && /fail/i.test(p.state));
  assert.ok(failures.length >= 1, "the operator is told the auto-remediation itself failed");
  const successes = h.pushes.filter((p) => p.family === "bridge-stale" && !/fail/i.test(p.state));
  assert.equal(successes.length, 0, "a failed restart never claims success");
});

test("a new relevant commit re-arms the attempt budget after a capped-out failure", async () => {
  const h = staleHarness({ etime: "05:00:00", bootstrapExit: 5 });
  for (let i = 0; i < 6; i += 1) await sweepTick(h.deps);
  const before = h.execCalls.filter((c) => c.cmd === "launchctl" && c.args[0] === "bootout").length;
  // A newer commit lands: the cap is per target SHA, so remediation retries.
  h.deps.execFn = staleExecFn(h, { etime: "05:00:00", commitSha: "abc1234", bootstrapExit: 5 });
  await sweepTick(h.deps);
  const after = h.execCalls.filter((c) => c.cmd === "launchctl" && c.args[0] === "bootout").length;
  assert.ok(after > before, "a different target SHA resets the attempt counter");
});

test("a successful restart re-arms dedup for a genuine second restart on a later commit", async () => {
  const h = staleHarness({ etime: "05:00:00", commitSha: "1111111" });
  await sweepTick(h.deps);
  h.deps.execFn = staleExecFn(h, { etime: "05:00:00", commitSha: "2222222" });
  await sweepTick(h.deps);
  const states = h.pushes.filter((p) => p.family === "bridge-stale").map((p) => p.state);
  assert.equal(new Set(states).size, states.length, `each genuine restart carries its own dedup state: ${states.join(",")}`);
  assert.equal(states.length, 2);
});

test("a bridge launchd reports as down is left to the bridge-liveness family", async () => {
  const h = staleHarness({ etime: "05:00:00", running: false });
  await sweepTick(h.deps);
  const subs = h.execCalls.filter((c) => c.cmd === "launchctl").map((c) => c.args[0]);
  assert.equal(subs.includes("bootout"), false, "down-detection is bridge-liveness's job, not this family's");
});

test("an unparseable ps etime is a logged skip, never a restart and never a family failure", async () => {
  const h = staleHarness({ etime: "05:00:00" });
  const base = h.deps.execFn;
  h.deps.execFn = async (cmd, args, opts) => {
    if (cmd === "ps") {
      h.execCalls.push({ cmd, args, opts });
      return { stdout: "not-a-duration\n", stderr: "", exitCode: 0 };
    }
    return base(cmd, args, opts);
  };
  const results = await sweepTick(h.deps);
  assert.equal(results["bridge-stale"], "ok");
  const subs = h.execCalls.filter((c) => c.cmd === "launchctl").map((c) => c.args[0]);
  assert.equal(subs.includes("bootout"), false, "an unreadable start time is never grounds for a restart");
});

test("an exploding launchctl in the stale family is caught and the rest of the tick still runs", async () => {
  const h = staleHarness({ etime: "05:00:00" });
  const base = h.deps.execFn;
  h.deps.execFn = async (cmd, args, opts) => {
    if (cmd === "git") throw new Error("git exploded");
    return base(cmd, args, opts);
  };
  const results = await sweepTick(h.deps);
  assert.equal(results["bridge-stale"], "failed", "the failure is recorded, not propagated");
  assert.equal(results["memory-lint"], "ok", "later families still ran");
});

test("grep guard for proactive/sweep.test.ts: no test in this file ever calls the real api.telegram.org network endpoint", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("./sweep.test.ts", import.meta.url), "utf8");
  const realFetchCall = /fetch\(\s*["'`]https:\/\/api\.telegram\.org/;
  assert.equal(realFetchCall.test(source), false);
});

test("grep guard: no test in this file can bootout the real bridge — every launchctl call goes through an injected execFn", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("./sweep.test.ts", import.meta.url), "utf8");
  // defaultExecFn is the only path to a real subprocess. It may be imported
  // and unit-tested on harmless commands, but must never be wired into a
  // SweepDeps used by sweepTick, and never given launchctl/bootout.
  assert.equal(/execFn:\s*defaultExecFn/.test(source), false, "no harness ever uses the real execFn");
  assert.equal(/defaultExecFn\(\s*["'`]launchctl/.test(source), false, "defaultExecFn is never handed launchctl");
  // Every SweepDeps built here must carry a stubbed execFn. Both harness
  // factories assign one, and staleHarness additionally stubs sleepFn, so no
  // poll loop can ever really wait.
  assert.match(source, /function makeHarness[\s\S]*?execFn: async/, "makeHarness stubs execFn");
  assert.match(source, /function staleHarness[\s\S]*?sleepFn: async \(\) => \{\}/, "staleHarness stubs sleepFn");
});
