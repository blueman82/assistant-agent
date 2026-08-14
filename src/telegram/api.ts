import { basename } from "node:path";
import type { TelegramConfig } from "./types.ts";

export interface TelegramApi {
  call(method: string, body: unknown): Promise<unknown>;
  getUpdates(offset?: number): Promise<unknown[]>;
  download(fileId: string, destination: string): Promise<void>;
  sendVoice(chatId: string, filePath: string): Promise<void>;
}

export class TelegramApiError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = "TelegramApiError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

interface ApiResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

function parseResponse(method: string, response: Response, parsed: ApiResponse | undefined): unknown {
  if (!response.ok || !parsed?.ok) {
    const status = parsed?.error_code ?? response.status;
    const retryAfterSeconds = parsed?.parameters?.retry_after;
    const retryAfterMs = typeof retryAfterSeconds === "number" ? retryAfterSeconds * 1_000 : undefined;
    throw new TelegramApiError(`Telegram ${method} failed: ${parsed?.description ?? `HTTP ${response.status}`}`, status, retryAfterMs);
  }
  return parsed.result;
}

export function createTelegramApi(config: TelegramConfig, fetchFn: typeof fetch = fetch): TelegramApi {
  const base = `https://api.telegram.org/bot${config.token}`;
  const timeoutMs = config.requestTimeoutMs ?? 45_000;
  async function call(method: string, body: unknown): Promise<unknown> {
    const response = await fetchFn(`${base}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    const parsed = await response.json().catch(() => undefined) as ApiResponse | undefined;
    return parseResponse(method, response, parsed);
  }
  return {
    call,
    async getUpdates(offset) {
      return await call("getUpdates", { timeout: 30, ...(offset === undefined ? {} : { offset }) }) as unknown[];
    },
    async download(fileId, destination) {
      const file = await call("getFile", { file_id: fileId }) as { file_path?: string };
      if (!file.file_path) throw new Error("Telegram did not return a file_path");
      const response = await fetchFn(`https://api.telegram.org/file/bot${config.token}/${file.file_path}`);
      if (!response.ok || !response.body) throw new Error(`Telegram file download failed: HTTP ${response.status}`);
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      const bytes = await response.arrayBuffer();
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(bytes));
    },
    async sendVoice(chatId, filePath) {
      const { readFile } = await import("node:fs/promises");
      const bytes = await readFile(filePath);
      const form = new FormData();
      form.set("chat_id", chatId);
      form.set("voice", new Blob([bytes]), basename(filePath));
      const response = await fetchFn(`${base}/sendVoice`, {
        method: "POST", body: form, signal: AbortSignal.timeout(timeoutMs),
      });
      const parsed = await response.json().catch(() => undefined) as ApiResponse | undefined;
      parseResponse("sendVoice", response, parsed);
    },
  };
}

