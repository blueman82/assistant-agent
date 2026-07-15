import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  zonedMinutesOfDay,
  zonedDateString,
  inQuietWindow,
  loadConfig,
  readFamilyFile,
  writeFamilyFile,
  push,
  getEventState,
  flushDeferred,
  cliMain,
  DEFAULT_CONFIG,
} from "./push.ts";
import type { DeferredEntry, ProactiveConfig } from "./push.ts";

function makeBaseDir(): string {
  return mkdtempSync(join(tmpdir(), "rachel-push-test-"));
}

function makeSendStub() {
  const sent: string[] = [];
  const sendFn = async (text: string): Promise<void> => {
    sent.push(text);
  };
  return { sent, sendFn };
}

// Dublin 12:00 in summer — outside the default quiet window.
const DAYTIME = () => new Date("2026-07-15T11:00:00Z");
// Dublin 23:00 in summer — inside the default quiet window.
const NIGHT = () => new Date("2026-07-15T22:00:00Z");

function readDeferredEntries(baseDir: string): DeferredEntry[] {
  return (JSON.parse(readFileSync(join(baseDir, "deferred.json"), "utf8")) as { entries: DeferredEntry[] }).entries;
}

async function withConsoleErrorCapture<T>(fn: () => Promise<T> | T): Promise<{ result: T; errors: string[] }> {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (line: unknown) => {
    errors.push(String(line));
  };
  try {
    return { result: await fn(), errors };
  } finally {
    console.error = orig;
  }
}

const DUBLIN = "Europe/Dublin";

test("zonedMinutesOfDay: 07:30 UTC in summer is 08:30 IST (510 minutes)", () => {
  assert.equal(zonedMinutesOfDay(new Date("2026-07-15T07:30:00Z"), DUBLIN), 510);
});

test("zonedMinutesOfDay: 07:30 UTC in winter is 07:30 GMT (450 minutes)", () => {
  assert.equal(zonedMinutesOfDay(new Date("2026-01-15T07:30:00Z"), DUBLIN), 450);
});

test("zonedDateString: 23:30 UTC in summer is already the next Dublin day", () => {
  assert.equal(zonedDateString(new Date("2026-07-14T23:30:00Z"), DUBLIN), "2026-07-15");
});

test("zonedDateString: plain daytime date matches UTC date", () => {
  assert.equal(zonedDateString(new Date("2026-01-15T12:00:00Z"), DUBLIN), "2026-01-15");
});

// Dublin summer time is UTC+1, so 21:30 UTC = 22:30 IST etc.
test("inQuietWindow: 22:30 Dublin exactly is quiet (inclusive start)", () => {
  assert.equal(inQuietWindow(new Date("2026-07-15T21:30:00Z"), DEFAULT_CONFIG), true);
});

test("inQuietWindow: 07:59 Dublin is quiet", () => {
  assert.equal(inQuietWindow(new Date("2026-07-15T06:59:00Z"), DEFAULT_CONFIG), true);
});

test("inQuietWindow: 08:00 Dublin exactly is not quiet (exclusive end)", () => {
  assert.equal(inQuietWindow(new Date("2026-07-15T07:00:00Z"), DEFAULT_CONFIG), false);
});

test("inQuietWindow: 12:00 Dublin is not quiet", () => {
  assert.equal(inQuietWindow(new Date("2026-07-15T11:00:00Z"), DEFAULT_CONFIG), false);
});

test("inQuietWindow: non-wrapping window 09:00-17:00 contains 12:00 but not 18:00", () => {
  const cfg: ProactiveConfig = { ...DEFAULT_CONFIG, quiet_hours: { start: "09:00", end: "17:00" } };
  assert.equal(inQuietWindow(new Date("2026-07-15T11:00:00Z"), cfg), true);
  assert.equal(inQuietWindow(new Date("2026-07-15T17:00:00Z"), cfg), false);
});

test("loadConfig: absent config.json yields DEFAULT_CONFIG", () => {
  assert.deepEqual(loadConfig(makeBaseDir()), DEFAULT_CONFIG);
});

