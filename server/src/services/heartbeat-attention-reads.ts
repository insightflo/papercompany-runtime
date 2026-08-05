import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues } from "@paperclipai/db";
import type {
  HeartbeatRunAttention,
  HeartbeatRunAttentionItem,
  HeartbeatRunAttentionSummary,
  HeartbeatRunStatus,
} from "@paperclipai/shared";

export const HEARTBEAT_RUN_ATTENTION_DEFAULT_LIMIT = 50;
export const HEARTBEAT_RUN_ATTENTION_MAX_LIMIT = 200;

export function clampAttentionLimit(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return HEARTBEAT_RUN_ATTENTION_DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.floor(value), HEARTBEAT_RUN_ATTENTION_MAX_LIMIT));
}

export interface HeartbeatRunAttentionInput {
  companyId: string;
  agentId?: string;
  limit?: number;
  cursor?: { createdAt: Date; id: string } | null;
  /**
   * Run ids locally dismissed by the board UI. These are excluded from the
   * eligible set (and therefore the exact summary and pages) only when the
   * run is actually a current attention run — a stale id has no effect.
   * Bounded to 200 to keep URLs/caches small.
   */
  dismissedRunIds?: string[];
}

const MAX_DISMISSED_RUN_IDS = 200;

const ATTENTION_STATUSES = new Set(["failed", "timed_out", "cancelled"]);
const RESOLVED_ISSUE_STATUSES = new Set(["done", "cancelled", "completed"]);

/** Lightweight columns for attention reads; only contextSnapshot is added
 * for legacy issue linkage (no resultJson/log payloads). */
const heartbeatRunAttentionColumns = {
  id: heartbeatRuns.id,
  agentId: heartbeatRuns.agentId,
  status: heartbeatRuns.status,
  issueId: heartbeatRuns.issueId,
  createdAt: heartbeatRuns.createdAt,
  error: heartbeatRuns.error,
  errorCode: heartbeatRuns.errorCode,
  contextSnapshot: heartbeatRuns.contextSnapshot,
} as const;

/**
 * Resolve the issue linked to a run: heartbeat_runs.issue_id first, then the
 * legacy context_snapshot.issueId, then context_snapshot.taskId.
 */
function resolveAttentionIssueId(row: {
  issueId: string | null;
  contextSnapshot: Record<string, unknown> | null;
}): string | null {
  if (row.issueId) return row.issueId;
  const context = row.contextSnapshot;
  if (!context) return null;
  const issueId = context["issueId"];
  if (typeof issueId === "string" && issueId.length > 0) return issueId;
  const taskId = context["taskId"];
  if (typeof taskId === "string" && taskId.length > 0) return taskId;
  return null;
}

/**
 * Exact latest run per agent (DISTINCT ON agentId over the full company
 * scope), then keep only attention statuses (failed/timed_out/cancelled).
 * A later succeeded run clears an older failure for the same agent, and a
 * latest attention run whose issue is resolved is excluded. The summary
 * counts ALL matching latest runs (not just the returned page); items are
 * paged newest-first with a (createdAt, id) cursor.
 */
export async function attentionHeartbeatRuns(db: Db, input: HeartbeatRunAttentionInput): Promise<HeartbeatRunAttention> {
  const limit = clampAttentionLimit(input.limit);
  const scopeConditions: SQL[] = [eq(heartbeatRuns.companyId, input.companyId)];
  if (input.agentId) scopeConditions.push(eq(heartbeatRuns.agentId, input.agentId));

  const latestRun = db
    .selectDistinctOn([heartbeatRuns.agentId], heartbeatRunAttentionColumns)
    .from(heartbeatRuns)
    .where(and(...scopeConditions))
    .orderBy(heartbeatRuns.agentId, desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
    .as("latest_attention_run");

  const allLatest = await db
    .select({
      id: latestRun.id,
      agentId: latestRun.agentId,
      status: latestRun.status,
      issueId: latestRun.issueId,
      createdAt: latestRun.createdAt,
      error: latestRun.error,
      errorCode: latestRun.errorCode,
      contextSnapshot: latestRun.contextSnapshot,
    })
    .from(latestRun)
    .where(inArray(latestRun.status, Array.from(ATTENTION_STATUSES)));

  // Resolve issue linkage (issue_id -> context.issueId -> context.taskId)
  // so resolved issues are excluded and returned items keep a usable id.
  const rowsWithIssue = allLatest.map((row) => ({
    ...row,
    resolvedIssueId: resolveAttentionIssueId(row),
  }));

  const issueIds = Array.from(new Set(rowsWithIssue.map((row) => row.resolvedIssueId).filter((id): id is string => !!id)));
  const resolvedIssueIds = new Set<string>();
  if (issueIds.length > 0) {
    const issueRows = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(and(eq(issues.companyId, input.companyId), inArray(issues.id, issueIds)));
    for (const issueRow of issueRows) {
      if (RESOLVED_ISSUE_STATUSES.has(issueRow.status)) resolvedIssueIds.add(issueRow.id);
    }
  }

  const dismissedIds = new Set((input.dismissedRunIds ?? []).slice(0, MAX_DISMISSED_RUN_IDS));
  const eligible = rowsWithIssue
    .filter((row) => !row.resolvedIssueId || !resolvedIssueIds.has(row.resolvedIssueId))
    .filter((row) => !dismissedIds.has(row.id))
    .sort((a, b) => {
      const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
      if (timeDiff !== 0) return timeDiff;
      return b.id.localeCompare(a.id);
    });

  const summary: HeartbeatRunAttentionSummary = {
    failed: eligible.filter((item) => item.status === "failed").length,
    timedOut: eligible.filter((item) => item.status === "timed_out").length,
    cancelled: eligible.filter((item) => item.status === "cancelled").length,
    agents: eligible.length,
  };

  // Keyset boundary: first eligible row strictly older than the cursor.
  // A stale/missing cursor row degrades to the same boundary, not page 1.
  let startIndex = 0;
  if (input.cursor) {
    const cursorTime = input.cursor.createdAt.getTime();
    startIndex = eligible.findIndex((row) => row.createdAt.getTime() < cursorTime ||
      (row.createdAt.getTime() === cursorTime && row.id < input.cursor!.id));
    if (startIndex < 0) startIndex = eligible.length;
  }
  const pageRows = eligible.slice(startIndex, startIndex + limit);
  const last = pageRows[pageRows.length - 1] ?? null;

  const items: HeartbeatRunAttentionItem[] = pageRows.map((row) => ({
    runId: row.id,
    agentId: row.agentId,
    status: row.status as HeartbeatRunStatus,
    issueId: row.resolvedIssueId,
    createdAt: row.createdAt,
    error: row.error,
    errorCode: row.errorCode,
  }));

  return {
    summary,
    items,
    nextCursor: startIndex + limit < eligible.length && last
      ? { createdAt: last.createdAt.toISOString(), id: last.id }
      : null,
  };
}
