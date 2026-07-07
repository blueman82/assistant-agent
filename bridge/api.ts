// Thin plain-fetch Telegram Bot API client. No deps beyond node's global
// fetch. Every error/log path redacts the bot token so launchd's on-disk
// logs never carry it.

type Transport = typeof fetch;

export interface ApiConfig {
  token: string;
  chatId: string;
  transport?: Transport;
}

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

// Strips the bot token out of any URL string before it reaches a log line
// or thrown error — launchd persists stdout/stderr to disk with every
// request URL otherwise carrying the token in plaintext.
export function redact(text: string): string {
  return text.replace(/bot[^/]+/, "bot<redacted>");
}

interface TelegramResponseBody {
  ok: boolean;
  description?: string;
  result?: unknown;
}

// Calls a Telegram Bot API method and returns its `result`. Throws on
// either a non-ok HTTP response or a body with ok:false — callers never see
// a "successful" call that Telegram actually rejected.
export async function tg(config: ApiConfig, method: string, body: unknown): Promise<unknown> {
  const transport = config.transport ?? fetch;
  const url = `https://api.telegram.org/bot${config.token}/${method}`;
  let res: Response;
  let parsed: TelegramResponseBody;
  try {
    res = await transport(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    parsed = (await res.json()) as TelegramResponseBody;
  } catch (err) {
    throw new Error(redact(`Telegram ${method} request failed: ${err instanceof Error ? err.message : String(err)}`));
  }
  if (!res.ok || !parsed.ok) {
    throw new Error(redact(`Telegram ${method} failed: ${parsed.description ?? "unknown error"}`));
  }
  return parsed.result;
}

// Splits text at the last newline at-or-before the 4096-char boundary when
// one exists (avoids cutting mid-word/mid-sentence); falls back to a hard
// cut at the boundary when no newline is available in range.
function chunkText(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const window = remaining.slice(0, maxLength);
    const lastNewline = window.lastIndexOf("\n");
    const splitAt = lastNewline > 0 ? lastNewline + 1 : maxLength;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  chunks.push(remaining);
  return chunks;
}

export async function sendChunked(config: ApiConfig, text: string): Promise<void> {
  const chunks = chunkText(text, TELEGRAM_MAX_MESSAGE_LENGTH);
  for (const chunk of chunks) {
    await tg(config, "sendMessage", { chat_id: config.chatId, text: chunk });
  }
}

export async function sendTyping(config: ApiConfig): Promise<void> {
  await tg(config, "sendChatAction", { chat_id: config.chatId, action: "typing" });
}

export interface BotCommand {
  command: string;
  description: string;
}

export async function setMyCommands(config: ApiConfig, commands: BotCommand[]): Promise<void> {
  await tg(config, "setMyCommands", { commands });
}