test("loadConfig: malformed config.json falls back loudly to DEFAULT_CONFIG", async () => {
  const baseDir = makeBaseDir();
  writeFileSync(join(baseDir, "config.json"), "{not json");
  const { result, errors } = await withConsoleErrorCapture(() => loadConfig(baseDir));
  assert.deepEqual(result, DEFAULT_CONFIG);
  assert.ok(errors.length >= 1, "expected a loud config warning");
});

test("loadConfig: partial config.json merges over defaults", () => {
  const baseDir = makeBaseDir();
  writeFileSync(join(baseDir, "config.json"), JSON.stringify({ daily_budget: 3 }));
  assert.deepEqual(loadConfig(baseDir), { ...DEFAULT_CONFIG, daily_budget: 3 });
});

test("readFamilyFile: absent family file yields an empty schema_version 1 store", () => {
  assert.deepEqual(readFamilyFile(makeBaseDir(), "pr-red"), { schema_version: 1, events: {} });
});

test("family file round-trip: writeFamilyFile evicts entries with last_seen older than 14 days", () => {
  const baseDir = makeBaseDir();
  const now = new Date("2026-07-15T12:00:00Z");
  const staleSeen = now.getTime() - 15 * 24 * 60 * 60 * 1000;
  const freshSeen = now.getTime() - 60_000;
  writeFamilyFile(
    baseDir,
    "pr-red",
    {
      schema_version: 1,
      events: {
        "pr:old/repo#1": { state: "aaa:failure", first_seen: staleSeen, pinged_at: staleSeen, last_seen: staleSeen },
        "pr:new/repo#2": { state: "bbb:failure", first_seen: freshSeen, pinged_at: freshSeen, last_seen: freshSeen },
      },
    },
    now,
  );
  const onDisk = JSON.parse(readFileSync(join(baseDir, "pr-red.json"), "utf8")) as {
    schema_version: number;
    events: Record<string, unknown>;
  };
  assert.equal(onDisk.schema_version, 1);
  assert.equal(onDisk.events["pr:old/repo#1"], undefined);
  assert.ok(onDisk.events["pr:new/repo#2"]);
  assert.deepEqual(Object.keys(readFamilyFile(baseDir, "pr-red").events), ["pr:new/repo#2"]);
});

test("push: first push of a new event sends", async () => {
  const baseDir = makeBaseDir();
  const { sent, sendFn } = makeSendStub();
  const result = await push("pr-red", "pr:a/b#1", "abc:failure", "normal", "[pr] a/b #1 failing", { now: DAYTIME, baseDir, sendFn });
  assert.equal(result, "sent");
  assert.deepEqual(sent, ["[pr] a/b #1 failing"]);
});

test("push: identical re-push dedups without sending and advances last_seen", async () => {
  const baseDir = makeBaseDir();
  const { sent, sendFn } = makeSendStub();
  await push("pr-red", "pr:a/b#1", "abc:failure", "normal", "x", { now: DAYTIME, baseDir, sendFn });
  const later = () => new Date("2026-07-15T12:00:00Z");
  const result = await push("pr-red", "pr:a/b#1", "abc:failure", "normal", "x", { now: later, baseDir, sendFn });
  assert.equal(result, "dedup");
  assert.equal(sent.length, 1);
  assert.equal(readFamilyFile(baseDir, "pr-red").events["pr:a/b#1"]!.last_seen, later().getTime());
});

test("push: changed state re-arms and sends again", async () => {
  const baseDir = makeBaseDir();
  const { sent, sendFn } = makeSendStub();
  await push("pr-red", "pr:a/b#1", "abc:failure", "normal", "x", { now: DAYTIME, baseDir, sendFn });
  const result = await push("pr-red", "pr:a/b#1", "def:failure", "normal", "y", { now: DAYTIME, baseDir, sendFn });
  assert.equal(result, "sent");
  assert.deepEqual(sent, ["x", "y"]);
});

