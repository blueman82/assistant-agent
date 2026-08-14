import { AlertDeduplicator } from "./alerts.ts";
import { allowInterrupt, inQuietHours, spendInterrupt, type InterruptBudget, type QuietHours } from "./policy.ts";
import type { Alert, DeliveryResult } from "./types.ts";

export interface DeliveryPolicy {
  readonly quietHours?: QuietHours;
  readonly budget: InterruptBudget;
  readonly minuteOfDay: number;
}

export interface AlertSender {
  send(alert: Alert): Promise<void>;
}

export class ProactiveDelivery {
  private budget: InterruptBudget;
  private readonly sender: AlertSender;
  private readonly dedup: AlertDeduplicator;

  constructor(sender: AlertSender, dedup = new AlertDeduplicator(), budget: InterruptBudget = { limit: 10, used: 0 }) {
    this.sender = sender;
    this.dedup = dedup;
    this.budget = budget;
  }

  async deliver(alert: Alert, policy: DeliveryPolicy): Promise<DeliveryResult> {
    if (!this.dedup.accept(alert)) return { delivered: false, reason: "duplicate" };
    const budget = this.budget.limit === policy.budget.limit ? this.budget : policy.budget;
    if (policy.quietHours && inQuietHours(policy.minuteOfDay, policy.quietHours) && alert.severity !== "critical") {
      this.dedup.clear(alert.key);
      return { delivered: false, reason: "quiet-hours" };
    }
    if (!allowInterrupt(alert.severity, budget)) {
      this.dedup.clear(alert.key);
      return { delivered: false, reason: "budget" };
    }
    await this.sender.send(alert);
    this.budget = spendInterrupt(alert.severity, budget);
    return { delivered: true, reason: "sent" };
  }
}
