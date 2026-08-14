import type { EventKind, LocalEvent } from "./types.ts";

export function createEvent<T>(input: {
  id: string;
  kind: EventKind;
  source: string;
  occurredAt: number;
  payload: T;
}): LocalEvent<T> {
  if (!input.id || !input.source || !Number.isFinite(input.occurredAt)) {
    throw new Error("event id, source, and finite occurredAt are required");
  }
  return { version: 1, ...input };
}

export function encodeEvent(event: LocalEvent): string {
  return JSON.stringify(event);
}

export function decodeEvent(line: string): LocalEvent {
  const value: unknown = JSON.parse(line);
  if (!isLocalEvent(value)) throw new Error("invalid local event");
  return value;
}

function isLocalEvent(value: unknown): value is LocalEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return event.version === 1 && typeof event.id === "string" && event.id.length > 0
    && ["runtime", "watchdog", "wake", "alert"].includes(String(event.kind))
    && typeof event.source === "string" && event.source.length > 0
    && typeof event.occurredAt === "number" && "payload" in event;
}

export class LocalEventBus {
  private readonly listeners = new Set<(event: LocalEvent) => void>();

  subscribe(listener: (event: LocalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: LocalEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
