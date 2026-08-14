import { createTelegramApi, type TelegramApi } from "./api.ts";
import { createPoller, type Poller } from "./polling.ts";
import { createSingleFlightQueue, type Queue } from "./queue.ts";
import { createBufferingReplyRenderer, createReplyRenderer, flushVoiceReply } from "./replies.ts";
import { routeUpdate } from "./validation.ts";
import { downloadMedia } from "./media.ts";
import type { Synthesizer, Transcriber } from "../speech/types.ts";
import type { TelegramCallbackQuery } from "./types.ts";
import type { TelegramConfig, TelegramMessage } from "./types.ts";
import { handleCommand, parseCommand, type CommandContext, type TelegramMemoryService } from "./commands.ts";

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
  synthesizer?: Synthesizer;
  encodeAudio?: (wavPath: string, oggPath: string) => Promise<void>;
  onCallback?: (query: TelegramCallbackQuery) => Promise<void>;
  memory?: TelegramMemoryService;
  commandContext?: Pick<CommandContext, "reset" | "stop" | "status">;
}

async function handleMessage(
  message: TelegramMessage,
  api: TelegramApi,
  config: TelegramConfig,
  turn: (input: string, reply: (text: string) => Promise<void>) => Promise<void>,
  reply: (text: string) => Promise<void>,
  options: RuntimeOptions,
): Promise<void> {
  if (message.text) {
    process.stdout.write(`${new Date().toISOString()} message received kind=text\n`); const command = parseCommand(message.text);
    if (command && ["remember", "forget", "reset"].includes(command.command)) {
      const response = await handleCommand(message.text, {
        reset: options.commandContext?.reset ?? (() => {}),
        stop: options.commandContext?.stop ?? (() => false),
        status: options.commandContext?.status ?? (() => ""),
        memory: options.memory,
      });
      if (response) return await reply(response);
    }
    await turn(message.text, reply); return process.stdout.write(`${new Date().toISOString()} reply flush outcome=text\n`) as unknown as void;
  }
  if (!options.mediaDirectory) {
    process.stdout.write(`${new Date().toISOString()} message received kind=other\n`);
    return;
  }
  const media = await downloadMedia(api, message, options.mediaDirectory);
  if (!media) {
    process.stdout.write(`${new Date().toISOString()} message received kind=other\n`);
    return;
  }
  if (media.kind !== "voice") {
    process.stdout.write(`${new Date().toISOString()} message received kind=${media.kind}\n`);
    return await turn(media.text, reply);
  }
  process.stdout.write(`${new Date().toISOString()} message received kind=voice\n`);
  if (!options.transcriber) return await reply("Voice notes aren't supported right now.");
  let transcript: string;
  try {
    transcript = await options.transcriber.transcribe(media.path);
    process.stdout.write(`${new Date().toISOString()} transcription outcome=success\n`);
  } catch {
    process.stdout.write(`${new Date().toISOString()} transcription outcome=failure\n`);
    return await reply("Sorry, I couldn't transcribe that voice note. Please try again or send it as text.");
  }
  const buffered = createBufferingReplyRenderer();
  try {
    await turn(transcript, buffered.reply);
  } finally {
    const text = buffered.getBuffered();
    let outcome = "none";
    if (text.trim() && options.synthesizer) {
      await flushVoiceReply(text, api, config.chatId, { synthesizer: options.synthesizer, encode: options.encodeAudio });
      outcome = "voice";
    } else if (text.trim()) {
      await reply(text);
      outcome = "text";
    }
    process.stdout.write(`${new Date().toISOString()} reply flush outcome=${outcome}\n`);
  }
}

export function createTelegramRuntime(
  config: TelegramConfig,
  turn: (input: string, reply: (text: string) => Promise<void>) => Promise<void>,
  options: RuntimeOptions = {},
): TelegramRuntime {
  const api = options.api ?? createTelegramApi(config);
  const reply = createReplyRenderer(api, config.chatId);
  const queue = createSingleFlightQueue<TelegramMessage>(
    (message) => handleMessage(message, api, config, turn, reply, options),
    (error) => {
      process.stderr.write(`${new Date().toISOString()} message handling error: ${error instanceof Error ? error.message : String(error)}\n`);
      void reply(`Something went wrong handling that message: ${error instanceof Error ? error.message : String(error)}`);
    },
  );
  const poller = createPoller(api, async (event) => {
    const routed = routeUpdate(event.update);
    if (routed?.kind === "callback") return await options.onCallback?.(routed.callback);
    if (routed?.kind !== "message") return;
    if (String(routed.message.chat.id) !== config.chatId) {
      process.stdout.write(`${new Date().toISOString()} message dropped chat_id=${routed.message.chat.id}\n`);
      return;
    }
    queue.add(routed.message);
  });
  return { api, poller, queue, stop: () => poller.stop() };
}