test("push: urgent sends inside the quiet window", async () => {
  const baseDir = makeBaseDir();
  const { sent, sendFn } = makeSendStub();
  const result = await push("bridge-liveness", "bridge:liveness", "down", "urgent", "[urgent · bridge] down", { now: NIGHT, baseDir, sendFn });
  assert.equal(result, "sent");
  assert.equal(sent.length, 1);
});

test("push: normal inside the quiet window defers with reason quiet and does not send", async () => {
  const baseDir = makeBaseDir();
  const { sent, sendFn } = makeSendStub();
  const result = await push("pr-red", "pr:a/b#1", "abc:failure", "normal", "x", { now: NIGHT, baseDir, sendFn });
  assert.equal(result, "deferred");
  assert.equal(sent.length, 0);
  const entries = readDeferredEntries(baseDir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.reason, "quiet");
});

test("push: digest outside the quiet window defers with reason digest", async () => {
  const baseDir = makeBaseDir();
  const { sent, sendFn } = makeSendStub();
  const result = await push("mail", "mail:t1", "fyi:m1", "digest", "x", { now: DAYTIME, baseDir, sendFn });
  assert.equal(result, "deferred");
  assert.equal(sent.length, 0);
  assert.equal(readDeferredEntries(baseDir)[0]!.reason, "digest");
});

test("push: the 11th normal of the day defers with reason budget", async () => {
  const baseDir = makeBaseDir();
  const { sent, sendFn } = makeSendStub();
  for (let i = 0; i < 10; i++) {
    assert.equal(await push("pr-red", `pr:a/b#${i}`, "s:failure", "normal", `n${i}`, { now: DAYTIME, baseDir, sendFn }), "sent");
  }
  const result = await push("pr-red", "pr:a/b#10", "s:failure", "normal", "n10", { now: DAYTIME, baseDir, sendFn });
  assert.equal(result, "deferred");
  assert.equal(sent.length, 10);
  const entries = readDeferredEntries(baseDir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.reason, "budget");
});

test("push: urgent still sends when the budget is exhausted", async () => {
  const baseDir = makeBaseDir();
  const { sent, sendFn } = makeSendStub();
  for (let i = 0; i < 10; i++) {
    await push("pr-red", `pr:a/b#${i}`, "s:failure", "normal", `n${i}`, { now: DAYTIME, baseDir, sendFn });
  }
  const result = await push("bridge-liveness", "bridge:liveness", "down", "urgent", "u", { now: DAYTIME, baseDir, sendFn });
  assert.equal(result, "sent");
  assert.equal(sent.length, 11);
});

test("push: budget counter resets when now crosses a Dublin date boundary", async () => {
  const baseDir = makeBaseDir();
  // 23:30 UTC on the 14th is already 00:30 on the 15th in Dublin (summer).
  // Override quiet hours so this time of day is not quiet — this test is
  // about the budget date rollover, not quiet deferral.
  writeFileSync(join(baseDir, "config.json"), JSON.stringify({ quiet_hours: { start: "03:00", end: "04:00" } }));
  writeFileSync(join(baseDir, "budget.json"), JSON.stringify({ schema_version: 1, date: "2026-07-14", interrupts_sent: 10 }));
  const { sent, sendFn } = makeSendStub();
  const newDay = () => new Date("2026-07-14T23:30:00Z");
  const result = await push("pr-red", "pr:a/b#1", "s:failure", "normal", "x", { now: newDay, baseDir, sendFn });
  assert.equal(result, "sent");
  assert.equal(sent.length, 1);
  const budget = JSON.parse(readFileSync(join(baseDir, "budget.json"), "utf8")) as { date: string; interrupts_sent: number };
  assert.equal(budget.date, "2026-07-15");
  assert.equal(budget.interrupts_sent, 1);
});

test("push: a deferred event dedups on a second identical push instead of re-queueing", async () => {
  const baseDir = makeBaseDir();
  const { sendFn } = makeSendStub();
  await push("mail", "mail:t1", "fyi:m1", "digest", "x", { now: DAYTIME, baseDir, sendFn });
  const result = await push("mail", "mail:t1", "fyi:m1", "digest", "x", { now: DAYTIME, baseDir, sendFn });
  assert.equal(result, "dedup");
  assert.equal(readDeferredEntries(baseDir).length, 1);
});

