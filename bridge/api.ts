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

// Strips stray inline markdown from a reply so Telegram (which gets no
// parse mode) doesn't show literal **bold**/## headers/backticks. Fenced
// code blocks pass through untouched — the plain-text rule in
// prompts/system.md permits fences when quoting actual code. Belt-and-braces
// behind that rule: deterministic stripping can't lose a message the way a
// parse-mode 400 would.
export function stripMarkdown(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/)
    .map((segment) => (segment.startsWith("```") ? segment : stripInline(segment)))
    .join("");
}

function stripInline(text: string): string {
  return (
    text
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
      // Emphasis openers must not be preceded by a word character and content
      // must not start/end with whitespace, so spaced maths (2 * 3) and
      // unspaced arithmetic (3*4=12) survive.
      .replace(/(?<!\w)\*\*(\S(?:[^*]*\S)?)\*\*/g, "$1")
      .replace(/(?<!\w)\*(\S(?:[^*]*\S)?)\*/g, "$1")
      // Single underscores are never matched at all — only __double__ pairs —
      // so snake_case and URLs are safe; don't add a single-underscore rule.
      .replace(/(?<!\w)__(\S(?:[^_]*\S)?)__/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
  );
}

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
// cut at the boundary when no newline is available in range. maxLength is a
// UTF-16 code-unit count (Telegram's limit), so a hard cut must never land
// between a surrogate pair's high and low units — nudge back one unit when
// it would.
function chunkText(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let boundary = maxLength;
    // A high surrogate (0xD800-0xDBFF) at the boundary means the low
    // surrogate is the next unit — pull the cut back before the pair.
    const codeUnit = remaining.charCodeAt(boundary - 1);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      boundary -= 1;
    }
    const window = remaining.slice(0, boundary);
    const lastNewline = window.lastIndexOf("\n");
    const splitAt = lastNewline > 0 ? lastNewline + 1 : boundary;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  chunks.push(remaining);
  return chunks;
}

export async function sendChunked(config: ApiConfig, text: string): Promise<void> {
  const chunks = chunkText(stripMarkdown(text), TELEGRAM_MAX_MESSAGE_LENGTH);
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

// Downloads the Telegram file identified by fileId to destPath.
// Calls getFile internally to resolve the file_path, then streams the
// content to disk. The token-bearing download URL never leaves this function.
// Uses the global fetch (Node 18+ built-in) and node:fs streams — no extra deps.
// fetchFn is injectable for tests; defaults to global fetch.
export async function downloadFile(
  config: ApiConfig,
  fileId: string,
  destPath: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const { createWriteStream } = await import("node:fs");
  const { mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");

  const result = (await tg(config, "getFile", { file_id: fileId })) as { file_path?: string };
  if (!result.file_path) {
    throw new Error("Telegram did not return a file_path — file may exceed the 20 MB API limit");
  }
  const url = `https://api.telegram.org/file/bot${config.token}/${result.file_path}`;

  await mkdir(dirname(destPath), { recursive: true });

  const res = await fetchFn(url);
  if (!res.ok || !res.body) {
    throw new Error(redact(`Failed to download file: HTTP ${res.status}`));
  }

  const writer = createWriteStream(destPath);
  await new Promise<void>((resolve, reject) => {
    const reader = res.body!.getReader();
    function pump(): void {
      reader
        .read()
        .then(({ done, value }) => {
          if (done) {
            // Attach listeners before end() to avoid a race if the stream
            // closes synchronously.
            writer.once("finish", resolve);
            writer.once("error", reject);
            writer.end();
            return;
          }
          writer.write(value, (err) => {
            if (err) {
              writer.destroy();
              reject(err);
              return;
            }
            pump();
          });
        })
        .catch((err) => {
          writer.destroy();
          reject(err);
        });
    }
    pump();
  });
}
