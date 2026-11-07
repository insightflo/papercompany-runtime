import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { activityLog, agentWakeupRequests, heartbeatRuns, workflowTransitionEvents, withTxTimeout, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "./live-events.js";
import { publishHeartbeatRunStatus } from "./heartbeat-agent-cancellation.js";
import { recordHeartbeatTerminalOutcomeShadow } from "./heartbeat-finalization/shadow-writes.js";
import { maybeRecordTerminalFinalization } from "./heartbeat-finalization/shadow-terminal-hook.js";
import { isTerminalHeartbeatRunStatus } from "./heartbeat-run-status.js";
import { OPERATOR_DECISION_WAKE_PREFIX } from "./operator-decision-continuation-store.js";

export async function recordHeartbeatQueueTransitionEvent(db: Db, input: {
  companyId: string;
  missionId?: string | null;
  issueId?: string | null;
  wakeupRequestId?: string | null;
  heartbeatRunId?: string | null;
  workflowRunId?: string | null;
  workflowStepRunId?: string | null;
  eventType: string;
  layer: string;
  decision?: string | null;
  reason?: string | null;
  reasonCode?: string | null;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
}) {
  try {
    await db.insert(workflowTransitionEvents).values({
      companyId: input.companyId,
      missionId: input.missionId ?? null,
      issueId: input.issueId ?? null,
      wakeupRequestId: input.wakeupRequestId ?? null,
      heartbeatRunId: input.heartbeatRunId ?? null,
      workflowRunId: input.workflowRunId ?? null,
      workflowStepRunId: input.workflowStepRunId ?? null,
      eventType: input.eventType,
      layer: input.layer,
      decision: input.decision ?? null,
      reason: input.reason ?? null,
      reasonCode: input.reasonCode ?? null,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload ?? {},
    }).onConflictDoNothing();
  } catch {
    // unique index on (company_id, idempotency_key) WHERE not null - duplicate, ignore
  }
}

export async function recordHeartbeatRunTerminalTransitionEvent(
  db: Db,
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "wakeupRequestId" | "issueId" | "status" | "errorCode" | "error">,
) {
  if (!isTerminalHeartbeatRunStatus(run.status)) return;
  await recordHeartbeatQueueTransitionEvent(db, {
    companyId: run.companyId,
    heartbeatRunId: run.id,
    wakeupRequestId: run.wakeupRequestId,
    issueId: run.issueId,
    eventType: "queue_run_completed",
    layer: "heartbeat",
    decision: run.status,
    reason: run.errorCode ?? run.error ?? "run_terminal",
    reasonCode: run.errorCode ?? "run_terminal",
    idempotencyKey: `queue-run-completed:${run.id}:${run.status}`,
  });
}

// [CMP-199 coalesced wake 유실] 종료된 런에 병합(coalesced)된 채 활성 런이 컨텍스트를 소비하지 않고
// 끝나면 깨움이 영구 유실된다. operator-decision-wake:* 키의 coalesced 행은 런 종료 시
// queued 로 되돌려 기존 승격 경로(promoteQueuedWakeupRequestsForAgent)가 다시 전달하게 한다.
// 조건부 UPDATE(status='coalesced' AND run_id 일치)로 멱등: 같은 런을 두 번 sweep 하면 두 번째는 0건.
export async function requeueCoalescedWakeupsForFinishedRun(
  db: Db,
  input: { companyId: string; runId: string },
): Promise<number> {
  return withTxTimeout(db, async (tx) => {
    const rows = await tx
      .select({
        id: agentWakeupRequests.id,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
        issueIdFromPayload: sql<string | null>`${agentWakeupRequests.payload} ->> 'issueId'`,
      })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.runId, input.runId),
        eq(agentWakeupRequests.status, "coalesced"),
        sql`${agentWakeupRequests.idempotencyKey} like ${OPERATOR_DECISION_WAKE_PREFIX + "%"}`,
      ))
      .orderBy(asc(agentWakeupRequests.requestedAt));

    let requeuedCount = 0;
    for (const row of rows) {
      const updated = await tx
        .update(agentWakeupRequests)
        .set({
          status: "queued",
          runId: null,
          coalescedCount: sql`${agentWakeupRequests.coalescedCount} + 1`,
          finishedAt: null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(agentWakeupRequests.id, row.id),
          eq(agentWakeupRequests.companyId, input.companyId),
          eq(agentWakeupRequests.runId, input.runId),
          eq(agentWakeupRequests.status, "coalesced"),
        ))
        .returning({ id: agentWakeupRequests.id })
        .then((updatedRows) => updatedRows[0] ?? null);
      if (!updated) continue;

      await tx.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "system",
        actorId: "heartbeat",
        action: "agent_wakeup.coalesced_requeued",
        entityType: row.issueIdFromPayload ? "issue" : "wakeup_request",
        entityId: row.issueIdFromPayload ?? row.id,
        details: {
          wakeupRequestId: row.id,
          idempotencyKey: row.idempotencyKey,
          runId: input.runId,
        },
      });
      requeuedCount += 1;
    }
    return requeuedCount;
  });
}