test("push: a sendFn throw records nothing, so the next identical push sends", async () => {
  const baseDir = makeBaseDir();
  const failingSend = async (): Promise<void> => {
    throw new Error("network down");
  };
  await assert.rejects(
    () => push("pr-red", "pr:a/b#1", "abc:failure", "normal", "x", { now: DAYTIME, baseDir, sendFn: failingSend }),
    /network down/,
  );
  assert.equal(getEventState("pr-red", "pr:a/b#1", { baseDir }), undefined);
  const { sent, sendFn } = makeSendStub();
  const result = await push("pr-red", "pr:a/b#1", "abc:failure", "normal", "x", { now: DAYTIME, baseDir, sendFn });
  assert.equal(result, "sent");
  assert.equal(sent.length, 1);
});

test("push: invalid family throws", async () => {
  const { sendFn } = makeSendStub();
  await assert.rejects(
    () => push("Bad Family!", "id", "s", "normal", "x", { now: DAYTIME, baseDir: makeBaseDir(), sendFn }),
    /family/,
  );
});

test("push: invalid severity throws", async () => {
  const { sendFn } = makeSendStub();
  await assert.rejects(
    () => push("pr-red", "id", "s", "loud" as never, "x", { now: DAYTIME, baseDir: makeBaseDir(), sendFn }),
    /severity/,
  );
});

function writeDeferredEntries(baseDir: string, entries: DeferredEntry[]): void {
  writeFileSync(join(baseDir, "deferred.json"), JSON.stringify({ schema_version: 1, entries }));
}

// 2 quiet + 1 budget + 1 digest, in queue order.
function fourEntryQueue(): DeferredEntry[] {
  return [
    { family: "pr-red", event_id: "pr:a/b#1", state: "s1:failure", text: "[pr] a/b #1 checks failing", queued_at: 1000, reason: "quiet" },
    { family: "mail", event_id: "mail:t1", state: "action-required:m1", text: "[mail] Nico: reply needed", queued_at: 2000, reason: "quiet" },
    { family: "pr-red", event_id: "pr:c/d#2", state: "s2:failure", text: "[pr] c/d #2 checks failing", queued_at: 3000, reason: "budget" },
    { family: "mail", event_id: "mail:t2", state: "fyi:m2", text: "[mail] receipt from Amazon", queued_at: 4000, reason: "digest" },
  ];
}

// Dublin 08:10 in summer (07:10 UTC) — outside quiet, budget-eligible hour 8.
const MORNING_0810 = () => new Date("2026-07-15T07:10:00Z");
// Dublin 09:30 in summer — outside quiet, NOT a budget-eligible hour.
const MIDMORNING_0930 = () => new Date("2026-07-15T08:30:00Z");

test("flushDeferred: empty queue returns empty and never sends", async () => {
  const baseDir = makeBaseDir();
  const { sent, sendFn } = makeSendStub();
  assert.equal(await flushDeferred({ now: MORNING_0810, baseDir, sendFn }), "empty");
  assert.equal(sent.length, 0);
});

test("flushDeferred: inside the quiet window returns quiet and leaves the queue intact", async () => {
  const baseDir = makeBaseDir();
  writeDeferredEntries(baseDir, fourEntryQueue());
  const { sent, sendFn } = makeSendStub();
  assert.equal(await flushDeferred({ now: NIGHT, baseDir, sendFn }), "quiet");
  assert.equal(sent.length, 0);
  assert.equal(readDeferredEntries(baseDir).length, 4);
});

test("flushDeferred: at a budget-eligible hour flushes all four entries as one message with the exact header", async () => {
  const baseDir = makeBaseDir();
  writeDeferredEntries(baseDir, fourEntryQueue());
  const { sent, sendFn } = makeSendStub();
  assert.equal(await flushDeferred({ now: MORNING_0810, baseDir, sendFn }), "sent");
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.startsWith("[digest] 4 items (2 overnight, 1 over budget):"));
  for (const entry of fourEntryQueue()) {
    assert.ok(sent[0]!.includes(entry.text), `message missing entry text: ${entry.text}`);
  }
  assert.equal(readDeferredEntries(baseDir).length, 0);
});

