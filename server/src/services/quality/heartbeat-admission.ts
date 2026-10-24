// server/src/services/quality/heartbeat-admission.ts
//
// [purpose] T4 공통 admission 의 quality 확장과 heartbeat 대기열 helper.
//   - queuePausedAgentWakeupRequest: heartbeat.ts 에서 추출한 paused-agent 대기열
//     삽입(원래 queuePausedAgentWakeup 클로저). 행 병합은 quality 키와 충돌하지 않는다.
//   - findExistingQualityWakeRow: admission tx 시작점의 같은 키 재전달 멱등 조회.
//   - buildQualityWakeAcceptancePatch: admission tx 안에서 수락 원문(qualityAcceptance
//     JSON)을 만든다. intentKey/inputHash 는 조치 행에서 읽는다(키만으로 날조하지 않는다).
//   - mergeableWakeupKeyCondition: generic/manual/resume/reconcile 병합 조회가 저장된
//     quality 행을 삼키지 않게 하는 SQL 조건. 정확히 같은 키만 병합 허용.
// [boundary] 이 파일은 깨우기·실행을 시작하지 않는다. admission 트랜잭션 안에서
//   호출되는 함수들이다(§3.3: 커밋 전 이벤트·깨우기 금지 준수).

import { and, asc, eq, sql } from "drizzle-orm";
import { conflict } from "../../errors.js";
import { QA_CORRECTION_WAKE_PREFIX } from "../work-products/qa-correction-producer-attempt.js";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, qualityActions } from "@paperclipai/db";
import { insertWorkflowWakeRequest } from "../heartbeat-workflow-wake.js";
import { preserveWorkflowAttemptProof } from "../heartbeat-finalization/workflow-attempt-proof.js";
export {
  nextPlanQaResubmissionExecutionEpoch,
  planQaResubmissionPromotionAcceptancePatch,
} from "./plan-qa-wake-admission.js";
import {
  buildPlanQaResubmissionAcceptancePatch,
} from "./plan-qa-wake-admission.js";
import {
  findBoundedWakeRowByExactKey, findQualityWakeRowByExactKey, isBoundedExecutionWakeKey, isQaCorrectionWakeKey,
  isQualityWakeKey, parsePlanQaResubmissionWakeKey, parseQualityWakeKey, unboundedExecutionWakeKeyCondition,
  type QualityAttemptRow,
} from "./native-wake.js";

export type HeartbeatQueueEventRecorder = (
  db: Db,
  input: Parameters<typeof import("../heartbeat.js").recordHeartbeatQueueTransitionEvent>[1],
) => Promise<void>;

/**
 * [heartbeat.ts 추출] enqueueWakeup 의 skip 원문 기록(원래 writeSkippedRequest 클로저).
 * 원래 의미를 유지한다: status=skipped 행 + queue_rejected 전이 이벤트 미러. 순수 이동이며
 * 호출부(heartbeat.ts)가 typed 컬럼 값을 계산해 전달한다.
 */
export async function writeSkippedWakeupRequest(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    source: string;
    triggerDetail: string | null;
    skipReason: string;
    payload: Record<string, unknown> | null;
    requestedByActorType: "user" | "agent" | "system" | null;
    requestedByActorId: string | null;
    idempotencyKey: string | null;
    requestKind: string | null;
    issueId: string | null;
    missionId: string | null;
    workflowRunId: string | null;
    workflowStepRunId: string | null;
    recordEvent: HeartbeatQueueEventRecorder;
  },
): Promise<void> {
  await db.insert(agentWakeupRequests).values({
    companyId: input.companyId,
    agentId: input.agentId,
    source: input.source,
    triggerDetail: input.triggerDetail,
    reason: input.skipReason,
    payload: input.payload,
    status: "skipped",
    requestedByActorType: input.requestedByActorType,
    requestedByActorId: input.requestedByActorId,
    idempotencyKey: input.idempotencyKey,
    finishedAt: new Date(),
    requestKind: input.requestKind,
    issueId: input.issueId,
    missionId: input.missionId,
    workflowRunId: input.workflowRunId,
    workflowStepRunId: input.workflowStepRunId,
  });
  await input.recordEvent(db, {
    companyId: input.companyId,
    missionId: input.missionId,
    issueId: input.issueId,
    workflowRunId: input.workflowRunId,
    workflowStepRunId: input.workflowStepRunId,
    eventType: "queue_rejected",
    layer: "queue",
    decision: "rejected",
    reason: input.skipReason,
    reasonCode: input.skipReason,
    idempotencyKey: `queue-rejected:${input.companyId}:${input.agentId}:${input.skipReason}:${input.issueId ?? "no-issue"}`,
  });
}

