/**
 * Telegram Outbound Notifier
 *
 * Subscribes to live-events and forwards them as Telegram notifications.
 * Each company with a Telegram bot gets notifications for its events.
 *
 * Used by: channel/index.ts startup (#30)
 */

import type { Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { channelConfigs } from "@paperclipai/db";
import { getChannelRegistry } from "../index.js";
import { logger } from "../../middleware/logger.js";
import { formatSuccess } from "./formatter.js";

/**
 * Map of companyId → chatId for users who have messaged the bot.
 * The bot can only send messages to chats it has received messages from.
 * Updated when inbound messages arrive (via commands.ts).
 */
const companyChatIds = new Map<string, number>();

/**
 * Register a chat ID for a company (called when a user sends an inbound message).
 */
export function registerChatId(companyId: string, chatId: number): void {
  companyChatIds.set(companyId, chatId);
}

/**
 * Get the registered chat ID for a company.
 */
export function getChatId(companyId: string): number | undefined {
  return companyChatIds.get(companyId);
}

/**
 * Build the outbound handler for a specific company.
 */
function buildOutboundHandler(companyId: string) {
  return async function handleOutboundEvent(event: { type: string; payload?: Record<string, unknown> }): Promise<void> {
    const chatId = companyChatIds.get(companyId);
    if (chatId === undefined) {
      return; // No registered chat for this company
    }

    const sender = getChannelRegistry().getTelegramSender(companyId);
    if (!sender) {
      logger.warn({ msg: "No Telegram sender for company", companyId });
      return;
    }

    try {
      const message = formatEventNotification(event);
      if (message) {
        await sender(chatId, message);
      }
    } catch (err) {
      logger.error({
        msg: "Failed to send Telegram outbound notification",
        companyId,
        eventType: event.type,
        error: err,
      });
    }
  };
}

/**
 * Format a live event as a human-readable Telegram notification.
 * Returns null if the event type should not be notified.
 */
function formatEventNotification(event: { type: string; payload?: Record<string, unknown> }): string | null {
  const { type, payload } = event;

  switch (type) {
    case "heartbeat.run.status": {
      const status = payload?.status as string | undefined;
      const runId = payload?.runId as string | undefined;
      if (!status || !runId) return null;
      const emoji = getRunStatusEmoji(status);
      const runLabel = runId.slice(0, 8);
      return formatSuccess(`${emoji} Run *${runLabel}* — ${formatStatus(status)}`);
    }

    case "heartbeat.run.queued": {
      const runId = payload?.runId as string | undefined;
      const runLabel = runId?.slice(0, 8) ?? "unknown";
      return `Run *${runLabel}* queued for execution.`;
    }

    case "heartbeat.run.event": {
      const eventType = payload?.event as string | undefined;
      const runId = payload?.runId as string | undefined;
      if (!eventType) return null;
      const runLabel = runId?.slice(0, 8) ?? "unknown";
      return `Run *${runLabel}*: ${eventType}`;
    }

    case "agent.status": {
      const agentId = payload?.agentId as string | undefined;
      const status = payload?.status as string | undefined;
      if (!status) return null;
      const agentLabel = agentId?.slice(0, 8) ?? "agent";
      return `Agent *${agentLabel}* is now ${formatStatus(status)}`;
    }

    case "activity.logged": {
      // High-volume event — only notify for significant activities
      const action = payload?.action as string | undefined;
      const entityType = payload?.entityType as string | undefined;
      if (!action || !entityType) return null;
      // Only notify for important entity types
      if (!["mission", "issue", "approval"].includes(entityType)) return null;
      return `Activity: *${entityType}* — ${action}`;
    }

    case "plugin.ui.updated": {
      const action = payload?.action as string | undefined;
      const pluginId = payload?.pluginId as string | undefined;
      if (!action) return null;
      const pluginLabel = pluginId?.slice(0, 8) ?? "plugin";
      return `Plugin *${pluginLabel}*: ${action}`;
    }

    case "plugin.worker.crashed": {
      const pluginKey = payload?.pluginKey as string | undefined;
      const workerId = payload?.workerId as string | undefined;
      const msg = `Plugin worker crashed${pluginKey ? `: ${pluginKey}` : ""}${workerId ? ` (${workerId.slice(0, 8)})` : ""}`;
      return formatError(msg);
    }

    case "plugin.worker.restarted": {
      const pluginKey = payload?.pluginKey as string | undefined;
      const workerId = payload?.workerId as string | undefined;
      const msg = `Plugin worker restarted${pluginKey ? `: ${pluginKey}` : ""}${workerId ? ` (${workerId.slice(0, 8)})` : ""}`;
      return formatSuccess(msg);
    }

    default:
      return null;
  }
}

function getRunStatusEmoji(status: string): string {
  switch (status) {
    case "queued":
      return "\u23F3"; // hourglass
    case "running":
      return "\u{1F3D7}"; // building worker
    case "succeeded":
      return "\u2705"; // check mark
    case "failed":
      return "\u274C"; // cross
    case "cancelled":
      return "\u{1F6AB}"; // no entry
    case "timed_out":
      return "\u23F1"; // timer
    default:
      return "\u2753"; // question mark
  }
}

function formatStatus(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatError(message: string): string {
  return `*Error*\n${message}`;
}

/**
 * Initialize the outbound notifier for all enabled Telegram companies.
 *
 * Loads all enabled Telegram channel configs and registers outbound handlers
 * for each company's live events. Safe to call multiple times.
 *
 * @param db - Database instance
 */
export async function initOutboundNotifier(db: Db): Promise<void> {
  // Load all enabled Telegram configs
  const rows = await db
    .select()
    .from(channelConfigs)
    .where(eq(channelConfigs.kind, "telegram"));

  const enabledConfigs = rows.filter((row: typeof rows[0]) => row.enabled);

  for (const config of enabledConfigs) {
    const companyId = config.companyId;
    const handler = buildOutboundHandler(companyId);

    try {
      getChannelRegistry().registerOutboundHandler(companyId, handler);
      logger.info({ msg: "Outbound notifier registered", companyId });
    } catch (err) {
      logger.error({
        msg: "Failed to register outbound handler",
        companyId,
        error: err,
      });
    }
  }

  logger.info({
    msg: "Outbound notifier initialized",
    companyCount: enabledConfigs.length,
  });
}
