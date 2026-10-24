// 기존 트랜잭션 안에서 대기 요청을 run에 연결한다. 선점·외부 실행은 호출자 책임이다.
import { and, eq, inArray } from "drizzle-orm";
import { activityLog, agents, agentWakeupRequests, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { parseObject } from "../adapters/utils.js";
import { logger } from "../middleware/logger.js";
import { resolveNextDispatchGeneration } from "./effect-envelope.js";
import { normalizeAgentNameKey, readNonEmptyString } from "./heartbeat-run-context.js";
import {
  buildQualityWakeAcceptancePatch,
  nextPlanQaResubmissionExecutionEpoch,
  planQaResubmissionPromotionAcceptancePatch,
} from "./quality/heartbeat-admission.js";


/** Pure HB insertion; each caller retains its own session, clock and acceptance semantics. */
export async function insertQueuedHeartbeat(db: Db, input: {
  agent: AgentRow; issueId: string | null; source: FollowupContextInput["source"]; triggerDetail: string | null;
  wakeupRequestId: string; contextSnapshot: Record<string, unknown>; taskKey: string | null;
  sessionBefore: string | null; executionEpoch?: number;
}) {
  const { agent, issueId, source, triggerDetail, wakeupRequestId, contextSnapshot, taskKey, sessionBefore, executionEpoch } = input;
  return db.insert(heartbeatRuns).values({
    companyId: agent.companyId, agentId: agent.id, issueId, invocationSource: source, triggerDetail,
    status: "queued", wakeupRequestId, sessionIdBefore: sessionBefore,
    contextSnapshot: { ...contextSnapshot,
      dispatchGeneration: await resolveNextDispatchGeneration(db, { agentId: agent.id, issueId, taskKey }) },
    ...(executionEpoch !== undefined ? { executionEpoch } : {}),
  }).returning().then(rows => rows[0]);
}

async function startLinkedIssue(deps: HeartbeatFollowupPromotionDeps, tx: FollowupTx, input: {
  agent: AgentRow; issue: Pick<IssueRow, "id" | "companyId" | "status">; run: typeof heartbeatRuns.$inferSelect;
  now: Date; allowDone: boolean; reason: "queued_wakeup_promoted" | "issue_linked_run_started";
}) {
  const { agent, issue, run, now, allowDone, reason } = input;
  const statuses = allowDone ? [...deps.issueRunStartStatuses, "done"] : deps.issueRunStartStatuses;
  const started = await tx.update(issues).set({
    executionRunId: run.id, checkoutRunId: run.id, status: "in_progress", startedAt: now,
    completedAt: null, cancelledAt: null, executionAgentNameKey: normalizeAgentNameKey(agent.name),
    executionLockedAt: now, updatedAt: now,
  }).where(and(eq(issues.id, issue.id), inArray(issues.status, statuses)))
    .returning({ id: issues.id }).then(rows => rows[0] ?? null);
  if (started) {
    await tx.insert(activityLog).values({
      companyId: issue.companyId, actorType: "system", actorId: "heartbeat", action: "issue.execution_started",
      entityType: "issue", entityId: issue.id, agentId: agent.id, runId: run.id,
      details: { previousStatus: issue.status, nextStatus: "in_progress", reason },
    });
  } else if (reason === "issue_linked_run_started") {
    // Preserve ordinary post-terminal admission: a missed checkout CAS is diagnostic, not a refusal.
    logger.debug(
      { issueId: issue.id, issueStatus: issue.status, runId: run.id, agentId: agent.id },
      "issue checkout CAS matched no row: run admitted without execution lock (post-terminal wake)",
    );
  }
}

export async function insertInitialWakeupRun(deps: HeartbeatFollowupPromotionDeps, tx: FollowupTx, input: {
  agent: AgentRow; request: WakeRow; contextSnapshot: Record<string, unknown>; taskKey: string | null;
  sessionBefore: string | null; issue: Pick<IssueRow, "id" | "companyId" | "status"> | null; isWorkflowStepResume: boolean;
}) {
  const { agent, request, contextSnapshot, taskKey, sessionBefore, issue, isWorkflowStepResume } = input;
  const run = await insertQueuedHeartbeat(tx as unknown as Db, {
    agent, issueId: request.issueId, source: request.source as FollowupContextInput["source"],
    triggerDetail: request.triggerDetail, wakeupRequestId: request.id, contextSnapshot, taskKey, sessionBefore,
  });
  await tx.update(agentWakeupRequests).set({
    runId: run.id, updatedAt: new Date(),
    ...(issue ? await buildQualityWakeAcceptancePatch(tx as unknown as Db, {
      companyId: agent.companyId, agentId: agent.id, issueId: issue.id, workflowRunId: request.workflowRunId,
      idempotencyKey: request.idempotencyKey, runId: run.id, acceptedAt: new Date(),
    }) : {}),
  }).where(eq(agentWakeupRequests.id, request.id));
  if (issue) await startLinkedIssue(deps, tx, {
    agent, issue, run, now: new Date(), allowDone: isWorkflowStepResume, reason: "issue_linked_run_started",
  });
  return run;
}

type AgentRow = typeof agents.$inferSelect;
type WakeRow = typeof agentWakeupRequests.$inferSelect;
type IssueRow = typeof issues.$inferSelect;
export type FollowupTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type FollowupContextInput = {
  contextSnapshot: Record<string, unknown>;
  reason: string | null;
  source: "timer" | "assignment" | "on_demand" | "automation" | "scheduler" | undefined;
  triggerDetail: string | null | undefined;
  payload: Record<string, unknown> | null;
};
export type HeartbeatFollowupPromotionDeps = {
  deferredWakeContextKey: string;
  issueRunStartStatuses: string[];
  enrichWakeContextSnapshot: (input: FollowupContextInput) => {
    contextSnapshot: Record<string, unknown>;
    issueIdFromPayload: string | null;
    commentIdFromPayload: string | null;
    taskKey: string | null;
    wakeCommentId: string | null;
  };
  resolveSessionBeforeForWakeup: (
    agent: AgentRow, taskKey: string | null, opts?: { missionId?: string | null },
  ) => Promise<string | null>;
};
export type QueuedWakeupPromotionInput = {
  agent: AgentRow;
  request: WakeRow;
  promotedContextSnapshot: Record<string, unknown>;
  promotedSource: FollowupContextInput["source"];
  promotedTriggerDetail: string | null;
  promotedIssueId: string | null;
  promotedTaskKey: string | null;
  missionIdForWake: string | null;
  promotedIssue: Pick<IssueRow, "id" | "companyId" | "projectId" | "missionId" | "originKind" | "status"> | null;
  isWorkflowStepResume: boolean;
  isPlanReworkPromotion: boolean;
};

export async function promoteQueuedWakeupRequest(
  deps: HeartbeatFollowupPromotionDeps, tx: FollowupTx, input: QueuedWakeupPromotionInput,
) {
  const { resolveSessionBeforeForWakeup } = deps;
  const {
    agent, request, promotedContextSnapshot, promotedSource, promotedTriggerDetail,
    promotedIssueId, promotedTaskKey, missionIdForWake, promotedIssue,
    isWorkflowStepResume, isPlanReworkPromotion,
  } = input;
  const sessionBefore = await resolveSessionBeforeForWakeup(agent, promotedTaskKey, {
    missionId: missionIdForWake,
  });
  // [T8 bounded resubmission] 재제출 승격 run 은 실제 새 execution epoch 로 시작한다(이전 시도 epoch 재사용 금지).
  const resubmissionExecutionEpoch = await nextPlanQaResubmissionExecutionEpoch(tx as unknown as Db, {
    idempotencyKey: request.idempotencyKey, companyId: agent.companyId, issueId: promotedIssueId,
  });
  const now = new Date();
  const newRun = await insertQueuedHeartbeat(tx as unknown as Db, {
    agent, issueId: promotedIssueId, source: promotedSource, triggerDetail: promotedTriggerDetail,
    wakeupRequestId: request.id, contextSnapshot: promotedContextSnapshot, taskKey: promotedTaskKey,
    sessionBefore, ...(resubmissionExecutionEpoch !== null ? { executionEpoch: resubmissionExecutionEpoch } : {}),
  });

  await tx
    .update(agentWakeupRequests)
    .set({
      runId: newRun.id,
      claimedAt: null,
      finishedAt: null,
      error: null,
      updatedAt: now,
      // [T4 quality] 대기 행이 실행으로 승격되는 시점이 곧 수락 시점이다 —
      // 승격 tx 안에서 수락 원문을 기록한다.
      ...(await buildQualityWakeAcceptancePatch(tx as unknown as Db, {
        companyId: agent.companyId,
        agentId: agent.id,
        issueId: promotedIssueId,
        workflowRunId: request.workflowRunId,
        idempotencyKey: request.idempotencyKey,
        runId: newRun.id,
        acceptedAt: now,
      })),
    })
    .where(eq(agentWakeupRequests.id, request.id));

  if (promotedIssue) await startLinkedIssue(deps, tx, {
    agent, issue: promotedIssue, run: newRun, now,
    allowDone: isWorkflowStepResume || isPlanReworkPromotion, reason: "queued_wakeup_promoted",
  });

  return newRun;
}

export async function promoteDeferredWakeupRequest(
  deps: HeartbeatFollowupPromotionDeps,
  tx: FollowupTx,
  input: { deferred: WakeRow; deferredAgent: AgentRow; issue: Pick<IssueRow, "id"> },
) {
  const { deferredWakeContextKey: DEFERRED_WAKE_CONTEXT_KEY, enrichWakeContextSnapshot, resolveSessionBeforeForWakeup } = deps;
  const { deferred, deferredAgent, issue } = input;
  const deferredPayload = parseObject(deferred.payload);
  const deferredContextSeed = parseObject(deferredPayload[DEFERRED_WAKE_CONTEXT_KEY]);
  const promotedContextSeed: Record<string, unknown> = { ...deferredContextSeed };
  const promotedReason = readNonEmptyString(deferred.reason) ?? "issue_execution_promoted";
  const promotedSource =
    (readNonEmptyString(deferred.source) as FollowupContextInput["source"]) ?? "automation";
  const promotedTriggerDetail =
    (readNonEmptyString(deferred.triggerDetail) as FollowupContextInput["triggerDetail"]) ?? null;
  const promotedPayload = deferredPayload;
  delete promotedPayload[DEFERRED_WAKE_CONTEXT_KEY];

  const {
    contextSnapshot: promotedContextSnapshot,
    taskKey: promotedTaskKey,
  } = enrichWakeContextSnapshot({
    contextSnapshot: promotedContextSeed,
    reason: promotedReason,
    source: promotedSource,
    triggerDetail: promotedTriggerDetail,
    payload: promotedPayload,
  });

  const sessionBefore = await resolveSessionBeforeForWakeup(deferredAgent, promotedTaskKey, {
    missionId: readNonEmptyString(promotedContextSnapshot.missionId),
  });
  const now = new Date();
  const newRun = await insertQueuedHeartbeat(tx as unknown as Db, {
    agent: deferredAgent, issueId: issue.id, source: promotedSource, triggerDetail: promotedTriggerDetail,
    wakeupRequestId: deferred.id, contextSnapshot: promotedContextSnapshot, taskKey: promotedTaskKey, sessionBefore,
  });

  await tx
    .update(agentWakeupRequests)
    .set({
      status: "queued",
      reason: "issue_execution_promoted",
      runId: newRun.id,
      claimedAt: null,
      finishedAt: null,
      error: null,
      updatedAt: now,
      // [T8 bounded resubmission] PLAN-QA 재제출 키는 대기 행이 실제 run 으로 승격되는
      //   이 시점이 수락 시점이다 — admission 원문을 같은 tx 에 기록한다(품질 조치 키의
      //   기존 deferred 동작은 의도적으로 변경하지 않는다).
      ...(await planQaResubmissionPromotionAcceptancePatch(tx as unknown as Db, {
        companyId: deferredAgent.companyId, agentId: deferredAgent.id, issueId: issue.id,
        workflowRunId: deferred.workflowRunId, idempotencyKey: deferred.idempotencyKey,
        runId: newRun.id, acceptedAt: now,
      }) ?? {}),
    })
    .where(eq(agentWakeupRequests.id, deferred.id));

  await tx
    .update(issues)
    .set({
      executionRunId: newRun.id,
      executionAgentNameKey: normalizeAgentNameKey(deferredAgent.name),
      executionLockedAt: now,
      updatedAt: now,
    })
    .where(eq(issues.id, issue.id));

  return newRun;
}
