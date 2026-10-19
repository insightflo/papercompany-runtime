// 기존 입장 검사와 후보 선택을 보존한다. 실행 시작과 이벤트 발행은 호출자 책임이다.
import { and, eq, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, heartbeatRuns, issues, workflowTransitionEvents, withTxTimeout, type Db } from "@paperclipai/db";
import { parseObject } from "../adapters/utils.js";
import { isQaCorrectionRootOwnerRequired } from "./issue-assignment-wakeup.js";
import { readQaCorrectionWakeRef } from "./work-products/qa-correction-producer-attempt.js";
import type { CorrectionDeliveryResult } from "./workflow/control-flow/qa-correction-delivery-root.js";
import { logger } from "../middleware/logger.js";
import type { budgetService } from "./budgets.js";
import { readNonEmptyString } from "./heartbeat-run-context.js";
import { assertHeartbeatRecoveryAdmission } from "./heartbeat-recovery-guard.js";
import { lifecycleInFlightClause } from "./heartbeat-finalization/lifecycle-active.js";
import { missionDedupExemptOversightReviewClause } from "./heartbeat-mission-dedup.js";
import { shouldNoOpOversightWakeup } from "./missions/recovery-ownership-guard.js";
import { assertMissionRuntimeAcceptsWork } from "./missions/mission-runtime-manager.js";
import type { FollowupContextInput, FollowupTx, HeartbeatFollowupPromotionDeps, QueuedWakeupPromotionInput } from "./heartbeat-followup-promotion.js";
import { selectQueuedWakeupRequestIds } from "./quality/native-wake.js";
export { selectDeferredWakeupRequest } from "./quality/native-wake.js";
/** Only the identical unconditional rejection update; callers keep their own continue/return. */
export async function failFollowupWake(tx: FollowupTx, id: string, error: string) {
  await tx.update(agentWakeupRequests).set({
    status: "failed", finishedAt: new Date(), error, updatedAt: new Date(),
  }).where(eq(agentWakeupRequests.id, id));
  return null;
}
type AgentRow = typeof agents.$inferSelect;
type RunRow = typeof heartbeatRuns.$inferSelect;
export type HeartbeatFollowupQueueDeps = {
  db: Db;
  deferredWakeContextKey: string;
  promotedRejectIssueStatuses: ReadonlySet<string>;
  enrichWakeContextSnapshot: HeartbeatFollowupPromotionDeps["enrichWakeContextSnapshot"];
  isWorkflowStepResumeWake: (input: { requestKind?: unknown; reason?: unknown; payload?: unknown; contextSnapshot?: unknown }) => boolean;
  getInvocationBlock: ReturnType<typeof budgetService>["getInvocationBlock"];
  promote: (tx: FollowupTx, input: QueuedWakeupPromotionInput) => Promise<RunRow>;
  deliverCorrection?: (candidate: { wakeupRequestId: string }, profile: "public_callback") =>
    Promise<{ kind: CorrectionDeliveryResult["kind"] | "nested_pending"; run: RunRow | null }>;
};
export async function promoteQueuedWakeupRequestsForAgent(
  deps: HeartbeatFollowupQueueDeps,
  agent: AgentRow,
  limit: number,
) {
  const { db } = deps;
  if (limit <= 0) return [];
  const pendingRequests = await selectQueuedWakeupRequestIds(db, agent, limit);
  const promotedRuns: Array<typeof heartbeatRuns.$inferSelect> = [];
  for (const pendingRequest of pendingRequests) {
    if (promotedRuns.length >= limit) break;
    const promoted = await promoteQueuedWakeupRequest(deps, agent, pendingRequest.id);
    if (promoted) promotedRuns.push(promoted);
  }
  return promotedRuns;
}
async function promoteQueuedWakeupRequest(
  deps: HeartbeatFollowupQueueDeps,
  agent: AgentRow,
  wakeupRequestId: string,
) {
  const {
    db, deferredWakeContextKey: DEFERRED_WAKE_CONTEXT_KEY,
    promotedRejectIssueStatuses: PROMOTED_REJECT_ISSUE_STATUSES,
    enrichWakeContextSnapshot, isWorkflowStepResumeWake, getInvocationBlock,
  } = deps;
  const [candidate] = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, wakeupRequestId), eq(agentWakeupRequests.companyId, agent.companyId),
    eq(agentWakeupRequests.agentId, agent.id),
  ));
  if (candidate && readQaCorrectionWakeRef(candidate)) {
    if (!deps.deliverCorrection) throw new Error("qa_correction_delivery_connector_required");
    const result = await deps.deliverCorrection({ wakeupRequestId }, "public_callback");
    return result.kind === "new_delivery" ? result.run : null;
  }
  return withTxTimeout(db, async (tx) => {
    const [observed] = await tx.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id, wakeupRequestId), eq(agentWakeupRequests.companyId, agent.companyId)));
    if (!observed) return null;
    try {
      await assertHeartbeatRecoveryAdmission(tx as unknown as Db, { ...observed, contextSnapshot: parseObject(observed.payload)[DEFERRED_WAKE_CONTEXT_KEY] });
    } catch (err) {
      if (isQaCorrectionRootOwnerRequired(err)) throw err;
      await tx.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date(), error: err instanceof Error ? err.message : "Recovery admission refused", updatedAt: new Date() })
        .where(and(eq(agentWakeupRequests.id, wakeupRequestId), eq(agentWakeupRequests.status, "queued"), sql`${agentWakeupRequests.runId} is null`));
      return null;
    }
    await tx.execute(sql`select id from agent_wakeup_requests where id = ${wakeupRequestId} for update`);
    const request = await tx
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.id, wakeupRequestId),
        eq(agentWakeupRequests.companyId, agent.companyId),
        eq(agentWakeupRequests.agentId, agent.id),
        eq(agentWakeupRequests.status, "queued"),
        sql`${agentWakeupRequests.runId} is null`,
      ))
      .then((rows) => rows[0] ?? null);
    if (!request) return null;
    // [거절] agent 가 실행 불가 상태면 run 도 만들지 않고 request 를 terminal-fail.
    if (agent.status === "terminated" || agent.status === "paused" || agent.status === "pending_approval") {
      return failFollowupWake(tx, request.id, `Queued wakeup rejected: agent not runnable (status=${agent.status})`);
    }
    const requestPayload = parseObject(request.payload);
    const queuedContext = parseObject(requestPayload[DEFERRED_WAKE_CONTEXT_KEY]);
    const promotedPayload = { ...requestPayload };
    delete promotedPayload[DEFERRED_WAKE_CONTEXT_KEY];
    const promotedReason = readNonEmptyString(request.reason);
    const promotedSource =
      (readNonEmptyString(request.source) as FollowupContextInput["source"]) ?? "automation";
    const promotedTriggerDetail =
      (readNonEmptyString(request.triggerDetail) as FollowupContextInput["triggerDetail"]) ?? null;
    const {
      contextSnapshot: promotedContextSnapshot,
      issueIdFromPayload,
      taskKey: promotedTaskKey,
    } = enrichWakeContextSnapshot({
      contextSnapshot: queuedContext,
      reason: promotedReason,
      source: promotedSource,
      triggerDetail: promotedTriggerDetail,
      payload: promotedPayload,
    });
    const isWorkflowStepResume = isWorkflowStepResumeWake({
      requestKind: request.requestKind,
      reason: request.reason,
      payload: promotedPayload,
      contextSnapshot: promotedContextSnapshot,
    });
    const promotedIssueId = readNonEmptyString(promotedContextSnapshot.issueId) ?? issueIdFromPayload;
    const promotedIssue = promotedIssueId
      ? await tx
        .select({
          id: issues.id,
          companyId: issues.companyId,
          projectId: issues.projectId,
          missionId: issues.missionId,
          originKind: issues.originKind,
          status: issues.status,
        })
        .from(issues)
        .where(and(eq(issues.id, promotedIssueId), eq(issues.companyId, agent.companyId)))
        .then((rows) => rows[0] ?? null)
      : null;
    const isPlanReworkPromotion =
      promotedReason === "mission_owner_plan_rework_requested" &&
      promotedIssue?.originKind === "mission_main_executor_plan";
    if (promotedIssueId && !promotedIssue) {
      return failFollowupWake(tx, request.id, "Queued wakeup could not be promoted: issue not found");
    }
    // [거절] issue 가 이미 terminal 이면 재실행 무의미 → request terminal-fail.
    if (
      promotedIssue &&
      PROMOTED_REJECT_ISSUE_STATUSES.has(promotedIssue.status) &&
      !(isWorkflowStepResume && promotedIssue.status === "done") &&
      !(isPlanReworkPromotion && promotedIssue.status === "done")
    ) {
      return failFollowupWake(tx, request.id, `Queued wakeup rejected: issue terminal (status=${promotedIssue.status})`);
    }
    // [P4 consume-side oversight no-op] mission_owner_retry_source_issue(twin) wakeup 이
    //   source/owner action 의 QA recovery chain 이 live/stalled 면 no-op(guard 이전 큐 stale/race 회수, req 2).
    //   producer 대상이어도 payload.ownerActionIssueId → owner action origin(QA gate) chain 확인.
    if (
      promotedIssue?.missionId &&
      (promotedReason === "mission_owner_retry_source_issue" || promotedReason === "mission_owner_decision_retry_source_issue")
    ) {
      const oversightNoOp = await shouldNoOpOversightWakeup(tx as unknown as Db, {
        companyId: agent.companyId,
        missionId: promotedIssue.missionId,
        request: { id: request.id, reason: promotedReason, payload: promotedPayload },
        promotedIssue: { id: promotedIssue.id, status: promotedIssue.status },
      });
      if (oversightNoOp.noOp) {
        // 의도적 supersede → status=failed ❌(stale/deadlock logic 이 재실패로 해석 위험).
        // terminal non-failure(completed) + 구조화 queue_oversight_noop transition event(codex P4 blocker).
        await tx
          .update(agentWakeupRequests)
          .set({ status: "completed", finishedAt: new Date(), error: null, updatedAt: new Date() })
          .where(eq(agentWakeupRequests.id, request.id));
        await tx.insert(workflowTransitionEvents).values({
          companyId: agent.companyId,
          missionId: promotedIssue.missionId,
          issueId: promotedIssue.id,
          wakeupRequestId: request.id,
          eventType: "queue_oversight_noop",
          layer: "recovery_ownership",
          reason: oversightNoOp.reason,
          reasonCode: "qa_recovery_oversight_noop",
          idempotencyKey: `queue-oversight-noop:${request.id}`,
          payload: {
            originalRequestId: request.id,
            ownerActionIssueId: oversightNoOp.ownerActionIssueId,
            qaSignal: oversightNoOp.qaSignal,
            reason: oversightNoOp.reason,
          },
        }).onConflictDoNothing();
        return null;
      }
    }
    const missionIdForWake =
      readNonEmptyString(promotedContextSnapshot.missionId) ??
      readNonEmptyString(promotedPayload.missionId) ??
      promotedIssue?.missionId ??
      null;
    if (missionIdForWake) {
      const inFlightClause = await lifecycleInFlightClause(tx as unknown as Parameters<typeof lifecycleInFlightClause>[0]);
      const existingMissionRun = await tx
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.agentId, agent.id),
          inFlightClause,
          sql`heartbeat_runs.context_snapshot ->> 'missionId' = ${missionIdForWake}`,
          // [oversight exemption] 정기 점검(리뷰) 실행은 같은 미션 단계 실행의 승격을 막지 않는다.
          missionDedupExemptOversightReviewClause,
        ))
        .limit(1);
      if (existingMissionRun.length > 0) {
        // [B3] Previously this branch dropped the promotion silently: the request stayed
        // `queued` with runId=NULL and no state change, so it was invisible until B1's
        // stale-queued reap eventually fired. Record each block: bump coalescedCount (durable,
        // tx-scoped counter) and warn so a request stuck behind a long-running same-mission
        // run is observable long before it goes stale.
        await tx
          .update(agentWakeupRequests)
          .set({ coalescedCount: sql`${agentWakeupRequests.coalescedCount} + 1`, updatedAt: new Date() })
          .where(eq(agentWakeupRequests.id, request.id));
        logger.warn(
          { agentId: agent.id, wakeupRequestId: request.id, missionId: missionIdForWake, blockingRunId: existingMissionRun[0]?.id },
          "queue_promotion_blocked_by_mission_dedup",
        );
        return null;
      }
      try {
        await assertMissionRuntimeAcceptsWork(tx as unknown as Db, {
          companyId: agent.companyId,
          missionId: missionIdForWake,
        });
      } catch (err) {
        return failFollowupWake(tx, request.id, err instanceof Error ? err.message : "Queued wakeup could not be promoted: mission is terminal");
      }
    }
    const budgetBlock = await getInvocationBlock(agent.companyId, agent.id, {
      issueId: promotedIssue?.id ?? promotedIssueId,
      projectId: promotedIssue?.projectId ?? readNonEmptyString(promotedContextSnapshot.projectId),
    });
    if (budgetBlock) {
      return failFollowupWake(tx, request.id, budgetBlock.reason);
    }
    return deps.promote(tx, {
      agent, request, promotedContextSnapshot, promotedSource, promotedTriggerDetail,
      promotedIssueId, promotedTaskKey, missionIdForWake, promotedIssue,
      isWorkflowStepResume, isPlanReworkPromotion,
    });
  });
}
