/**
 * Channel Registry
 *
 * Starts and manages all channel integrations (Telegram v1).
 * - Loads enabled channel configs from channel_configs table
 * - Starts Telegram long-poll bots
 * - Subscribes to live-events for outbound notifications
 *
 * Startup is called from server/src/app.ts on server boot.
 */

import type { Db } from "@paperclipai/db";
import { createTelegramBot, loadTelegramBotConfigs, type TelegramSender, type TelegramBot } from "./telegram/bot.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { logger } from "../middleware/logger.js";
import { initOutboundNotifier } from "./telegram/outbound.js";

/**
 * Channel registry — manages all active channel integrations.
 */
export class ChannelRegistry {
  private bots: Map<string, TelegramBot> = new Map();
  private unsubscribers: Array<() => void> = [];
  private liveEventHandlers: Map<string, (event: { type: string; payload?: Record<string, unknown> }) => void> = new Map();
  private db: Db;
  private initialized = false;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Initialize all channels — load configs and start bots.
   * Safe to call multiple times (idempotent).
   */
  async start(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    await this.startTelegramBots();
    this.subscribeToLiveEvents();
    await initOutboundNotifier(this.db);

    logger.info({ msg: "Channel registry started" });
  }

  /**
   * Stop all channels gracefully.
   */
  async stop(): Promise<void> {
    for (const [companyId, bot] of this.bots) {
      try {
        await bot.stop();
        logger.info({ msg: "Telegram bot stopped", companyId });
      } catch (err) {
        logger.warn({ msg: "Error stopping Telegram bot", companyId, error: err });
      }
    }
    this.bots.clear();

    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    this.initialized = false;
    logger.info({ msg: "Channel registry stopped" });
  }

  /**
   * Start Telegram bots for all enabled companies.
   */
  private async startTelegramBots(): Promise<void> {
    const configs = await loadTelegramBotConfigs(this.db);

    for (const config of configs) {
      try {
        const bot = await createTelegramBot(
          this.db,
          config.companyId,
          config.botTokenSecretId,
          config.botUsername,
        );

        // Register a default handler that logs inbound messages
        // The actual command handler is registered via registerTelegramHandler
        bot.start((message, ctx) => this.defaultMessageHandler(message, ctx));

        this.bots.set(config.companyId, bot);
        logger.info({ msg: "Telegram bot started", companyId: config.companyId });
      } catch (err) {
        logger.error({
          msg: "Failed to start Telegram bot",
          companyId: config.companyId,
          error: err,
        });
      }
    }
  }

  /**
   * Subscribe to live events for outbound Telegram notifications.
   * Agents emit events → we forward to Telegram.
   */
  private subscribeToLiveEvents(): void {
    // Subscribe to mission and issue events for all companies
    // Outbound notifier (#30) will populate liveEventHandlers per company
    const unsub = subscribeCompanyLiveEvents("*", (event) => {
      this.handleLiveEvent(event);
    });
    this.unsubscribers.push(unsub);
  }

  /**
   * Handle a live event — forward to Telegram if a handler is registered.
   */
  private handleLiveEvent(event: { companyId: string; type: string; payload?: Record<string, unknown> }): void {
    const handler = this.liveEventHandlers.get(event.companyId);
    if (handler) {
      handler(event);
    }
  }

  /**
   * Register a Telegram message handler for a company.
   * Called by commands.ts (#27) to wire up the actual command handlers.
   */
  registerTelegramHandler(
    companyId: string,
    handler: (message: import("./telegram/types.js").TelegramMessage, context: { companyId: string; botJwt: string }) => Promise<void>,
  ): void {
    const bot = this.bots.get(companyId) as import("./telegram/bot.js").TelegramBot | undefined;
    if (bot) {
      bot.setHandler(handler);
      logger.info({ msg: "Telegram command handler registered", companyId });
    } else {
      logger.warn({ msg: "No Telegram bot found for company", companyId });
    }
  }

  /**
   * Register an outbound event handler for a company.
   * Called by outbound notifier (#30) to handle live events → Telegram sends.
   */
  registerOutboundHandler(
    companyId: string,
    handler: (event: { type: string; payload?: Record<string, unknown> }) => void,
  ): void {
    this.liveEventHandlers.set(companyId, handler);
  }

  /**
   * Get a Telegram sender function for a company.
   * Used by outbound notifier to send messages.
   */
  getTelegramSender(companyId: string): TelegramSender | null {
    const bot = this.bots.get(companyId);
    if (!bot) return null;
    return bot.sendMessage.bind(bot);
  }

  /**
   * Get all active company IDs that have a running Telegram bot.
   * Used by alert rules to broadcast to all registered companies.
   */
  getActiveCompanyIds(): string[] {
    return Array.from(this.bots.keys());
  }

  /**
   * Default message handler — logs inbound messages when no command handler is registered.
   */
  private async defaultMessageHandler(
    message: import("./telegram/types.js").TelegramMessage,
    context: { companyId: string; botJwt: string },
  ): Promise<void> {
    logger.debug({
      msg: "Telegram inbound message (no handler registered)",
      companyId: context.companyId,
      command: message.command,
      text: message.text,
      chatId: message.chat.id,
    });
  }
}

let registry: ChannelRegistry | null = null;

/**
 * Get the global channel registry instance.
 */
export function getChannelRegistry(): ChannelRegistry {
  if (!registry) {
    throw new Error("Channel registry not initialized — call createChannelRegistry first");
  }
  return registry;
}

/**
 * Create and initialize the channel registry.
 * Called from app.ts on server startup.
 */
export function createChannelRegistry(db: Db): ChannelRegistry {
  if (registry) {
    return registry;
  }
  registry = new ChannelRegistry(db);
  return registry;
}
