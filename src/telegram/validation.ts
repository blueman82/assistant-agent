import type { TelegramEvent, TelegramUpdate } from "./types.ts";

export function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  if (value === null || typeof value !== "object") return false;
  const update = value as Record<string, unknown>;
  return typeof update.update_id === "number" &&
    (isMessage(update.message) || isCallback(update.callback_query));
}

function isMessage(value: unknown): boolean {
  if (value === undefined) return false;
  if (value === null || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  const chat = message.chat as Record<string, unknown> | undefined;
  return typeof message.message_id === "number" && !!chat && typeof chat.id === "number";
}

function isCallback(value: unknown): boolean {
  if (value === undefined) return false;
  if (value === null || typeof value !== "object") return false;
  const callback = value as Record<string, unknown>;
  const from = callback.from as Record<string, unknown> | undefined;
  return typeof callback.id === "string" && !!from && typeof from.id === "number";
}

export function routeUpdate(update: TelegramUpdate): TelegramEvent | undefined {
  if (update.callback_query) return { kind: "callback", callback: update.callback_query, update };
  if (update.message) return { kind: "message", message: update.message, update };
  return undefined;
}

