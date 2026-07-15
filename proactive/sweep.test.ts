import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepTick } from "./sweep.ts";
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
  await sweepTick(h.deps);
  assert.ok(h.pushes[0]!.text.includes("Last log 23m ago"), `text names the mtime age: ${h.pushes[0]!.text}`);
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
