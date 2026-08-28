import { test } from "node:test";
import assert from "node:assert/strict";
import { AlertDeduplicator } from "./alerts.ts";
import { AlertDelivery } from "./delivery.ts";
import { createEvent, decodeEvent, encodeEvent } from "./events.ts";
import * as supervisor from "./index.ts";
import { RuntimeLiveness } from "./liveness.ts";
import { inQuietHours } from "./policy.ts";
import { checkWatchdog, isWatchdogFailure } from "./watchdog.ts";
import { ingestWake } from "./wake.ts";

test("supervisor keeps event and delivery boundaries local", async () => {
  const event = createEvent({ id: "wake-1", kind: "wake", source: "loop", occurredAt: 1, payload: { text: "done" } });
  assert.deepEqual(decodeEvent(encodeEvent(event)), event);
  assert.equal(inQuietHours(23 * 60, { startMinute: 22 * 60, endMinute: 8 * 60 }), true);
  const sent: string[] = [];
  const delivery = new AlertDelivery({ send: async (alert) => { sent.push(alert.text); } });
  const alert = { key: "loop-1", severity: "warning" as const, text: "stalled", createdAt: 1 };
  assert.equal((await delivery.deliver(alert, { minuteOfDay: 12 * 60, budget: { limit: 1, used: 0 } })).reason, "sent");
  assert.equal((await delivery.deliver(alert, { minuteOfDay: 12 * 60, budget: { limit: 1, used: 0 } })).reason, "duplicate");
  assert.deepEqual(sent, ["stalled"]);
});

test("AlertDeduplicator accepts a key once and rejects repeats until cleared", () => {
  const dedup = new AlertDeduplicator();
  assert.equal(dedup.accept({ key: "a", severity: "info", text: "x", createdAt: 1 }), true);
  assert.equal(dedup.accept({ key: "a", severity: "info", text: "x", createdAt: 2 }), false);
  assert.equal(dedup.accept({ key: "b", severity: "info", text: "y", createdAt: 1 }), true);
  dedup.clear("a");
  assert.equal(dedup.accept({ key: "a", severity: "info", text: "x", createdAt: 3 }), true);
});

test("RuntimeLiveness reports healthy within timeout and unhealthy once it lapses", () => {
  const liveness = new RuntimeLiveness();
  const observed = liveness.observe("telegram", 1000);
  assert.deepEqual(observed, { name: "telegram", lastSeenAt: 1000, healthy: true });
  assert.equal(liveness.check("telegram", 1500, 1000).healthy, true);
  assert.equal(liveness.check("telegram", 2500, 1000).healthy, false);
  assert.equal(liveness.get("telegram")?.healthy, false);
});

test("RuntimeLiveness treats an unobserved runtime as unhealthy and rejects bad input", () => {
  const liveness = new RuntimeLiveness();
  const state = liveness.check("ghost", 1000, 500);
  assert.deepEqual(state, { name: "ghost", lastSeenAt: 0, healthy: false });
  assert.throws(() => liveness.observe("", 1000), /runtime name and finite timestamp/);
  assert.throws(() => liveness.observe("telegram", Number.NaN), /runtime name and finite timestamp/);
});

test("ingestWake parses a valid wake event and passes through no-event", () => {
  const withEvent = { read: () => JSON.stringify({ id: "w1", source: "loop", occurredAt: 5, text: "go" }) };
  assert.deepEqual(ingestWake(withEvent), { id: "w1", source: "loop", occurredAt: 5, text: "go" });
  const empty = { read: () => undefined };
  assert.equal(ingestWake(empty), undefined);
});

test("ingestWake rejects malformed or unparsable payloads", () => {
  const missingField = { read: () => JSON.stringify({ id: "w1", source: "loop", occurredAt: 5 }) };
  assert.throws(() => ingestWake(missingField), /invalid wake event/);
  const notJson = { read: () => "not json" };
  assert.throws(() => ingestWake(notJson));
});

test("checkWatchdog reads liveness from the process probe and the progress timestamp", () => {
  const alive = { isAlive: () => true };
  const dead = { isAlive: () => false };
  const target = { name: "telegram", pid: 42, lastProgressAt: 1000, timeoutMs: 500 };
  assert.deepEqual(checkWatchdog(target, 1200, alive), { name: "telegram", alive: true, responsive: true });
  assert.deepEqual(checkWatchdog(target, 2000, alive), { name: "telegram", alive: true, responsive: false });
  assert.deepEqual(checkWatchdog(target, 1200, dead), { name: "telegram", alive: false, responsive: true });
});

test("checkWatchdog treats a missing pid or progress timestamp as passing by default", () => {
  const probe = { isAlive: () => { throw new Error("should not be called without a pid"); } };
  const result = checkWatchdog({ name: "cli", timeoutMs: 500 }, 1000, probe);
  assert.deepEqual(result, { name: "cli", alive: true, responsive: true });
});

test("isWatchdogFailure is true when either liveness or responsiveness fails", () => {
  assert.equal(isWatchdogFailure({ name: "x", alive: true, responsive: true }), false);
  assert.equal(isWatchdogFailure({ name: "x", alive: false, responsive: true }), true);
  assert.equal(isWatchdogFailure({ name: "x", alive: true, responsive: false }), true);
});

test("supervisor's barrel exports resolve to the same implementations as their source modules", () => {
  assert.equal(supervisor.inQuietHours(0, { startMinute: 0, endMinute: 0 }), true);
  const dedup = new supervisor.AlertDeduplicator();
  assert.equal(dedup.accept({ key: "z", severity: "info", text: "t", createdAt: 1 }), true);
  const event = supervisor.createEvent({ id: "e1", kind: "runtime", source: "cli", occurredAt: 1, payload: {} });
  assert.equal(supervisor.decodeEvent(supervisor.encodeEvent(event)).id, "e1");
  assert.equal(isWatchdogFailure(supervisor.checkWatchdog({ name: "cli", timeoutMs: 500 }, 1000, { isAlive: () => true })), false);
  const liveness = new supervisor.RuntimeLiveness();
  liveness.observe("cli", 0);
  assert.equal(liveness.get("cli")?.healthy, true);
});
