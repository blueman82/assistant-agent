import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  zonedMinutesOfDay,
  zonedDateString,
  inQuietWindow,
  loadConfig,
  readFamilyFile,
  writeFamilyFile,
  push,
  getEventState,
  DEFAULT_CONFIG,
} from "./push.ts";
import type { ProactiveConfig } from "./push.ts";

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

interface DeferredEntry {
  family: string;
  event_id: string;
  state: string;
  text: string;
  queued_at: number;
  reason: string;
}

function readDeferredEntries(baseDir: string): DeferredEntry[] {
  return (JSON.parse(readFileSync(join(baseDir, "deferred.json"), "utf8")) as { entries: DeferredEntry[] }).entries;
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

test("loadConfig: malformed config.json yields DEFAULT_CONFIG", () => {
  const baseDir = makeBaseDir();
  writeFileSync(join(baseDir, "config.json"), "{not json");
  assert.deepEqual(loadConfig(baseDir), DEFAULT_CONFIG);
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

test("getEventState: returns the stored state for a pinged event", async () => {
  const baseDir = makeBaseDir();
  const { sendFn } = makeSendStub();
  await push("bridge-liveness", "bridge:liveness", "down", "urgent", "x", { now: DAYTIME, baseDir, sendFn });
  assert.equal(getEventState("bridge-liveness", "bridge:liveness", { baseDir }), "down");
  assert.equal(getEventState("bridge-liveness", "bridge:other", { baseDir }), undefined);
});
