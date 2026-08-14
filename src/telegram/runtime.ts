import { createTelegramApi, type TelegramApi } from "./api.ts";
import { createPoller, type Poller } from "./polling.ts";
import { createSingleFlightQueue, type Queue } from "./queue.ts";
import { createReplyRenderer } from "./replies.ts";
import { routeUpdate } from "./validation.ts";
import { downloadMedia } from "./media.ts";
import type { Transcriber } from "../speech/types.ts";
import type { TelegramCallbackQuery } from "./types.ts";
import type { TelegramConfig, TelegramMessage } from "./types.ts";

export interface TelegramRuntime {
  api: TelegramApi;
  poller: Poller;
  queue: Queue<TelegramMessage>;
  stop(): void;
}

export interface RuntimeOptions {
  api?: TelegramApi;
  mediaDirectory?: string;
  transcriber?: Transcriber;
  onCallback?: (query: TelegramCallbackQuery) => Promise<void>;
}

export function createTelegramRuntime(
  config: TelegramConfig,
  turn: (input: string, reply: (text: string) => Promise<void>) => Promise<void>,
  options: RuntimeOptions = {},
): TelegramRuntime {
  const api = options.api ?? createTelegramApi(config);
  const reply = createReplyRenderer(api, config.chatId);
  const queue = createSingleFlightQueue<TelegramMessage>(
    async (message) => {
      if (message.text) return await turn(message.text, reply);
      if (!options.mediaDirectory) return;
      const media = await downloadMedia(api, message, options.mediaDirectory);
      if (!media) return;
      if (media.kind !== "voice") return await turn(media.text, reply);
      if (!options.transcriber) return await reply("Voice notes aren't supported right now.");
      try {
        const transcript = await options.transcriber.transcribe(media.path);
        await turn(transcript, reply);
      } catch {
        await reply("Sorry, I couldn't transcribe that voice note. Please try again or send it as text.");
      }
    },
    (error) => { void reply(`Something went wrong handling that message: ${error instanceof Error ? error.message : String(error)}`); },
  );
  const poller = createPoller(api, async (event) => {
    const routed = routeUpdate(event.update);
    if (routed?.kind === "callback") return await options.onCallback?.(routed.callback);
    if (routed?.kind === "message" && String(routed.message.chat.id) === config.chatId) queue.add(routed.message);
  });
  return { api, poller, queue, stop: () => poller.stop() };
}
