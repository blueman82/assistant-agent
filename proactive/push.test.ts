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