test("flushDeferred: at a non-budget-eligible hour flushes three and the budget entry alone survives", async () => {
  const baseDir = makeBaseDir();
  writeDeferredEntries(baseDir, fourEntryQueue());
  const { sent, sendFn } = makeSendStub();
  assert.equal(await flushDeferred({ now: MIDMORNING_0930, baseDir, sendFn }), "sent");
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.startsWith("[digest] 3 items (2 overnight):"));
  assert.equal(sent[0]!.includes("[pr] c/d #2 checks failing"), false);
  const remaining = readDeferredEntries(baseDir);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]!.reason, "budget");
});

test("flushDeferred: an entry appended concurrently during the send survives the write-back", async () => {
  const baseDir = makeBaseDir();
  writeDeferredEntries(baseDir, fourEntryQueue());
  const fresh: DeferredEntry = { family: "mail", event_id: "mail:t9", state: "fyi:m9", text: "fresh", queued_at: 9000, reason: "digest" };
  const sendFn = async (): Promise<void> => {
    writeDeferredEntries(baseDir, [...readDeferredEntries(baseDir) as DeferredEntry[], fresh]);
  };
  assert.equal(await flushDeferred({ now: MORNING_0810, baseDir, sendFn }), "sent");
  const remaining = readDeferredEntries(baseDir);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]!.event_id, "mail:t9");
});

test("flushDeferred: a sendFn throw leaves the queue intact (defer never drops)", async () => {
  const baseDir = makeBaseDir();
  writeDeferredEntries(baseDir, fourEntryQueue());
  const failingSend = async (): Promise<void> => {
    throw new Error("network down");
  };
  await assert.rejects(() => flushDeferred({ now: MORNING_0810, baseDir, sendFn: failingSend }), /network down/);
  assert.equal(readDeferredEntries(baseDir).length, 4);
});

test("flushDeferred: a single quiet entry reads [digest] 1 item (1 overnight):", async () => {
  const baseDir = makeBaseDir();
  writeDeferredEntries(baseDir, [fourEntryQueue()[0]!]);
  const { sent, sendFn } = makeSendStub();
  assert.equal(await flushDeferred({ now: MORNING_0810, baseDir, sendFn }), "sent");
  assert.ok(sent[0]!.startsWith("[digest] 1 item (1 overnight):"));
});

test("getEventState: returns the stored state for a pinged event", async () => {
  const baseDir = makeBaseDir();
  const { sendFn } = makeSendStub();
  await push("bridge-liveness", "bridge:liveness", "down", "urgent", "x", { now: DAYTIME, baseDir, sendFn });
  assert.equal(getEventState("bridge-liveness", "bridge:liveness", { baseDir }), "down");
  assert.equal(getEventState("bridge-liveness", "bridge:other", { baseDir }), undefined);
});

// cliMain receives a full process.argv-shaped array: [node, script, ...args].
function cliArgv(...args: string[]): string[] {
  return ["node", "proactive/push.ts", ...args];
}

function writeMessageFile(baseDir: string, text: string): string {
  const path = join(baseDir, "message.txt");
  writeFileSync(path, text);
  return path;
}

test("cliMain: happy path returns 0, sends the file's text, prints [push] sent.", async () => {
  const baseDir = makeBaseDir();
  const { sent, sendFn } = makeSendStub();
  const messageFile = writeMessageFile(baseDir, "[pr] a/b #1 checks failing");
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (line: string) => logged.push(line);
  let code: number;
  try {
    code = await cliMain(cliArgv("pr-red", "pr:a/b#1", "abc:failure", "normal", messageFile), { now: DAYTIME, baseDir, sendFn });
  } finally {
    console.log = origLog;
  }
  assert.equal(code, 0);
  assert.deepEqual(sent, ["[pr] a/b #1 checks failing"]);
  assert.deepEqual(logged, ["[push] sent."]);
});

