import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeTelegramAudio } from "../media/telegram-audio.ts";
import { voiceOrText } from "../speech/fallback.ts";
import type { Synthesizer } from "../speech/types.ts";
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

export interface BufferingReplyRenderer {
  reply(text: string): Promise<void>;
  getBuffered(): string;
}

export function createBufferingReplyRenderer(): BufferingReplyRenderer {
  const chunks: string[] = [];
  return {
    async reply(text) { chunks.push(text); },
    getBuffered: () => chunks.join("\n"),
  };
}

export interface VoiceReplyOptions {
  synthesizer: Synthesizer;
  encode?: (wavPath: string, oggPath: string) => Promise<void>;
}

export async function flushVoiceReply(
  text: string,
  api: TelegramApi,
  chatId: string,
  options: VoiceReplyOptions,
): Promise<void> {
  const clean = stripMarkdown(text).trim();
  if (!clean) return;
  const encode = options.encode ?? encodeTelegramAudio;
  const id = randomUUID();
  const wavPath = join(tmpdir(), `${id}.wav`);
  const oggPath = join(tmpdir(), `${id}.ogg`);
  try {
    const result = await voiceOrText(clean, wavPath, options.synthesizer, () => encode(wavPath, oggPath));
    if (result.kind === "voice") {
      try {
        await api.sendVoice(chatId, oggPath);
        return;
      } catch {
        // fall through to text below
      }
    }
    await createReplyRenderer(api, chatId)(clean);
  } finally {
    await unlink(wavPath).catch(() => {});
    await unlink(oggPath).catch(() => {});
  }
}

