import type { WakeEvent } from "./types.ts";

export interface WakeSource {
  read(): string | undefined;
}

export function ingestWake(source: WakeSource): WakeEvent | undefined {
  const raw = source.read();
  if (raw === undefined) return undefined;
  const value: unknown = JSON.parse(raw);
  if (!isWakeEvent(value)) throw new Error("invalid wake event");
  return value;
}

function isWakeEvent(value: unknown): value is WakeEvent {
  if (typeof value !== "object" || value === null) return false;
  const wake = value as Record<string, unknown>;
  return typeof wake.id === "string" && wake.id.length > 0
    && typeof wake.source === "string" && wake.source.length > 0
    && typeof wake.occurredAt === "number" && Number.isFinite(wake.occurredAt)
    && typeof wake.text === "string" && wake.text.length > 0;
}
