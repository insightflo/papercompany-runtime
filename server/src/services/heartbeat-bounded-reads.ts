import { and, desc, eq, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import type {
  HeartbeatRunCounts,
  HeartbeatRunDailyStat,
  HeartbeatRunStatus,
  HeartbeatRunStats,
} from "@paperclipai/shared";

export {
  attentionHeartbeatRuns,
  clampAttentionLimit,
  HEARTBEAT_RUN_ATTENTION_DEFAULT_LIMIT,
  HEARTBEAT_RUN_ATTENTION_MAX_LIMIT,
  type HeartbeatRunAttentionInput,
} from "./heartbeat-attention-reads.js";

export const HEARTBEAT_RUN_LIST_DEFAULT_LIMIT = 100;
export const HEARTBEAT_RUN_LIST_MAX_LIMIT = 500;
export const HEARTBEAT_RUN_STATS_DAYS_DEFAULT = 14;
export const HEARTBEAT_RUN_STATS_DAYS_MAX = 90;

export function clampRunListLimit(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return HEARTBEAT_RUN_LIST_DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.floor(value), HEARTBEAT_RUN_LIST_MAX_LIMIT));
}

export function clampStatsDays(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return HEARTBEAT_RUN_STATS_DAYS_DEFAULT;
  return Math.max(1, Math.min(Math.floor(value), HEARTBEAT_RUN_STATS_DAYS_MAX));
}

/** Lightweight columns for bounded reads; excludes heavy JSON/log payloads. */
const heartbeatRunSummaryColumns = {
  id: heartbeatRuns.id,
  companyId: heartbeatRuns.companyId,
  agentId: heartbeatRuns.agentId,
  invocationSource: heartbeatRuns.invocationSource,
  triggerDetail: heartbeatRuns.triggerDetail,
  status: heartbeatRuns.status,
  startedAt: heartbeatRuns.startedAt,
  finishedAt: heartbeatRuns.finishedAt,
  error: heartbeatRuns.error,
  errorCode: heartbeatRuns.errorCode,
  exitCode: heartbeatRuns.exitCode,
  signal: heartbeatRuns.signal,
  usageJson: heartbeatRuns.usageJson,
  resultSummary: sql<string | null>`left(coalesce(${heartbeatRuns.resultJson}->>'summary', ${heartbeatRuns.resultJson}->>'result'), 500)`,
  issueId: heartbeatRuns.issueId,
  createdAt: heartbeatRuns.createdAt,
  updatedAt: heartbeatRuns.updatedAt,
} as const;

export interface HeartbeatRunSummaryPageInput {
  companyId: string;
  agentId?: string;
  limit?: number;
  cursor?: { createdAt: Date; id: string } | null;
}

/** Stable (createdAt desc, id desc) cursor page; fetch limit+1 and return nextCursor. */
export async function listHeartbeatRunSummaryPage(db: Db, input: HeartbeatRunSummaryPageInput) {
  const limit = clampRunListLimit(input.limit);
  const conditions: SQL[] = [eq(heartbeatRuns.companyId, input.companyId)];
  if (input.agentId) conditions.push(eq(heartbeatRuns.agentId, input.agentId));
  if (input.cursor) {
    conditions.push(
      or(
        lt(heartbeatRuns.createdAt, input.cursor.createdAt),
        and(eq(heartbeatRuns.createdAt, input.cursor.createdAt), lt(heartbeatRuns.id, input.cursor.id)),
      ) as SQL,
    );
  }

  const rows = await db
    .select(heartbeatRunSummaryColumns)
    .from(heartbeatRuns)
    .where(and(...conditions))
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1] ?? null;
  return {
    items: pageRows,
    nextCursor: hasMore && last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null,
  };
}

export interface HeartbeatRunCountInput {
  companyId: string;
  agentId?: string;
  statuses?: HeartbeatRunStatus[];
}

export async function countHeartbeatRuns(db: Db, input: HeartbeatRunCountInput): Promise<HeartbeatRunCounts> {
  const conditions: SQL[] = [eq(heartbeatRuns.companyId, input.companyId)];
  if (input.agentId) conditions.push(eq(heartbeatRuns.agentId, input.agentId));
  if (input.statuses && input.statuses.length > 0) conditions.push(inArray(heartbeatRuns.status, input.statuses));

  const rows = await db
    .select({
      status: heartbeatRuns.status,
      count: sql<number>`count(*)`,
    })
    .from(heartbeatRuns)
    .where(and(...conditions))
    .groupBy(heartbeatRuns.status);

  const counts: HeartbeatRunCounts = {
    total: 0,
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    timedOut: 0,
  };
  for (const row of rows) {
    const value = Number(row.count ?? 0);
    counts.total += value;
    if (row.status === "timed_out") {
      counts.timedOut += value;
      continue;
    }
    const key = row.status as keyof HeartbeatRunCounts;
    if (key in counts) counts[key] = value;
  }
  return counts;
}

export interface HeartbeatRunStatsInput {
  companyId: string;
  agentId?: string;
  days?: number;
}

export async function statsHeartbeatRuns(db: Db, input: HeartbeatRunStatsInput): Promise<HeartbeatRunStats> {
  const dayCount = clampStatsDays(input.days);
  const conditions: SQL[] = [eq(heartbeatRuns.companyId, input.companyId)];
  if (input.agentId) conditions.push(eq(heartbeatRuns.agentId, input.agentId));

  const rows = await db
    .select({
      day: sql<string>`to_char(${heartbeatRuns.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
      status: heartbeatRuns.status,
      count: sql<number>`count(*)`,
    })
    .from(heartbeatRuns)
    .where(
      and(
        ...conditions,
        sql`${heartbeatRuns.createdAt} >= (date_trunc('day', now() AT TIME ZONE 'UTC') - interval '${sql.raw(String(dayCount - 1))} days') AT TIME ZONE 'UTC'`,
      ),
    )
    .groupBy(sql`to_char(${heartbeatRuns.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`, heartbeatRuns.status);

  const dayMap = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const day = row.day ?? "";
    const statusCounts = dayMap.get(day) ?? new Map<string, number>();
    statusCounts.set(row.status, Number(row.count ?? 0));
    dayMap.set(day, statusCounts);
  }

  const days: HeartbeatRunDailyStat[] = [];
  let total = 0;
  for (let i = dayCount - 1; i >= 0; i -= 1) {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - i);
    const day = date.toISOString().slice(0, 10);
    const statusCounts = dayMap.get(day) ?? new Map<string, number>();
    const stat: HeartbeatRunDailyStat = {
      day,
      succeeded: statusCounts.get("succeeded") ?? 0,
      failed: statusCounts.get("failed") ?? 0,
      cancelled: statusCounts.get("cancelled") ?? 0,
      timedOut: statusCounts.get("timed_out") ?? 0,
      other: 0,
      total: 0,
    };
    for (const [status, value] of statusCounts) {
      if (status === "succeeded" || status === "failed" || status === "cancelled" || status === "timed_out") continue;
      stat.other += value;
    }
    stat.total = stat.succeeded + stat.failed + stat.cancelled + stat.timedOut + stat.other;
    total += stat.total;
    days.push(stat);
  }

  return { days, total };
}
