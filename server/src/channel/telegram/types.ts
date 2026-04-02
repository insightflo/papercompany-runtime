/**
 * Telegram Bot Types
 *
 * Telegram API update types for the long-poll bot.
 */

/**
 * Incoming message from a Telegram user.
 */
export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  command?: string; // extracted command (e.g. "/status")
}

/**
 * Telegram user (sender of a message).
 */
export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  username?: string;
  language_code?: string;
}

/**
 * Telegram chat (the conversation context).
 */
export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

/**
 * An update returned by getUpdates.
 */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

/**
 * Response from Telegram getUpdates API.
 */
export interface TelegramGetUpdatesResponse {
  ok: true;
  result: TelegramUpdate[];
}

/**
 * Payload for sending a message via sendMessage API.
 */
export interface TelegramSendMessagePayload {
  chat_id: number;
  text: string;
  parse_mode?: "MarkdownV2" | "HTML";
  reply_to_message_id?: number;
}

/**
 * Telegram API error response.
 */
export interface TelegramApiError {
  ok: false;
  error_code: number;
  description: string;
}
