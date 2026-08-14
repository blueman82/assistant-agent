import type { Alert } from "./types.ts";

export class AlertDeduplicator {
  private readonly seen = new Set<string>();

  accept(alert: Alert): boolean {
    if (this.seen.has(alert.key)) return false;
    this.seen.add(alert.key);
    return true;
  }

  clear(key: string): void {
    this.seen.delete(key);
  }
}