test("cliMain: too few args returns 2 and never sends", async () => {
  const { sent, sendFn } = makeSendStub();
  const code = await cliMain(cliArgv("pr-red", "pr:a/b#1"), { now: DAYTIME, baseDir: makeBaseDir(), sendFn });
  assert.equal(code, 2);
  assert.equal(sent.length, 0);
});

test("cliMain: a sixth destination-looking argument is rejected with 2 and never sends (no-destination pin)", async () => {
  const baseDir = makeBaseDir();
  const { sent, sendFn } = makeSendStub();
  const messageFile = writeMessageFile(baseDir, "x");
  const code = await cliMain(
    cliArgv("pr-red", "pr:a/b#1", "abc:failure", "normal", messageFile, "@evil_chat"),
    { now: DAYTIME, baseDir, sendFn },
  );
  assert.equal(code, 2);
  assert.equal(sent.length, 0);
});

test("cliMain: bad severity returns 2 and never sends", async () => {
  const baseDir = makeBaseDir();
  const { sent, sendFn } = makeSendStub();
  const messageFile = writeMessageFile(baseDir, "x");
  const code = await cliMain(cliArgv("pr-red", "pr:a/b#1", "abc:failure", "loud", messageFile), { now: DAYTIME, baseDir, sendFn });
  assert.equal(code, 2);
  assert.equal(sent.length, 0);
});

test("cliMain: missing message file returns 2 and never sends", async () => {
  const baseDir = makeBaseDir();
  const { sent, sendFn } = makeSendStub();
  const code = await cliMain(
    cliArgv("pr-red", "pr:a/b#1", "abc:failure", "normal", join(baseDir, "no-such-file.txt")),
    { now: DAYTIME, baseDir, sendFn },
  );
  assert.equal(code, 2);
  assert.equal(sent.length, 0);
});

test("cliMain: a sendFn throw returns 1", async () => {
  const baseDir = makeBaseDir();
  const messageFile = writeMessageFile(baseDir, "x");
  const failingSend = async (): Promise<void> => {
    throw new Error("network down");
  };
  const code = await cliMain(
    cliArgv("pr-red", "pr:a/b#1", "abc:failure", "normal", messageFile),
    { now: DAYTIME, baseDir, sendFn: failingSend },
  );
  assert.equal(code, 1);
});

// ─── Store corruption semantics (review MERGE-BLOCKER + IMPORTANT 2) ────────

test("corrupt deferred.json makes flushDeferred throw and leaves the file byte-identical", async () => {
  const baseDir = makeBaseDir();
  writeFileSync(join(baseDir, "deferred.json"), "{corrupt");
  const { sent, sendFn } = makeSendStub();
  await assert.rejects(() => flushDeferred({ now: MORNING_0810, baseDir, sendFn }), /deferred\.json/);
  assert.equal(sent.length, 0);
  assert.equal(readFileSync(join(baseDir, "deferred.json"), "utf8"), "{corrupt");
});

test("corrupt family file makes push throw instead of silently re-arming everything", async () => {
  const baseDir = makeBaseDir();
  writeFileSync(join(baseDir, "pr-red.json"), "{corrupt");
  const { sent, sendFn } = makeSendStub();
  await assert.rejects(
    () => push("pr-red", "pr:a/b#1", "abc:failure", "normal", "x", { now: DAYTIME, baseDir, sendFn }),
    /pr-red\.json/,
  );
  assert.equal(sent.length, 0);
});

test("family file with wrong schema_version is treated as corrupt (push throws)", async () => {
  const baseDir = makeBaseDir();
  writeFileSync(join(baseDir, "pr-red.json"), JSON.stringify({ schema_version: 2, events: {} }));
  const { sendFn } = makeSendStub();
  await assert.rejects(
    () => push("pr-red", "pr:a/b#1", "abc:failure", "normal", "x", { now: DAYTIME, baseDir, sendFn }),
    /pr-red\.json/,
  );
});

