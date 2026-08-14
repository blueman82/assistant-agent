export type EventKind = "runtime" | "watchdog" | "wake" | "alert";
export type Severity = "info" | "warning" | "critical";

export interface LocalEvent<T = unknown> {
  readonly version: 1;
  readonly id: string;
  readonly kind: EventKind;
  readonly source: string;
  readonly occurredAt: number;
  readonly payload: T;
}

export interface RuntimeState {
  readonly name: string;
  readonly lastSeenAt: number;
  readonly healthy: boolean;
}

export interface WatchTarget {
  readonly name: string;
  readonly pid?: number;
  readonly lastProgressAt?: number;
  readonly timeoutMs: number;
}

export interface WakeEvent {
  readonly id: string;
  readonly source: string;
  readonly occurredAt: number;
  readonly text: string;
}

export interface Alert {
  readonly key: string;
  readonly severity: Severity;
  readonly text: string;
  readonly createdAt: number;
}

export interface DeliveryResult {
  readonly delivered: boolean;
  readonly reason: "sent" | "duplicate" | "quiet-hours" | "budget";
}
