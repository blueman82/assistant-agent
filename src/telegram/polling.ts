import { isTelegramUpdate, routeUpdate } from "./validation.ts";
import type { TelegramApi } from "./api.ts";
import type { TelegramEvent } from "./types.ts";

export interface Poller {
  pollOnce(): Promise<number | undefined>;
  stop(): void;
}

export function createPoller(api: TelegramApi, onEvent: (event: TelegramEvent) => Promise<void>): Poller {
  let offset: number | undefined;
  let stopped = false;
  return {
    async pollOnce() {
      if (stopped) return offset;
      const updates = await api.getUpdates(offset);
      for (const value of updates) {
        if (!isTelegramUpdate(value)) continue;
        offset = value.update_id + 1;
        const event = routeUpdate(value);
        if (event) await onEvent(event);
      }
      return offset;
    },
    stop() { stopped = true; },
  };
}

