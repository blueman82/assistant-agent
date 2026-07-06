import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ApprovalSurface } from "../types.ts";

type Transport = typeof fetch;

export interface TelegramConfig {
  token: string;
  chatId: string;
  transport?: Transport;
  pollIntervalMs?: number;
}

// Reads SECRETARY_TELEGRAM_TOKEN / ~/.secretary/telegram.json — never
// committed. Returns undefined (surface disabled) if no token is configured;
// the gate must still function fully via the remaining surfaces.
export function loadTelegramConfig(): { token: string; chatId: string } | undefined {
  const envToken = process.env["SECRETARY_TELEGRAM_TOKEN"];
  const envChatId = process.env["SECRETARY_TELEGRAM_CHAT_ID"];
  if (envToken && envChatId) {
    return { token: envToken, chatId: envChatId };
  }

  const configPath = join(homedir(), ".secretary", "telegram.json");
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { token?: string; chatId?: string };
      if (parsed.token && parsed.chatId) {
        return { token: parsed.token, chatId: parsed.chatId };
      }
    } catch {
      // Malformed config -> treat as absent; the gate stays functional via
      // other surfaces rather than failing startup.
    }
  }

  return undefined;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;

export function createTelegramApprovalSurface(config: TelegramConfig): ApprovalSurface {
  const transport = config.transport ?? fetch;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const apiBase = `https://api.telegram.org/bot${config.token}`;

  return {
    async requestApproval(toolName, toolInput, hash) {
      const text = `Approval requested for ${toolName}\n\n${JSON.stringify(toolInput, null, 2)}`;
      await transport(`${apiBase}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: config.chatId,
          text,
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Approve", callback_data: `${hash}:approve` },
                { text: "Deny", callback_data: `${hash}:deny` },
              ],
            ],
          },
        }),
      } as never);

      let offset: number | undefined;
      // Long-poll getUpdates until a callback_query matching this hash
      // arrives. Loops indefinitely by design — the gate's own internal
      // timeout race is what bounds this from the caller's side.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res = await transport(
          `${apiBase}/getUpdates${offset !== undefined ? `?offset=${offset}` : ""}`,
          { method: "GET" } as never,
        );
        const body = (await res.json()) as {
          result: Array<{ update_id: number; callback_query?: { data?: string } }>;
        };

        for (const update of body.result ?? []) {
          offset = update.update_id + 1;
          const data = update.callback_query?.data;
          if (!data) continue;
          const [dataHash, decision] = data.split(":");
          if (dataHash === hash && (decision === "approve" || decision === "deny")) {
            return decision;
          }
        }

        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    },
  };
}