export type TypedQueueColumns = {
  requestKind: string | null;
  issueId: string | null;
  missionId: string | null;
  workflowRunId: string | null;
  workflowStepRunId: string | null;
  workflowExecutionGeneration?: number;
};

/**
 * [heartbeat.ts 추출] paused agent 용 대기 wakeup 삽입. 원래 enqueueWakeup 안의
 * queuePausedAgentWakeup 클로저와 동일한 의미를 유지하고, 대기 행 병합 조회에
 * quality-safe 조건을 추가한다(quality 행은 정확히 같은 키일 때만 병합).
 */
export async function queuePausedAgentWakeupRequest(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    source: string;
    triggerDetail: string | null;
    reason: string | null;
    payload: Record<string, unknown> | null;
    typedQueueColumns: TypedQueueColumns;
    requestedByActorType: "user" | "agent" | "system" | null;
    requestedByActorId: string | null;
    idempotencyKey: string | null;
    missionIdForWake: string | null;
    contextSnapshot?: Record<string, unknown>;
    contextSnapshotKey?: string;
    recordEvent: HeartbeatQueueEventRecorder;
  },
): Promise<void> {
  // 이 helper는 현재성·잠금 권한을 소유하지 않는다. 교정은 root 입장 경계에서만 작성한다.
  if (isQaCorrectionWakeKey(input.idempotencyKey) || Object.hasOwn(input.payload ?? {}, "qaCorrectionFollowup")) {
    throw conflict("qa_correction_root_admission_required");
  }
  const storedPayload = input.contextSnapshot && input.contextSnapshotKey
    ? { ...(input.payload ?? {}), [input.contextSnapshotKey]: input.contextSnapshot } : input.payload;
  let wakeupRequestId: string | null = null;
  let recordWaiting = true;
  if (isBoundedExecutionWakeKey(input.idempotencyKey)) {
    const existing = await findBoundedWakeRowByExactKey(db, { companyId: input.companyId,
      agentId: input.agentId, issueId: input.typedQueueColumns.issueId, idempotencyKey: input.idempotencyKey });
    if (existing && (existing.agentId !== input.agentId || existing.issueId !== input.typedQueueColumns.issueId
      || existing.idempotencyKey !== input.idempotencyKey)) throw conflict("bounded_wakeup_identity_mismatch");
    wakeupRequestId = existing?.id ?? null;
    recordWaiting = !existing;
  } else if (input.typedQueueColumns.issueId) {
    const existingQueuedWake = await db
      .select({ id: agentWakeupRequests.id, coalescedCount: agentWakeupRequests.coalescedCount, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.agentId, input.agentId),
        eq(agentWakeupRequests.status, "queued"),
        eq(agentWakeupRequests.issueId, input.typedQueueColumns.issueId),
        sql`${agentWakeupRequests.runId} is null`,
        mergeableWakeupKeyCondition(input.idempotencyKey),
      ))
      .orderBy(asc(agentWakeupRequests.requestedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existingQueuedWake) {
      await db
        .update(agentWakeupRequests)
        .set({
          payload: preserveWorkflowAttemptProof(existingQueuedWake.payload, storedPayload),
          coalescedCount: (existingQueuedWake.coalescedCount ?? 0) + 1,
          updatedAt: new Date(),
        })
        .where(eq(agentWakeupRequests.id, existingQueuedWake.id));
      wakeupRequestId = existingQueuedWake.id;
    }
  }

  if (!wakeupRequestId) {
    const inserted = await insertWorkflowWakeRequest(db, {
        companyId: input.companyId,
        agentId: input.agentId,
        source: input.source,
        triggerDetail: input.triggerDetail,
        reason: input.reason,
        payload: storedPayload,
        ...input.typedQueueColumns,
        status: "queued",
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
        idempotencyKey: input.idempotencyKey,
      }).then((rows) => rows[0] ?? null);
    wakeupRequestId = inserted?.id ?? null;
  }

  if (recordWaiting) await input.recordEvent(db, {
    companyId: input.companyId,
    missionId: input.missionIdForWake,
    issueId: input.typedQueueColumns.issueId,
    wakeupRequestId,
    workflowRunId: input.typedQueueColumns.workflowRunId,
    workflowStepRunId: input.typedQueueColumns.workflowStepRunId,
    eventType: "queue_waiting",
    layer: "queue",
    decision: "waiting",
    reason: "agent.paused",
    reasonCode: "agent.paused",
    idempotencyKey: `queue-waiting:${input.companyId}:${input.agentId}:agent.paused:${input.typedQueueColumns.issueId ?? wakeupRequestId ?? "no-issue"}`,
  });
}

