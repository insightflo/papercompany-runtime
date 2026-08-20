/**
 * Telegram Outbound Notifier
 *
 * Subscribes to live-events and forwards them as Telegram notifications.
 * Each company with a Telegram bot gets notifications for its events.
 *
 * Used by: channel/index.ts startup (#30)
 */

import type { Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { agents, channelConfigs, heartbeatRuns, issues, missions } from "@paperclipai/db";
import { getChannelRegistry } from "../index.js";
import { logger } from "../../middleware/logger.js";
import { summarizeHeartbeatRunResultJson } from "../../services/heartbeat-run-summary.js";
import { applyRunHonestyCaveat } from "../../services/hermes-chat.js";

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
 * [outbound persistence] channel_configs.configJson.telegramChatId 에 chatId 를 기록한다.
 *   서버 재시작 시 인메모리 맵이 비어 아웃바운드가 조용히 드랍되던 결함(재시작 후 운영자가 봇에
 *   다시 메시지할 때까지 무통지)의 수정. 변경 시에만 쓴다(모든 인바운드 메시지가 호출함).
 *   채널 설정이 없는 회사는 인메모리 등록만으로 동작(기존 동작 유지). 실패는 알림 기능을
 *   저하시키지 않도록 warn 로그로만 처리한다.
 */
export async function persistChatId(db: Db, companyId: string, chatId: number): Promise<void> {
  try {
    const [row] = await db
      .select({ configJson: channelConfigs.configJson })
      .from(channelConfigs)
      .where(and(
        eq(channelConfigs.companyId, companyId),
        eq(channelConfigs.kind, "telegram"),
      ))
      .limit(1);
    if (!row) return;
    const existing = (row.configJson as { telegramChatId?: unknown } | null)?.telegramChatId;
    if (existing === chatId) return;
    await db
      .update(channelConfigs)
      .set({ configJson: { ...(row.configJson ?? {}), telegramChatId: chatId } })
      .where(and(
        eq(channelConfigs.companyId, companyId),
        eq(channelConfigs.kind, "telegram"),
      ));
  } catch (err) {
    logger.warn({ err, companyId, msg: "Failed to persist telegram chatId — outbound will remain in-memory only until restart" });
  }
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

      let message = await buildRunFailureNotification(db, event);
      if (!message) {
        message = formatEventNotification(event);
      }
      if (message) {
        await sender(chatId, message);
      }
    } catch (err) {
      logger.error({
        msg: "Failed to send Telegram outbound notification",
        companyId,
        eventType: event.type,
        error: err instanceof Error
          ? `${err.name}: ${err.message}`
          : String(err),
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
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      contextSnapshot: heartbeatRuns.contextSnapshot,
      resultJson: heartbeatRuns.resultJson,
      error: heartbeatRuns.error,
      status: heartbeatRuns.status,
      startedAt: heartbeatRuns.startedAt,
      createdAt: heartbeatRuns.createdAt,
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
  // [P5] honesty guard — telegram 답변 경로도 finalizeRunResponse와 동일하게 durable proof 대조.
  //   claimed action인데 이 run의 wakeup/comment proof가 0이면 caveat 부착(거짓 "깨웠다" 방지).
  const body = await applyRunHonestyCaveat(db, run, resultText);
  return {
    chatId,
    message: `${prefix}\n${body.slice(0, 3500)}`,
  };
}

/**
 * Format a live event as a human-readable Telegram notification.
 * Returns null if the event type should not be notified.
 */
/**
 * Compose an operator-readable run-failure notification from resolved context.
 * Pure function — exported for tests. Lines with missing context are omitted
 * so the message degrades gracefully instead of showing "unknown".
 */
export function composeRunFailureNotification(input: {
  status: string;
  runId: string;
  agentName?: string | null;
  issueIdentifier?: string | null;
  issueTitle?: string | null;
  missionTitle?: string | null;
  missionId?: string | null;
  error?: string | null;
}): string {
  const emoji = getRunStatusEmoji(input.status);
  const statusLabel =
    input.status === "timed_out" ? "시간 초과" :
    input.status === "cancelled" ? "취소" :
    "실패";
  const runLabel = input.runId.slice(0, 8);

  const issueLine = [
    input.issueIdentifier ?? null,
    input.issueTitle ?? null,
  ].filter(Boolean).join(" — ");

  const errorFirstLine = input.error?.split("\n")[0]?.trim() ?? "";
  const errorLine = errorFirstLine ? errorFirstLine.slice(0, 160) : null;

  const lines = [
    `${emoji} *런 ${statusLabel}*`,
    input.agentName ? `에이전트: ${input.agentName}` : null,
    issueLine ? `이슈: ${issueLine}` : null,
    input.missionTitle ? `미션: ${input.missionTitle}` : null,
    `런: *${runLabel}* (${input.status})`,
    errorLine ? `에러: ${errorLine}` : null,
  ].filter((line): line is string => Boolean(line));

  return lines.join("\n").slice(0, 3500);
}

/**
 * Build an enriched run-failure notification: resolve the run's agent, issue,
 * and mission from the DB so the operator can tell WHICH mission/issue failed.
 * Returns null for non-terminal-failure events (and when the run cannot be
 * loaded — the caller falls back to the minimal pure formatter).
 */
async function buildRunFailureNotification(
  db: Db,
  event: { type: string; payload?: Record<string, unknown> },
): Promise<string | null> {
  if (event.type !== "heartbeat.run.status") return null;
  const status = readString(event.payload?.status);
  const runId = readString(event.payload?.runId);
  if (!status || !runId) return null;
  if (!["failed", "timed_out", "cancelled"].includes(status)) return null;

  try {
    const [row] = await db
      .select({
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
        agentName: agents.name,
        issueIdentifier: issues.identifier,
        issueTitle: issues.title,
        missionId: issues.missionId,
        missionTitle: missions.title,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .leftJoin(issues, eq(heartbeatRuns.issueId, issues.id))
      .leftJoin(missions, eq(issues.missionId, missions.id))
      .where(eq(heartbeatRuns.id, runId))
      .limit(1);

    if (!row) return null;

    return composeRunFailureNotification({
      status,
      runId,
      agentName: row.agentName,
      issueIdentifier: row.issueIdentifier,
      issueTitle: row.issueTitle,
      missionTitle: row.missionTitle,
      missionId: row.missionId,
      error: row.error,
    });
  } catch (err) {
    logger.warn({
      msg: "Failed to enrich run-failure notification; falling back to minimal format",
      runId,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    return null;
  }
}

export function formatEventNotification(event: { type: string; payload?: Record<string, unknown> }): string | null {
  const { type, payload } = event;

  switch (type) {
    case "heartbeat.run.status": {
      const status = readString(payload?.status);
      const runId = readString(payload?.runId);
      if (!status || !runId) return null;
      if (!["failed", "timed_out", "cancelled"].includes(status)) return null;
      const emoji = getRunStatusEmoji(status);
      const runLabel = runId.slice(0, 8);
      return formatError(`${emoji} Run *${runLabel}* — ${formatStatus(status)}`);
    }

    // heartbeat.run.queued — suppressed: intermediate noise
    // agent.status — suppressed: intermediate noise
    // heartbeat.run.event — suppressed: intermediate noise
    // activity.logged — suppressed: intermediate noise

    case "plugin.ui.updated": {
      return null;
    }

    case "mission.human_input_requested": {
      const missionId = readString(payload?.missionId);
      const issueId = readString(payload?.issueId);
      const issueTitle = readString(payload?.issueTitle);
      const issueIdentifier = readString(payload?.issueIdentifier);
      const decision = readString(payload?.decision);
      const reason = readString(payload?.reason);
      const nextAction = readString(payload?.nextAction);
      const issueLabel = issueIdentifier ?? (issueId ? issueId.slice(0, 8) : null);
      const lines = [
        "*Human input required*",
        issueTitle && issueLabel ? `${issueLabel} — ${issueTitle}` : issueTitle ?? (issueLabel ? `Issue ${issueLabel}` : null),
        missionId ? `Mission: ${missionId.slice(0, 8)}` : null,
        decision ? `Decision: ${decision}` : null,
        reason ? `Reason: ${reason}` : null,
        nextAction ? `Next: ${nextAction}` : null,
      ].filter((line): line is string => Boolean(line));
      return lines.length > 1 ? lines.join("\n").slice(0, 3500) : null;
    }

    case "plugin.worker.crashed": {
      const pluginKey = readString(payload?.pluginKey);
      const workerId = readString(payload?.workerId);
      const msg = `Plugin worker crashed${pluginKey ? `: ${pluginKey}` : ""}${workerId ? ` (${workerId.slice(0, 8)})` : ""}`;
      return formatError(msg);
    }

    case "plugin.worker.restarted": {
      return null;
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
    // [outbound persistence] 재시작 전에 저장된 chatId 로 인메모리 맵을 복원한다.
    const persistedChatId = (config.configJson as { telegramChatId?: unknown } | null)?.telegramChatId;
    if (typeof persistedChatId === "number" && Number.isFinite(persistedChatId) && !companyChatIds.has(companyId)) {
      companyChatIds.set(companyId, persistedChatId);
      logger.info({ msg: "Telegram chatId restored from channel config", companyId });
    }
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