test("deferred.json with non-array entries is treated as corrupt (flush throws)", async () => {
  const baseDir = makeBaseDir();
  writeFileSync(join(baseDir, "deferred.json"), JSON.stringify({ schema_version: 1, entries: {} }));
  const { sendFn } = makeSendStub();
  await assert.rejects(() => flushDeferred({ now: MORNING_0810, baseDir, sendFn }), /deferred\.json/);
});

test("corrupt budget.json is loud but leaky-safe: push warns, still sends, and rewrites a clean counter", async () => {
  const baseDir = makeBaseDir();
  writeFileSync(join(baseDir, "budget.json"), "{corrupt");
  const { sent, sendFn } = makeSendStub();
  const { result, errors } = await withConsoleErrorCapture(() =>
    push("pr-red", "pr:a/b#1", "abc:failure", "normal", "x", { now: DAYTIME, baseDir, sendFn }),
  );
  assert.equal(result, "sent");
  assert.equal(sent.length, 1);
  assert.ok(errors.some((line) => line.includes("budget.json")), "expected a loud budget.json warning");
  const budget = JSON.parse(readFileSync(join(baseDir, "budget.json"), "utf8")) as { date: string; interrupts_sent: number };
  assert.equal(budget.interrupts_sent, 1);
});

// ─── Config validation (review IMPORTANT 1) ─────────────────────────────────

test("loadConfig: partial nested quiet_hours falls back loudly to DEFAULT_CONFIG", async () => {
  const baseDir = makeBaseDir();
  writeFileSync(join(baseDir, "config.json"), JSON.stringify({ quiet_hours: { start: "23:00" } }));
  const { result, errors } = await withConsoleErrorCapture(() => loadConfig(baseDir));
  assert.deepEqual(result, DEFAULT_CONFIG);
  assert.ok(errors.length >= 1, "expected a loud config warning");
});

test("loadConfig: unknown timezone falls back loudly to DEFAULT_CONFIG", async () => {
  const baseDir = makeBaseDir();
  writeFileSync(join(baseDir, "config.json"), JSON.stringify({ timezone: "Mars/Olympus_Mons" }));
  const { result, errors } = await withConsoleErrorCapture(() => loadConfig(baseDir));
  assert.deepEqual(result, DEFAULT_CONFIG);
  assert.ok(errors.length >= 1);
});

test("loadConfig: null daily_budget falls back loudly to DEFAULT_CONFIG", async () => {
  const baseDir = makeBaseDir();
  writeFileSync(join(baseDir, "config.json"), JSON.stringify({ daily_budget: null }));
  const { result, errors } = await withConsoleErrorCapture(() => loadConfig(baseDir));
  assert.deepEqual(result, DEFAULT_CONFIG);
  assert.ok(errors.length >= 1);
});

test("loadConfig: non-integer calendar_oneshot_hours falls back loudly to DEFAULT_CONFIG", async () => {
  const baseDir = makeBaseDir();
  writeFileSync(join(baseDir, "config.json"), JSON.stringify({ calendar_oneshot_hours: [8, "11"] }));
  const { result, errors } = await withConsoleErrorCapture(() => loadConfig(baseDir));
  assert.deepEqual(result, DEFAULT_CONFIG);
  assert.ok(errors.length >= 1);
});

// ─── Flush eligibility gaps (review IMPORTANT 3) ────────────────────────────

test("flushDeferred: the quiet-window-end hour is budget-eligible independently of calendar_oneshot_hours", async () => {
  const baseDir = makeBaseDir();
  writeFileSync(
    join(baseDir, "config.json"),
    JSON.stringify({ quiet_hours: { start: "22:30", end: "09:00" }, calendar_oneshot_hours: [11, 14] }),
  );
  writeDeferredEntries(baseDir, [
    { family: "pr-red", event_id: "pr:a/b#1", state: "s:failure", text: "[pr] a/b #1 checks failing", queued_at: 1000, reason: "budget" },
  ]);
  const { sent, sendFn } = makeSendStub();
  // Dublin 09:10 in summer = 08:10 UTC; hour 9 = quiet end hour, not a one-shot hour.
  const result = await flushDeferred({ now: () => new Date("2026-07-15T08:10:00Z"), baseDir, sendFn });
  assert.equal(result, "sent");
  assert.equal(sent.length, 1);
  assert.equal(readDeferredEntries(baseDir).length, 0);
});

