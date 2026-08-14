import { setTimeout as sleepTimer } from "node:timers/promises";
import { isTelegramUpdate, routeUpdate } from "./validation.ts";
import { TelegramApiError, type TelegramApi } from "./api.ts";
import type { TelegramEvent } from "./types.ts";

export interface Poller {
  pollOnce(): Promise<number | undefined>;
  stop(): void;
}

type FailureKind = "conflict" | "server-error" | "network" | "rate-limited" | "fatal";

const CONFLICT_BACKOFF_MS = 60_000;
const TRANSIENT_BACKOFF_MS = 5_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

function classify(error: unknown): FailureKind {
  if (!(error instanceof TelegramApiError)) return "network";
  if (error.status === 409) return "conflict";
  if (error.status === 429) return "rate-limited";
  if (error.status >= 500) return "server-error";
  return "fatal";
}

function backoffFor(kind: FailureKind, error: unknown): number {
  if (kind === "conflict") return CONFLICT_BACKOFF_MS;
  if (kind === "rate-limited") {
    const retryAfterMs = error instanceof TelegramApiError ? error.retryAfterMs : undefined;
    if (typeof retryAfterMs === "number" && retryAfterMs > 0 && retryAfterMs <= MAX_RATE_LIMIT_BACKOFF_MS) {
      return retryAfterMs;
    }
    return TRANSIENT_BACKOFF_MS;
  }
  return TRANSIENT_BACKOFF_MS;
}

export function createPoller(
  api: TelegramApi,
  onEvent: (event: TelegramEvent) => Promise<void>,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = (ms, signal) =>
    sleepTimer(ms, undefined, { signal }).catch(() => undefined),
): Poller {
  let offset: number | undefined;
  let stopped = false;
  const abort = new AbortController();
  async function fetchUpdates(): Promise<unknown[] | undefined> {
    while (true) {
      try {
        return await api.getUpdates(offset);
      } catch (error) {
        const kind = classify(error);
        if (kind === "fatal") throw error;
        if (stopped) return undefined;
        await sleep(backoffFor(kind, error), abort.signal);
        if (stopped) return undefined;
      }
    }
  }
  return {
    async pollOnce() {
      if (stopped) return offset;
      const updates = await fetchUpdates();
      if (!updates) return offset;
      for (const value of updates) {
        if (!isTelegramUpdate(value)) continue;
        offset = value.update_id + 1;
        const event = routeUpdate(value);
        if (event) await onEvent(event);
      }
      return offset;
    },
    stop() { stopped = true; abort.abort(); },
  };
}
