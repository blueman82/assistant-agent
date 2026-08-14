import type { TelegramApi } from "./api.ts";
import type { TelegramCallbackQuery } from "./types.ts";

export type Approval = "approve" | "deny";
export interface ApprovalTransport { request(hash: string, text: string): Promise<Approval>; callback(query: TelegramCallbackQuery): Promise<boolean> }

export function createApprovalTransport(api: TelegramApi, chatId: string): ApprovalTransport {
  const pending = new Map<string, (decision: Approval) => void>();
  return {
    async request(hash, text) {
      const key = hash.slice(0, 32);
      await api.call("sendMessage", { chat_id: chatId, text, reply_markup: { inline_keyboard: [[
        { text: "Approve", callback_data: `${key}:approve` }, { text: "Deny", callback_data: `${key}:deny` },
      ]] } });
      return await new Promise<Approval>((resolve) => pending.set(key, resolve));
    },
    async callback(query) {
      const [key, decision] = (query.data ?? "").split(":");
      const resolve = key ? pending.get(key) : undefined;
      const allowed = String(query.from.id) === chatId && (decision === "approve" || decision === "deny") && !!resolve;
      await api.call("answerCallbackQuery", { callback_query_id: query.id, ...(allowed ? {} : { text: "Expired" }) });
      if (!allowed || !resolve) return false;
      pending.delete(key!);
      resolve(decision as Approval);
      return true;
    },
  };
}