test("flushDeferred: an only-budget queue at a non-eligible hour returns empty and preserves the queue", async () => {
  const baseDir = makeBaseDir();
  const entries: DeferredEntry[] = [
    { family: "pr-red", event_id: "pr:a/b#1", state: "s1:failure", text: "b1", queued_at: 1000, reason: "budget" },
    { family: "pr-red", event_id: "pr:c/d#2", state: "s2:failure", text: "b2", queued_at: 2000, reason: "budget" },
  ];
  writeDeferredEntries(baseDir, entries);
  const { sent, sendFn } = makeSendStub();
  assert.equal(await flushDeferred({ now: MIDMORNING_0930, baseDir, sendFn }), "empty");
  assert.equal(sent.length, 0);
  assert.deepEqual(readDeferredEntries(baseDir), entries);
});

test("flushDeferred: cross-family entries sharing queued_at and event_id are not confused by the write-back", async () => {
  const baseDir = makeBaseDir();
  writeDeferredEntries(baseDir, [
    { family: "mail", event_id: "x", state: "fyi:m1", text: "digest item", queued_at: 1000, reason: "digest" },
    { family: "pr-red", event_id: "x", state: "s:failure", text: "budget item", queued_at: 1000, reason: "budget" },
  ]);
  const { sent, sendFn } = makeSendStub();
  // Non-budget-eligible hour: only the digest entry flushes; the budget entry
  // shares queued_at+event_id and must NOT be swept out with it.
  assert.equal(await flushDeferred({ now: MIDMORNING_0930, baseDir, sendFn }), "sent");
  assert.equal(sent.length, 1);
  const remaining = readDeferredEntries(baseDir);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]!.family, "pr-red");
  assert.equal(remaining[0]!.reason, "budget");
});

// ─── Budget isolation pins (review hardening 6) ─────────────────────────────

test("an urgent send never creates or touches budget.json", async () => {
  const baseDir = makeBaseDir();
  const { sendFn } = makeSendStub();
  await push("bridge-liveness", "bridge:liveness", "down", "urgent", "x", { now: DAYTIME, baseDir, sendFn });
  assert.equal(existsSync(join(baseDir, "budget.json")), false);
});

test("a digest flush never creates or touches budget.json", async () => {
  const baseDir = makeBaseDir();
  writeDeferredEntries(baseDir, fourEntryQueue());
  const { sendFn } = makeSendStub();
  assert.equal(await flushDeferred({ now: MORNING_0810, baseDir, sendFn }), "sent");
  assert.equal(existsSync(join(baseDir, "budget.json")), false);
});

test("push: a post-send store-write failure still returns 'sent' with exactly one delivery and a loud path-naming log — never a rejection the caller could re-send on", async () => {
  const baseDir = makeBaseDir();
  const { sent, sendFn } = makeSendStub();
  // A directory squatting on the family file's temp path makes the atomic
  // write throw AFTER sendFn has already delivered.
  mkdirSync(join(baseDir, `pr-red.json.tmp-${process.pid}`));
  const { result, errors } = await withConsoleErrorCapture(() =>
    push("pr-red", "pr:owner/repo#1", "abc:failure", "normal", "[pr] owner/repo #1 checks failing", { now: DAYTIME, baseDir, sendFn }),
  );
  assert.equal(result, "sent", "a delivered alert is 'sent' even when the bookkeeping write fails");
  assert.equal(sent.length, 1, "exactly one delivery — the caller must never be told to re-send");
  assert.ok(
    errors.some((e) => e.includes(baseDir)),
    `loud log names the store path: ${JSON.stringify(errors)}`,
  );
});

test("grep guard: no test in this file ever calls the real api.telegram.org network endpoint", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("./push.test.ts", import.meta.url), "utf8");
  const realFetchCall = /fetch\(\s*["'`]https:\/\/api\.telegram\.org/;
  assert.equal(realFetchCall.test(source), false);
});
