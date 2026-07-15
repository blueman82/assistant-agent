import { test } from "node:test";
import assert from "node:assert/strict";
import { zonedMinutesOfDay, zonedDateString } from "./push.ts";

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
