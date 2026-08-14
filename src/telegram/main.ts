import { AgentError, type TurnEvent } from "../core/contracts.ts";
import { providerFromEnvironment } from "../providers/selection.ts";
import { createProviderRuntime } from "../providers/runtime.ts";
import { createTelegramRuntime } from "./runtime.ts";
import type { TelegramConfig } from "./types.ts";

function configFromEnvironment(env: NodeJS.ProcessEnv = process.env): TelegramConfig {
  const token = env.RACHEL_TELEGRAM_TOKEN;
  const chatId = env.RACHEL_TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new AgentError("telegram_config_missing", "RACHEL_TELEGRAM_TOKEN and RACHEL_TELEGRAM_CHAT_ID are required");
  return { token, chatId };
}

function replyFor(event: TurnEvent, reply: (text: string) => Promise<void>): Promise<void> | undefined {
  if (event.type === "text") return reply(event.text);
  if (event.type === "error") throw event.error;
  return undefined;
}

export async function runTelegram(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const provider = providerFromEnvironment(env);
  const runtime = createProviderRuntime(provider);
  const status = await runtime.checkAvailability();
  if (!status.authenticated) throw new AgentError("authentication_unavailable", status.message ?? `${provider} OAuth is unavailable`);
  const session = await runtime.startSession();
  const telegram = createTelegramRuntime(configFromEnvironment(env), async (text, reply) => {
    for await (const event of session.run({ text })) await replyFor(event, reply);
  });
  process.once("SIGINT", telegram.stop);
  try { while (true) await telegram.poller.pollOnce(); }
  finally { telegram.stop(); await session.stop("shutdown"); process.removeListener("SIGINT", telegram.stop); }
}

if (process.argv[1]?.endsWith("/src/telegram/main.ts")) {
  runTelegram().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Telegram runtime could not start: ${message}\n`);
    process.exitCode = 1;
  });
}