/**
 * 교정 요청은 같은 키도 일반 payload 병합에서 제외한다. 정확한 재사용은 root 입장 책임이다.
 * 저장된 교정 표시도 제외하며, 비교정 quality·PLAN-QA·generic의 기존 후보 조건은 유지한다.
 */
export function mergeableWakeupKeyCondition(incomingKey: string | null | undefined) {
  if (isBoundedExecutionWakeKey(incomingKey)) return sql`false`;
  return sql`(
    ${unboundedExecutionWakeKeyCondition()}
    and not (coalesce(${agentWakeupRequests.payload}, '{}'::jsonb) ? 'qaCorrectionFollowup')
  )`;
}

/** admission tx 시작점에서 같은 bounded 실행 키의 기존 행을 찾는다(멱등 재전달). */
export async function findExistingQualityWakeRow(
  db: Pick<Db, "select">,
  input: { companyId: string; idempotencyKey: string | null },
): Promise<QualityAttemptRow | null> {
  if (!isBoundedExecutionWakeKey(input.idempotencyKey)) return null;
  return findQualityWakeRowByExactKey(db as Db, { companyId: input.companyId, idempotencyKey: input.idempotencyKey! });
}

/**
 * admission tx 안에서 수락 원문을 만든다. §3.1 qualityAcceptance: intentKey, exact input
 * hash, issue/step/generation/agent, attempt, acceptedAt, heartbeatRunId. 조치 행에서
 * intentKey/inputHash 를 읽지 못하면 acceptance 를 기록하지 않는다(날조 금지).
 */
export async function buildQualityWakeAcceptancePatch(
  db: Pick<Db, "select">,
  input: {
    companyId: string;
    agentId: string;
    issueId: string | null;
    workflowRunId: string | null;
    idempotencyKey: string | null;
    runId: string;
    acceptedAt: Date;
  },
): Promise<Record<string, unknown> | null> {
  // [T8 bounded resubmission] PLAN-QA 재제출 키: 검토 원장의 예약 dispatch 기록으로만 수락 원문 작성.
  const planQaPatch = await buildPlanQaResubmissionAcceptancePatch(db, input);
  if (planQaPatch) return planQaPatch;
  const parsed = parseQualityWakeKey(input.idempotencyKey);
  if (!parsed) return null;
  const [action] = await db.select({ intentKey: qualityActions.intentKey, target: qualityActions.target })
    .from(qualityActions)
    .where(and(eq(qualityActions.companyId, input.companyId), eq(qualityActions.id, parsed.actionId)))
    .limit(1);
  if (!action) return null;
  const target = action.target as Record<string, unknown> | null;
  const inputHash = target?.kind === "current_output"
    ? ((target.source as Record<string, unknown> | null)?.inputHash as string | undefined) ?? null
    : (target?.inputHash as string | undefined) ?? null;
  return {
    qualityAcceptance: {
      intentKey: action.intentKey,
      inputHash,
      issueId: input.issueId,
      stepRunId: parsed.stepRunId,
      workflowRunId: input.workflowRunId,
      generation: parsed.generation,
      agentId: input.agentId,
      attempt: parsed.attempt,
      acceptedAt: input.acceptedAt.toISOString(),
      heartbeatRunId: input.runId,
    },
  };
}
