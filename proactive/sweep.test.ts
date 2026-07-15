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
  assert.deepEqual(results, { flush: "ok", "bridge-liveness": "ok", "pr-red": "ok", calendar: "ok" });
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

test("grep guard for proactive/sweep.test.ts: no test in this file ever calls the real api.telegram.org network endpoint", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("./sweep.test.ts", import.meta.url), "utf8");
  const realFetchCall = /fetch\(\s*["'`]https:\/\/api\.telegram\.org/;
  assert.equal(realFetchCall.test(source), false);
});