/**
 * [run-status fencing v1] heartbeat_runs 상태 전이의 중앙 작성자.
 * opts.expectedStatuses 를 넘기면 compare-and-set 이 된다: 현재 상태가 목록에 없는
 * 행은 갱신되지 않고(죽은/취소된 실행자의 늦은 상태 기록이 새 상태를 덮어쓰는
 * 좀비쓰기 방지), 폐기 사실을 logger.info 로 남긴다. 미전달 시 기존 무조건 갱신
 * 동작을 유지한다(호환). 갱신 성공 시의 파생 기록(shadow/live event/종말 이벤트/
 * finalization)은 기존 setRunStatus 와 동일하게 수행된다.
 */
export async function setHeartbeatRunStatus(
  db: Db,
  runId: string,
  status: string,
  patch?: Partial<typeof heartbeatRuns.$inferInsert>,
  opts?: { expectedStatuses?: string[]; deferLiveEvent?: boolean; expectedRun?: typeof heartbeatRuns.$inferSelect },
) {
  const expectedStatuses = opts?.expectedStatuses?.length ? opts.expectedStatuses : null;
  const updated = await db
    .update(heartbeatRuns)
    .set({ status, ...patch, updatedAt: new Date() })
    .where(
      and(eq(heartbeatRuns.id, runId),
        expectedStatuses ? inArray(heartbeatRuns.status, expectedStatuses) : undefined,
        opts?.expectedRun ? eq(heartbeatRuns.companyId, opts.expectedRun.companyId) : undefined,
        opts?.expectedRun ? eq(heartbeatRuns.agentId, opts.expectedRun.agentId) : undefined,
        opts?.expectedRun ? sql`${heartbeatRuns.issueId} is not distinct from ${opts.expectedRun.issueId}` : undefined,
        opts?.expectedRun ? sql`${heartbeatRuns.wakeupRequestId} is not distinct from ${opts.expectedRun.wakeupRequestId}` : undefined,
        opts?.expectedRun ? sql`${heartbeatRuns.workflowStepRunId} is not distinct from ${opts.expectedRun.workflowStepRunId}` : undefined,
        opts?.expectedRun ? sql`${heartbeatRuns.workflowExecutionGeneration} is not distinct from ${opts.expectedRun.workflowExecutionGeneration}` : undefined,
        opts?.expectedRun ? sql`${heartbeatRuns.executionScopeKind} is not distinct from ${opts.expectedRun.executionScopeKind}` : undefined,
        opts?.expectedRun ? sql`${heartbeatRuns.executionEpoch} is not distinct from ${opts.expectedRun.executionEpoch}` : undefined,
        opts?.expectedRun ? sql`${heartbeatRuns.executionToken} is not distinct from ${opts.expectedRun.executionToken}` : undefined,
        opts?.expectedRun ? sql`${heartbeatRuns.executorOwnerId} is not distinct from ${opts.expectedRun.executorOwnerId}` : undefined,
        opts?.expectedRun ? sql`${heartbeatRuns.executorOwnerLeaseToken} is not distinct from ${opts.expectedRun.executorOwnerLeaseToken}` : undefined,
        opts?.expectedRun ? sql`${heartbeatRuns.executorOwnerLeaseEpoch} is not distinct from ${opts.expectedRun.executorOwnerLeaseEpoch}` : undefined,
        opts?.expectedRun ? sql`${heartbeatRuns.retryOfRunId} is not distinct from ${opts.expectedRun.retryOfRunId}` : undefined,
        opts?.expectedRun ? sql`${heartbeatRuns.processLossRetryCount} is not distinct from ${opts.expectedRun.processLossRetryCount}` : undefined),
    )
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!updated && expectedStatuses) {
    logger.info({ runId, attempted: status, expectedStatuses }, "fenced run-status write discarded");
  }
  if (updated) await recordHeartbeatTerminalOutcomeShadow(db, updated);

  if (updated && !opts?.deferLiveEvent) publishHeartbeatRunStatus(publishLiveEvent, updated);

  // [Task 6C] queue_run_completed event for terminal status
  if (updated) await recordHeartbeatRunTerminalTransitionEvent(db, updated);
  if (updated) await maybeRecordTerminalFinalization(db, updated, new Date());

  return updated;
}

export function publishQueuedRun(run: typeof heartbeatRuns.$inferSelect) {
    publishLiveEvent({
      companyId: run.companyId, type: "heartbeat.run.queued",
      payload: { runId: run.id, agentId: run.agentId, invocationSource: run.invocationSource,
        triggerDetail: run.triggerDetail, wakeupRequestId: run.wakeupRequestId },
    });
  }

// [목적] queued wakeup promote 시 "이 issue 는 이미 끝났으니 재실행 거절" 판정할 terminal 상태.
//   done/completed/cancelled(canceled)/closed 는 재시도 무의미 → request failed 로 종료.
export const PROMOTED_REJECT_ISSUE_STATUSES = new Set(["done", "completed", "cancelled", "canceled", "closed", "wontfix"]);

export const ISSUE_RUN_START_STATUSES = ["backlog", "todo", "blocked", "in_review", "in_progress"];
