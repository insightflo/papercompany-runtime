/**
 * Telegram Bot — long-poll loop
 *
 * Implements Telegram Bot API long polling with:
 * - getUpdates timeout=25 (long poll)
 * - Offset tracking to prevent duplicate processing
 * - Bot JWT lifecycle (1h TTL, refresh 5 min before expiry)
 * - bot_token from company_secrets (NOT config_json directly)
 *
 * OQ-3: Long polling v1 — webhook mode requires only changing initialization.
 */

import type { Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { channelConfigs } from "@paperclipai/db";
import { createLocalAgentJwt } from "../../agent-auth-jwt.js";
import { secretService } from "../../services/secrets.js";
import { logger } from "../../middleware/logger.js";
import type {
  TelegramUpdate,
  TelegramSendMessagePayload,
  TelegramMessage,
} from "./types.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const LONG_POLL_TIMEOUT = 25; // seconds — Telegram long poll
const JWT_TTL_SECONDS = 60 * 60; // 1 hour
const JWT_REFRESH_BEFORE_SECONDS = 5 * 60; // 5 minutes before expiry

/**
 * JWT claims for the bot's company-scoped API token.
 */
interface BotJwtClaims {
  sub: string; // bot user id
  company_id: string;
  role: "channel_bot";
  iat: number;
  exp: number;
}

/**
 * Message handler signature — commands.ts (#27) implements this.
 */
export type TelegramMessageHandler = (
  message: TelegramMessage,
  context: { companyId: string; botJwt: string },
) => Promise<void>;

/**
 * Outbound sender — used to send messages to Telegram users.
 */
export type TelegramSender = (chatId: number, text: string) => Promise<void>;

/**
 * Configuration for a single company's Telegram bot.
 */
interface BotConfig {
  companyId: string;
  botTokenSecretId: string; // secret id in company_secrets
  botUsername: string;
}

/**
 * TelegramBot — manages long-polling loop and JWT lifecycle for one company.
 */
export class TelegramBot {
  private offset = 0;
  private running = false;
  private jwt: string | null = null;
  private jwtExpiresAt = 0; // unix seconds
  private config: BotConfig;
  private db: Db;
  private messageHandler: TelegramMessageHandler | null = null;
  private pollAbortController: AbortController | null = null;

  constructor(db: Db, config: BotConfig) {
    this.db = db;
    this.config = config;
  }

  /**
   * Start the long-polling loop.
   */
  start(handler: TelegramMessageHandler): void {
    if (this.running) return;
    this.messageHandler = handler;
    this.running = true;
    this.pollLoop().catch((err) => {
      logger.error({ msg: "Telegram poll loop crashed", error: err });
      this.running = false;
    });
  }

  /**
   * Stop the long-polling loop.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.pollAbortController?.abort();
    this.pollAbortController = null;
  }

  /**
   * Set a new message handler (e.g. when commands.ts registers handlers).
   */
  setHandler(handler: TelegramMessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * Send a message to a Telegram chat.
   */
  async sendMessage(chatId: number, text: string): Promise<void> {
    const payload: TelegramSendMessagePayload = { chat_id: chatId, text };
    await this.telegramApi("sendMessage", payload as unknown as Record<string, unknown>);
  }

  /**
   * Main polling loop — fetches updates and dispatches to handler.
   */
  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.refreshJwtIfNeeded();
        const updates = await this.fetchUpdates();
        for (const update of updates) {
          if (update.message) {
            await this.handleUpdate(update);
          }
          this.offset = update.update_id + 1;
        }
      } catch (err) {
        if (this.running) {
          logger.warn({ msg: "Telegram poll error, retrying", error: err });
          await sleep(1000);
        }
      }
    }
  }

  /**
   * Fetch new updates from Telegram, respecting offset.
   */
  private async fetchUpdates(): Promise<TelegramUpdate[]> {
    const controller = new AbortController();
    this.pollAbortController = controller;
    // Long poll timeout handled by Telegram API (timeout=25 in URL).
    // AbortController handles manual cancellation on stop().
    try {
      const response = await fetch(
        `${TELEGRAM_API_BASE}/bot${await this.getBotToken()}/getUpdates?offset=${this.offset}&timeout=${LONG_POLL_TIMEOUT}`,
        {
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Telegram API ${response.status}: ${body}`);
      }

      const data = (await response.json()) as { ok: boolean; result?: TelegramUpdate[] };
      if (!data.ok || !data.result) {
        throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
      }

      return data.result;
    } catch (err) {
      if ((err as Error).name === "AbortError" || (err as Error).name === "TimeoutError") {
        return []; // Normal timeout, no updates
      }
      throw err;
    }
  }

  /**
   * Dispatch a single update to the message handler.
   */
  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (!update.message || !this.messageHandler) return;

    // Extract command from text (e.g. "/status@BotName" → "/status")
    const text = update.message.text ?? "";
    if (!text.startsWith("/")) return;

    const command = text.slice(1).split(/[\s@]/)[0];
    update.message.command = command;

    try {
      const jwt = await this.getJwt();
      await this.messageHandler(update.message, {
        companyId: this.config.companyId,
        botJwt: jwt,
      });
    } catch (err) {
      logger.error({
        msg: "Message handler error",
        command,
        error: err,
        companyId: this.config.companyId,
      });
    }
  }

  /**
   * Get a valid JWT, refreshing if within 5 minutes of expiry.
   */
  private async refreshJwtIfNeeded(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    if (this.jwt && this.jwtExpiresAt - now > JWT_REFRESH_BEFORE_SECONDS) {
      return; // JWT still valid
    }
    this.jwt = await this.issueJwt();
    this.jwtExpiresAt = now + JWT_TTL_SECONDS;
  }

  /**
   * Get a valid JWT (returns cached if still valid).
   */
  private async getJwt(): Promise<string> {
    await this.refreshJwtIfNeeded();
    if (!this.jwt) throw new Error("JWT not available");
    return this.jwt;
  }

  /**
   * Issue a new company-scoped JWT for the bot.
   */
  private async issueJwt(): Promise<string> {
    // Create a bot user id from the bot username for the JWT subject
    const botUserId = `bot:${this.config.botUsername}`;

    // The JWT role is "channel_bot" to distinguish from agent adapters
    const now = Math.floor(Date.now() / 1000);
    const claims: BotJwtClaims = {
      sub: botUserId,
      company_id: this.config.companyId,
      role: "channel_bot",
      iat: now,
      exp: now + JWT_TTL_SECONDS,
    };

    // Reuse the local agent JWT signing mechanism
    const jwt = createLocalAgentJwt(
      botUserId,
      this.config.companyId,
      "telegram_bot",
      `bot-${this.config.companyId}`,
    );

    if (!jwt) throw new Error("Failed to create bot JWT — JWT secret not configured");

    return jwt;
  }

  /**
   * Retrieve the bot token from company_secrets.
   */
  private async getBotToken(): Promise<string> {
    const svc = secretService(this.db);
    const token = await svc.resolveSecretValue(this.config.companyId, this.config.botTokenSecretId, "latest");
    return token;
  }

  /**
   * Make a Telegram Bot API call.
   */
  private async telegramApi(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await fetch(`${TELEGRAM_API_BASE}/bot${await this.getBotToken()}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = (await response.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!data.ok) {
      throw new Error(`Telegram ${method} failed: ${data.description}`);
    }
    return data.result;
  }
}

/**
 * Create a TelegramBot for a company, loading config from channel_configs + company_secrets.
 *
 * @param db - Database instance
 * @param companyId - Company to create bot for
 * @param botTokenSecretId - Secret ID in company_secrets storing the bot token
 * @param botUsername - Bot username (e.g. "papercompanyBot")
 */
export async function createTelegramBot(
  db: Db,
  companyId: string,
  botTokenSecretId: string,
  botUsername: string,
): Promise<TelegramBot> {
  const bot = new TelegramBot(db, {
    companyId,
    botTokenSecretId,
    botUsername,
  });
  return bot;
}

/**
 * Load all enabled Telegram channel configs and return startup configs.
 */
export async function loadTelegramBotConfigs(
  db: Db,
): Promise<Array<{ companyId: string; botTokenSecretId: string; botUsername: string }>> {
  const rows = await db
    .select()
    .from(channelConfigs)
    .where(eq(channelConfigs.kind, "telegram"));

  return rows
    .filter((row: typeof channelConfigs.$inferSelect) => row.enabled)
    .map((row: typeof channelConfigs.$inferSelect) => {
      const config = row.configJson as { botUsername?: string; botTokenSecretId?: string };
      if (!config.botUsername || !config.botTokenSecretId) {
        logger.warn({
          msg: "Telegram channel config missing botUsername or botTokenSecretId, skipping",
          companyId: row.companyId,
        });
        return null;
      }
      return {
        companyId: row.companyId,
        botTokenSecretId: config.botTokenSecretId,
        botUsername: config.botUsername,
      };
    })
    .filter((c: { companyId: string; botTokenSecretId: string; botUsername: string } | null): c is NonNullable<typeof c> => c !== null);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
