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
import { channelConfigs, heartbeatRuns } from "@paperclipai/db";
import { getChannelRegistry } from "../index.js";
import { logger } from "../../middleware/logger.js";
import { formatSuccess } from "./formatter.js";
import { summarizeHeartbeatRunResultJson } from "../../services/heartbeat-run-summary.js";

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
function buildOutboundHandler(db: Db, companyId: string) {
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
      const conversationReply = await formatTelegramConversationReply(db, event);
      if (conversationReply) {
        await sender(conversationReply.chatId, conversationReply.message);
        return;
      }

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

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function formatTelegramConversationReply(
  db: Db,
  event: { type: string; payload?: Record<string, unknown> },
): Promise<{ chatId: number; message: string } | null> {
  if (event.type !== "heartbeat.run.status") return null;
  const status = readString(event.payload?.status);
  if (!status || !["succeeded", "failed", "timed_out", "cancelled"].includes(status)) return null;

  const runId = readString(event.payload?.runId);
  if (!runId) return null;

  const [run] = await db
    .select({
      id: heartbeatRuns.id,
      contextSnapshot: heartbeatRuns.contextSnapshot,
      resultJson: heartbeatRuns.resultJson,
      error: heartbeatRuns.error,
      status: heartbeatRuns.status,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .limit(1);
  if (!run) return null;

  const context = readRecord(run.contextSnapshot);
  if (context?.telegramOperatorMessage !== true) return null;
  const chatId = readNumber(context.telegramChatId);
  if (chatId === null) return null;

  const summary = summarizeHeartbeatRunResultJson(run.resultJson);
  const resultText =
    readString(summary?.result) ??
    readString(summary?.summary) ??
    readString(summary?.message) ??
    readString(run.error) ??
    `Run ${run.status}.`;
  const prefix = run.status === "succeeded" ? "Hermes Operations Manager" : `Hermes Operations Manager (${run.status})`;
  return {
    chatId,
    message: `${prefix}\n${resultText.slice(0, 3500)}`,
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
      // Only notify on terminal states — skip intermediate noise (queued/running)
      if (!["succeeded", "failed", "timed_out", "cancelled"].includes(status)) return null;
      const emoji = getRunStatusEmoji(status);
      const runLabel = runId.slice(0, 8);
      return formatSuccess(`${emoji} Run *${runLabel}* — ${formatStatus(status)}`);
    }

    // heartbeat.run.queued — suppressed: intermediate noise
    // agent.status — suppressed: intermediate noise
    // heartbeat.run.event — suppressed: intermediate noise
    // activity.logged — suppressed: intermediate noise

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
    const handler = buildOutboundHandler(db, companyId);

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
