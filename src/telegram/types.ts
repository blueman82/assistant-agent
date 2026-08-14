export interface TelegramUser { id: number }
export interface TelegramChat { id: number }

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  voice?: { file_id: string; duration: number; mime_type?: string };
  photo?: Array<{ file_id: string; width: number; height: number }>;
  document?: { file_id: string; file_name?: string; mime_type?: string };
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export type TelegramEvent =
  | { kind: "message"; message: TelegramMessage; update: TelegramUpdate }
  | { kind: "callback"; callback: TelegramCallbackQuery; update: TelegramUpdate };

export interface TelegramConfig {
  token: string;
  chatId: string;
  requestTimeoutMs?: number;
}

