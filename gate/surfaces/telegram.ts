import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ApprovalSurface } from "../types.ts";

type Transport = typeof fetch;

export interface TelegramConfig {
  token: string;
  chatId: string;
  transport?: Transport;
}

export interface TelegramCallbackQuery {
  id: string;
  data?: string;
  from: { id: number };
}

// Extends the base ApprovalSurface with an injected-updates seam: the
// bridge owns the single long-poll loop and feeds callback_query updates in
// here rather than this surface polling for itself.
export interface TelegramApprovalSurface extends ApprovalSurface {
  // Resolves the pending approval matching this callback's hash prefix, if
  // any. Returns whether the callback was consumed by a pending request
  // (true) or not (false) — a stray/expired/foreign tap either way gets
  // answerCallbackQuery'd so the tapping client's spinner never hangs.
  handleCallbackQuery(cb: TelegramCallbackQuery): Promise<boolean>;
}

// Reads RACHEL_TELEGRAM_TOKEN / ~/.rachel/telegram.json — never
// committed. Returns undefined (surface disabled) if no token is configured;
// the gate must still function fully via the remaining surfaces.
export function loadTelegramConfig(): { token: string; chatId: string } | undefined {
  const envToken = process.env["RACHEL_TELEGRAM_TOKEN"];
  const envChatId = process.env["RACHEL_TELEGRAM_CHAT_ID"];
  if (envToken && envChatId) {
    return { token: envToken, chatId: envChatId };
  }

  const configPath = join(homedir(), ".rachel", "telegram.json");
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

interface PendingRequest {
  shortHash: string;
  resolve: (decision: "approve" | "deny") => void;
}

export function createTelegramApprovalSurface(config: TelegramConfig): TelegramApprovalSurface {
  const transport = config.transport ?? fetch;
  const apiBase = `https://api.telegram.org/bot${config.token}`;

  // Keyed by shortHash (32-char truncated hash) — the bridge's single poll
  // loop feeds callback_query updates through handleCallbackQuery, which
  // looks up the matching pending request here.
  const pending = new Map<string, PendingRequest>();

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

      return new Promise((resolve) => {
        pending.set(shortHash, { shortHash, resolve });
      });
    },

    async handleCallbackQuery(cb) {
      const data = cb.data;
      if (!data) {
        await answerCallback(cb.id, "Expired");
        return false;
      }

      // Only the configured owner's taps can resolve an approval — a
      // matching callback_data alone isn't enough (e.g. a forwarded
      // approval card tapped by someone else).
      if (String(cb.from.id) !== config.chatId) {
        await answerCallback(cb.id, "Not authorized");
        return false;
      }

      const [dataHash, decision] = data.split(":");
      const match = dataHash !== undefined ? pending.get(dataHash) : undefined;
      if (match && (decision === "approve" || decision === "deny")) {
        pending.delete(match.shortHash);
        await answerCallback(cb.id);
        match.resolve(decision);
        return true;
      }

      // Tap doesn't match any pending request (stale/foreign hash) —
      // answer it anyway so the Telegram client's tap spinner resolves
      // instead of hanging forever.
      await answerCallback(cb.id, "Expired");
      return false;
    },
  };
}
