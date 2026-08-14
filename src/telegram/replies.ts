import type { TelegramApi } from "./api.ts";

export function stripMarkdown(text: string): string {
  return text.replace(/^#{1,6}\s+/gmu, "").replace(/\*\*(.*?)\*\*/gs, "$1").replace(/`([^`]+)`/g, "$1");
}

export function createReplyRenderer(api: TelegramApi, chatId: string): (text: string) => Promise<void> {
  return async (text) => {
    const clean = stripMarkdown(text);
    for (let start = 0; start < clean.length; start += 4096) {
      await api.call("sendMessage", { chat_id: chatId, text: clean.slice(start, start + 4096) });
    }
  };
}

