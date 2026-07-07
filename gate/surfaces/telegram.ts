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

  // Best-effort: resolves the tapping client's spinner. Never lets a
  // transport/network failure here take down approval resolution itself.
  async function answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    try {
      await transport(`${apiBase}/answerCallbackQuery`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callback_query_id: callbackQueryId, ...(text ? { text } : {}) }),
      });
    } catch {
      // Non-fatal — the approve/deny decision has already been determined.
    }
  }

  return {
    async requestApproval(toolName, toolInput, hash) {
      // Telegram caps callback_data at 64 BYTES total, so the hash must be
      // truncated before the ":approve"/":deny" suffix is appended. Truncate
      // to 32 chars — plenty of entropy to disambiguate concurrent requests
      // — leaving headroom for the suffix.
      const shortHash = hash.slice(0, 32);
      const text = `Approval requested for ${toolName}\n\n${JSON.stringify(toolInput, null, 2)}`;
      const sendRes = await transport(`${apiBase}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: config.chatId,
          text,
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Approve", callback_data: `${shortHash}:approve` },
                { text: "Deny", callback_data: `${shortHash}:deny` },
              ],
            ],
          },
        }),
      });
      const sendBody = (await sendRes.json()) as { ok: boolean; description?: string };
      if (!sendRes.ok || !sendBody.ok) {
        throw new Error(`Telegram sendMessage failed: ${sendBody.description ?? "unknown error"}`);
      }

      let offset: number | undefined;
      // Long-poll getUpdates until a callback_query matching this hash
      // arrives. Loops indefinitely by design — the gate's own internal
      // timeout race is what bounds this from the caller's side.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res = await transport(
          `${apiBase}/getUpdates${offset !== undefined ? `?offset=${offset}` : ""}`,
          { method: "GET" },
        );
        const body = (await res.json()) as {
          ok: boolean;
          description?: string;
          result?: Array<{ update_id: number; callback_query?: { id: string; data?: string; from?: { id: number } } }>;
        };
        if (!res.ok || !body.ok) {
          throw new Error(`Telegram getUpdates failed: ${body.description ?? "unknown error"}`);
        }

        for (const update of body.result ?? []) {
          offset = update.update_id + 1;
          const cb = update.callback_query;
          const data = cb?.data;
          if (!cb || !data) continue;

          // Only the configured owner's taps can resolve an approval — a
          // matching callback_data alone isn't enough (e.g. a forwarded
          // approval card tapped by someone else).
          if (String(cb.from?.id) !== config.chatId) {
            await answerCallback(cb.id, "Not authorized");
            continue;
          }

          const [dataHash, decision] = data.split(":");
          if (dataHash === shortHash && (decision === "approve" || decision === "deny")) {
            await answerCallback(cb.id);
            return decision;
          }

          // Tap doesn't match this pending request (stale/foreign hash) —
          // answer it anyway so the Telegram client's tap spinner resolves
          // instead of hanging forever.
          await answerCallback(cb.id, "Expired");
        }

        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    },
  };
}
