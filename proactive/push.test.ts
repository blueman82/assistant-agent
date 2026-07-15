import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  zonedMinutesOfDay,
  zonedDateString,
  inQuietWindow,
  loadConfig,
  readFamilyFile,
  writeFamilyFile,
  DEFAULT_CONFIG,
} from "./push.ts";
import type { ProactiveConfig } from "./push.ts";

function makeBaseDir(): string {
  return mkdtempSync(join(tmpdir(), "rachel-push-test-"));
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
