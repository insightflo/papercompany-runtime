// 기존 트랜잭션 안에서 대기 요청을 run에 연결한다. 선점·외부 실행은 호출자 책임이다.
import { and, eq, inArray } from "drizzle-orm";
import { activityLog, agents, agentWakeupRequests, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { parseObject } from "../adapters/utils.js";
import { resolveNextDispatchGeneration } from "./effect-envelope.js";
import { normalizeAgentNameKey, readNonEmptyString } from "./heartbeat-run-context.js";
import {
  buildQualityWakeAcceptancePatch,
  nextPlanQaResubmissionExecutionEpoch,
  planQaResubmissionPromotionAcceptancePatch,
} from "./quality/heartbeat-admission.js";

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
  const { resolveSessionBeforeForWakeup, issueRunStartStatuses: ISSUE_RUN_START_STATUSES } = deps;
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
  const newRun = await tx
    .insert(heartbeatRuns)
    .values({
      companyId: agent.companyId,
      agentId: agent.id,
      issueId: promotedIssueId,
      invocationSource: promotedSource,
      triggerDetail: promotedTriggerDetail,
      status: "queued",
      wakeupRequestId: request.id,
      contextSnapshot: {
        ...promotedContextSnapshot,
        dispatchGeneration: await resolveNextDispatchGeneration(tx as unknown as Db, {
          agentId: agent.id,
          issueId: promotedIssueId,
          taskKey: promotedTaskKey,
        }),
      },
      sessionIdBefore: sessionBefore,
      ...(resubmissionExecutionEpoch !== null ? { executionEpoch: resubmissionExecutionEpoch } : {}),
    })
    .returning()
    .then((rows) => rows[0]);

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

  if (promotedIssue) {
    const issueStartStatuses = (isWorkflowStepResume || isPlanReworkPromotion)

      ? [...ISSUE_RUN_START_STATUSES, "done"]
      : ISSUE_RUN_START_STATUSES;
    const startedIssue = await tx
      .update(issues)
      .set({
        executionRunId: newRun.id,
        checkoutRunId: newRun.id,
        status: "in_progress",
        startedAt: now,
        completedAt: null,
        cancelledAt: null,
        executionAgentNameKey: normalizeAgentNameKey(agent.name),
        executionLockedAt: now,
        updatedAt: now,
      })
      .where(and(eq(issues.id, promotedIssue.id), inArray(issues.status, issueStartStatuses)))
      .returning({ id: issues.id })
      .then((rows) => rows[0] ?? null);

    if (startedIssue) {
      await tx.insert(activityLog).values({
        companyId: promotedIssue.companyId,
        actorType: "system",
        actorId: "heartbeat",
        action: "issue.execution_started",
        entityType: "issue",
        entityId: promotedIssue.id,
        agentId: agent.id,
        runId: newRun.id,
        details: {
          previousStatus: promotedIssue.status,
          nextStatus: "in_progress",
          reason: "queued_wakeup_promoted",
        },
      });
    }
  }

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
  const newRun = await tx
    .insert(heartbeatRuns)
    .values({
      companyId: deferredAgent.companyId,
      agentId: deferredAgent.id,
      issueId: issue.id,
      invocationSource: promotedSource,
      triggerDetail: promotedTriggerDetail,
      status: "queued",
      wakeupRequestId: deferred.id,
      contextSnapshot: {
        ...promotedContextSnapshot,
        dispatchGeneration: await resolveNextDispatchGeneration(tx as unknown as Db, {
          agentId: deferredAgent.id,
          issueId: issue.id,
          taskKey: promotedTaskKey,
        }),
      },
      sessionIdBefore: sessionBefore,
    })
    .returning()
    .then((rows) => rows[0]);

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
