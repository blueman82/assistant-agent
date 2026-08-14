import { test } from "node:test";
import assert from "node:assert/strict";
import { ProactiveDelivery } from "./delivery.ts";
import { createEvent, decodeEvent, encodeEvent } from "./events.ts";
import { inQuietHours } from "./policy.ts";

test("supervisor keeps event and delivery boundaries local", async () => {
  const event = createEvent({ id: "wake-1", kind: "wake", source: "loop", occurredAt: 1, payload: { text: "done" } });
  assert.deepEqual(decodeEvent(encodeEvent(event)), event);
  assert.equal(inQuietHours(23 * 60, { startMinute: 22 * 60, endMinute: 8 * 60 }), true);
  const sent: string[] = [];
  const delivery = new ProactiveDelivery({ send: async (alert) => { sent.push(alert.text); } });
  const alert = { key: "loop-1", severity: "warning" as const, text: "stalled", createdAt: 1 };
  assert.equal((await delivery.deliver(alert, { minuteOfDay: 12 * 60, budget: { limit: 1, used: 0 } })).reason, "sent");
  assert.equal((await delivery.deliver(alert, { minuteOfDay: 12 * 60, budget: { limit: 1, used: 0 } })).reason, "duplicate");
  assert.deepEqual(sent, ["stalled"]);
});
