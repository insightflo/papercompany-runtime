// server/src/services/workflow/control-flow/qa-remediation-completion.ts
//
// [purpose] Stage B2c1 — 검증·게시된 qa_remediation_prepared(v2) 예약의 내구 완료/워크 API.
//   완료 증거(versioned·schema 검증)와 "정확히 수락된 wake 신원"을 모든 wake 와 함께
//   호출자 트랜잭션 안에 원자적으로 남긴다(review C1/C6).
//
// [correction 4 — 2026-10-30 승인 1회(추가 보정, 총 4/4)] 완전 검증기 나머지 구멍:
//   payload scope(company/mission/run) 대조, files·verdict 중복 불가 정확 집합 커버(중복이 빠진 원천을
//   대체 불가), prior-v2 재사용/승계 공용 wake binding 검증기(원본 저장 proof·정확 qa 시도 tuple·
//   현재 의도 대상 agent — 승계는 기록 시점 agent 만), readWorkflowAttemptProof 기반 날조 proof 거부.
//
// [correction 3 — /tmp/b2c-defect-disposition-2317.md findings 1–3, 2026-10-30 승인 1회]
//   - legacy refire wake 인식 제거: legacy 행(enqueueWakeup 산출)은 verdict/retry/iteration/attempt-proof 를
//     구조적으로 증명하지 못한다. 과거 코드는 현재 reservation 의 verdict id 를 영수증에 끼워 넣는
//     갈무리였다(fabricated authority). 이제 reconcile 이 IO 이전에 legacy-key 행 존재(임의 status,
//     terminal·payload-only 포함)를 hold 한다 — 인식/차용/중복 v2 발행 모두 없다.
//   - prior v2 재사용은 전 행 신원 binding(company/issue/mission/run/stepRun/generation/requestKind/
//     payload 포인터/status) 대조 후에만 허용된다. 불일치·중복은 typed error(차용 금지).
//   - 완료 증거 검증은 신규 insert 와 기존 행 승계 모두 동일한 완전 검증기를 통과한다: 이벤트 행 외부열
//     + payload producer/QA tuple + verdict 원천 집합 + success-only 정확 파일 커버 + 실제 wake 행 binding.
//   - created:false 재진입은 pending v2 wake 를 실제 root notification mapping(registerQaCorrectionRootDrain)에
//     등록하고 그 mapping 을 명시적으로 반환한다 — drainReplacementRootNotifications 주체가 놓치지 않는다.
//
// [authority] wake 는 오직 insertWorkflowWakeRequest(heartbeat-workflow-wake — attempt proof +
//   linkage 검증)로 만든다(C6). C02 validateAndRegisterQaCorrectionRootDrain 은 C02
//   CorrectionDeliveryInput(issued correction receipt)만 받으므로 legacy v2 에 대해 호출하지 않는다;
//   기존 registerQaCorrectionRootDrain(agentId) → drainReplacementRootNotifications 의 resumeQueuedRuns 가
//   커밋된 queued wake 를 승격한다. after-commit drain 은 호출자(main wrapper) 소관 — 이 API 는 실제
//   등록된 notifications mapping 내용을 반환할 뿐이다. hold 는 mission 완료가 아니다.
//
// [safety] fail-closed: root notification mapping 미등록·caller tx 아님·행/신원 불일치는 typed error —
//   producer fallback 이나 wake 재발행으로 축소되지 않는다. DB 오류는 그대로 전파한다(rollback →
//   preparation 은 별도 커밋이라 보존, reentry 는 after bytes 를 인식해 completion 만 재시도).

import { randomUUID } from "node:crypto";
import { and, eq, inArray, is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import {
  agentWakeupRequests, heartbeatRuns, issues, workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import type { QaRemediationFilePublication } from "./qa-remediation-publication.js";
import { QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3, parseQaRemediationPreparation,
  type QaRemediationEventRow, type QaRemediationPreparation } from "./qa-remediation-preparation-contract.js";
import { qaRemediationQualityBindingHash } from "./qa-remediation-quality-binding.js";
import {
  QA_REMEDIATION_COMPLETION_SCHEMA_VERSION, QA_REMEDIATION_COMPLETION_SCHEMA_VERSION_V3,
  qaRemediationCompletionKey, qaRemediationRefireV2WakeKey, validatePendingQaRemediationRefireWake,
  qaRemediationQualityUseScope, qaRemediationSuccessfulPublicationFiles, validateQaRemediationCompletionEvidence,
  type QaRemediationCompletion, type QaRemediationCompletionWake,
} from "./qa-remediation-completion-evidence.js";
export {
  QA_REMEDIATION_COMPLETION_SCHEMA_VERSION, QA_REMEDIATION_COMPLETION_SCHEMA_VERSION_V3,
  parseQaRemediationCompletion, qaRemediationCompletionKey, qaRemediationRefireV2WakeKey,
  qaRemediationCompletionSchema, qaRemediationCompletionWakeSchema,
  qaRemediationQualityCompletionSchema, qaRemediationWorkflowCompletionSchema,
} from "./qa-remediation-completion-evidence.js";
export type { QaRemediationCompletion, QaRemediationCompletionWake } from "./qa-remediation-completion-evidence.js";
import { insertWorkflowWakeRequest } from "../../heartbeat-workflow-wake.js";
import { linkEvidence } from "../../quality/evidence-store.js";
import type { QualityTx } from "../../quality/contract.js";
import {
  currentReplacementRootNotifications, registerQaCorrectionRootDrain,
} from "../../issue-assignment-wakeup.js";

export const QA_REMEDIATION_COMPLETION_EVENT_TYPE = "qa_remediation_completed";

/** legacy wake key — qa-remediation.ts createQaRemediationRefire 의 기존 리터럴과 동일 형식.
 *  인식/차용에는 쓰지 않는다: reconcile 의 pre-IO ambiguity hold 만 이 키의 행 존재를 본다. */
export const legacyQaRemediationRefireWakeKey = (workflowRunId: string, qaStepRunId: string): string =>
  `qa-remediation-refire:${workflowRunId}:${qaStepRunId}`;

export class QaRemediationCompletionError extends Error {
  constructor(readonly reason: string) { super(`qa_remediation_completion_${reason}`); }
}

export interface QaRemediationCompletionResult {
  readonly completionEventId: string;
  readonly completion: QaRemediationCompletion;
  readonly qualityUseEvidenceRefId: string | null;
  /** false = 커밋된 정확 completion 을 재진입에서 승계(새 효과/wake 없음; pending wake 는 실제 root mapping 등록). */
  readonly created: boolean;
  /** 실제 등록된 root notification mapping 내용 — after-commit drain 은 호출자(main wrapper) 소관. */
  readonly notifications: { readonly agentIds: readonly string[]; readonly wakeupRequestIds: readonly string[] };
}

const PENDING_WAKE_STATUSES = ["queued", "deferred_issue_execution"] as const;
/** 커밋된 completion 승계 — 완전 검증기 통과 후 pending v2 wake 를 실제 root mapping 에 등록한다. */
async function acceptValidatedCompletion(db: Db, row: QaRemediationEventRow, p: QaRemediationPreparation):
Promise<QaRemediationCompletionResult> {
  const notifications = currentReplacementRootNotifications(db);
  if (!notifications) throw new QaRemediationCompletionError("root_drain_unregistered");
  const validated = await validateQaRemediationCompletionEvidence(db, row, p);
  if (!validated.ok) throw new QaRemediationCompletionError(validated.reason);
  const completion = validated.completion;
  // pending v2 wake 만 실제 drain 등록 — 이미 claimed/terminal 이면 실행 주체가 따로 있다.
  const pendingIds = completion.wakes.filter((w) => PENDING_WAKE_STATUSES.includes(w.statusAtCommit as (typeof PENDING_WAKE_STATUSES)[number]))
    .map((w) => w.wakeupRequestId);
  const agentIds = new Set<string>();
  if (pendingIds.length > 0) {
    const rows = await db.select({ id: agentWakeupRequests.id, agentId: agentWakeupRequests.agentId, status: agentWakeupRequests.status })
      .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, p.companyId), inArray(agentWakeupRequests.id, pendingIds)));
    for (const id of pendingIds) {
      const rowOf = rows.find((r) => r.id === id);
      // 행이 검증기를 지났지만 지금 pending 이 아니게 됐다면(claimed/finished) drain 등록은 생략한다.
      if (!rowOf || !PENDING_WAKE_STATUSES.includes(rowOf.status as (typeof PENDING_WAKE_STATUSES)[number])) continue;
      registerQaCorrectionRootDrain(db, rowOf.agentId);
      agentIds.add(rowOf.agentId);
    }
  }
  return { completionEventId: row.id, completion, qualityUseEvidenceRefId: completion.schemaVersion === QA_REMEDIATION_COMPLETION_SCHEMA_VERSION_V3 ? completion.qualityUseEvidenceRefId : null, created: false,
    notifications: { agentIds: [...agentIds].sort(), wakeupRequestIds: pendingIds } };
}

/** Read-only committed lookup. It validates the exact persisted receipt and registers only proven pending wakes. */
export async function readCommittedQaRemediationCompletion(db: Db, preparation: QaRemediationPreparation): Promise<QaRemediationCompletionResult | null> {
  if (!is(db, PgTransaction)) throw new QaRemediationCompletionError("caller_transaction_required");
  if (!currentReplacementRootNotifications(db)) throw new QaRemediationCompletionError("root_drain_unregistered");
  const p = parseQaRemediationPreparation(preparation);
  const rows = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, p.companyId),
    eq(workflowTransitionEvents.idempotencyKey, qaRemediationCompletionKey(p)),
    eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)));
  if (rows.length > 1) throw new QaRemediationCompletionError("unresolved_conflict");
  return rows.length === 0 ? null : acceptValidatedCompletion(db, rows[0]!, p);
}

/**
 * [caller-tx only] Store exact use evidence, completion, and refire wakes atomically after successful publication.
 * Existing committed completion is checked first because linkEvidence intentionally creates a new receipt each call.
 */
export async function completeQaRemediationReservation(db: Db, input: {
  readonly preparation: QaRemediationPreparation;
  readonly publication: { readonly files: readonly QaRemediationFilePublication[] };
}): Promise<QaRemediationCompletionResult> {
  if (!is(db, PgTransaction)) throw new QaRemediationCompletionError("caller_transaction_required");
  const p = parseQaRemediationPreparation(input.preparation);
  const committed = await readCommittedQaRemediationCompletion(db, p);
  if (committed) return committed;
  const notifications = currentReplacementRootNotifications(db);
  if (!notifications) throw new QaRemediationCompletionError("root_drain_unregistered");

  let qualityUseEvidenceRefId: string | null = null;
  let qualityBindingHash: string | null = null;
  if (p.schemaVersion === QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3) {
    if (!qaRemediationSuccessfulPublicationFiles(p, input.publication.files)) {
      throw new QaRemediationCompletionError("file_coverage_mismatch");
    }
    const binding = p.qualityBinding;
    const linked = await linkEvidence(db as QualityTx, {
      companyId: p.companyId, reviewItemId: binding.reviewItemId, source: binding.source,
      scope: qaRemediationQualityUseScope(p), kind: "use", uploaded: binding.uploadedEvidence,
      expiresAt: binding.expiresAt, issuedBy: "quality:current-output",
    });
    qualityUseEvidenceRefId = linked.evidenceRefId;
    qualityBindingHash = qaRemediationQualityBindingHash(binding);
  }

  const wakes: QaRemediationCompletionWake[] = [];
  const registeredAgents = new Set<string>();
  for (const verdict of p.verdicts) {
    // v2 refire wake — 오직 insertWorkflowWakeRequest 로(attempt proof + linkage 검증, C6).
    const idempotencyKey = qaRemediationRefireV2WakeKey(p, verdict.qa.stepRunId, verdict.eventId);
    const [issue] = await db.select().from(issues).where(and(eq(issues.id, verdict.qa.issueId), eq(issues.companyId, p.companyId)));
    const [verdictHeartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, verdict.heartbeatRunId));
    const agentId = issue?.assigneeAgentId ?? verdictHeartbeat?.agentId ?? null;
    if (!issue || !agentId) throw new QaRemediationCompletionError("wake_target_missing");
    const prior = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, p.companyId), eq(agentWakeupRequests.idempotencyKey, idempotencyKey)));
    if (prior.length > 1) throw new QaRemediationCompletionError("ambiguous_v2_wake");
    let row = prior[0] ?? null;
    if (row) {
      const bound = validatePendingQaRemediationRefireWake(row, verdict, p, agentId);
      if (!bound.ok) throw new QaRemediationCompletionError(bound.reason);
    } else {
      const reason = "workflow_step_runnable";
      const contextSnapshot = { issueId: verdict.qa.issueId, taskId: verdict.qa.issueId, taskKey: verdict.qa.issueId,
        missionId: p.missionId, workflowRunId: p.workflowRunId, workflowStepRunId: verdict.qa.stepRunId,
        stepId: verdict.qa.stepId, workflowStepId: verdict.qa.stepId, source: "workflow.resume",
        forceFreshSession: true, wakeReason: reason };
      const [inserted] = await insertWorkflowWakeRequest(db, {
        companyId: p.companyId, agentId, source: "assignment", triggerDetail: "system", reason,
        requestKind: "workflow_resume", requestedByActorType: "system", requestedByActorId: "workflow:qa-remediation",
        issueId: verdict.qa.issueId, missionId: p.missionId, workflowRunId: p.workflowRunId,
        workflowStepRunId: verdict.qa.stepRunId, workflowExecutionGeneration: verdict.qa.executionGeneration,
        status: "queued", idempotencyKey,
        payload: { issueId: verdict.qa.issueId, mutation: "workflow_resume", missionId: p.missionId,
          workflowRunId: p.workflowRunId, workflowStepRunId: verdict.qa.stepRunId, forceFreshSession: true,
          qaRemediationCompletion: { preparationEventId: p.preparationId, sourceVerdictEventId: verdict.eventId },
          _paperclipWakeContext: contextSnapshot },
      });
      row = inserted!;
    }
    wakes.push({ kind: "v2_refire", wakeupRequestId: row.id, idempotencyKey, agentId: row.agentId,
      issueId: verdict.qa.issueId, stepRunId: verdict.qa.stepRunId, stepId: verdict.qa.stepId,
      executionGeneration: verdict.qa.executionGeneration, sourceVerdictEventId: verdict.eventId, statusAtCommit: row.status });
    registerQaCorrectionRootDrain(db, row.agentId);
    registeredAgents.add(row.agentId);
  }

  const completionId = randomUUID();
  const common = {
    completionId, preparationId: p.preparationId, companyId: p.companyId, missionId: p.missionId,
    workflowRunId: p.workflowRunId, dispatchAuthorityVersion: p.dispatchAuthorityVersion, producer: p.producer,
    verdicts: p.verdicts.map((v) => ({ eventId: v.eventId, heartbeatRunId: v.heartbeatRunId, qa: v.qa, remediationsHash: v.remediationsHash })),
    files: input.publication.files.map((f) => ({ file: f.file, status: f.status, detail: f.detail })),
    wakes, completedAt: new Date().toISOString(),
  };
  const completion: QaRemediationCompletion = p.schemaVersion === QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3
    ? { ...common, schemaVersion: QA_REMEDIATION_COMPLETION_SCHEMA_VERSION_V3,
      qualityUseEvidenceRefId: qualityUseEvidenceRefId!, qualityBindingHash: qualityBindingHash! }
    : { ...common, schemaVersion: QA_REMEDIATION_COMPLETION_SCHEMA_VERSION };
  const inserted = await db.insert(workflowTransitionEvents).values({
    id: completion.completionId, companyId: p.companyId, missionId: p.missionId, workflowRunId: p.workflowRunId,
    workflowStepRunId: p.producer.stepRunId, issueId: p.producer.issueId, heartbeatRunId: null,
    executionGeneration: p.producer.executionGeneration, eventType: QA_REMEDIATION_COMPLETION_EVENT_TYPE,
    layer: "workflow_validation", decision: null, verdict: null, reason: "workflow_api", reasonCode: "qa_remediation_complete",
    idempotencyKey: qaRemediationCompletionKey(p), payload: completion,
  }).onConflictDoNothing().returning({ id: workflowTransitionEvents.id });
  if (inserted.length === 0) {
    const reread = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, p.companyId),
      eq(workflowTransitionEvents.idempotencyKey, qaRemediationCompletionKey(p))));
    if (reread.length !== 1) throw new QaRemediationCompletionError("unresolved_conflict");
    // linkEvidence has no idempotency key; a concurrent v3 settlement must roll its use row and wakes back.
    if (p.schemaVersion === QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3) {
      throw new QaRemediationCompletionError("quality_completion_conflict_retry_required");
    }
    return acceptValidatedCompletion(db, reread[0]!, p);
  }
  const [persisted] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, inserted[0]!.id));
  if (!persisted) throw new QaRemediationCompletionError("unresolved_conflict");
  const validated = await validateQaRemediationCompletionEvidence(db, persisted, p);
  if (!validated.ok) throw new QaRemediationCompletionError(validated.reason);
  const validatedCompletion = validated.completion;
  return { completionEventId: persisted.id, completion: validatedCompletion,
    qualityUseEvidenceRefId: validatedCompletion.schemaVersion === QA_REMEDIATION_COMPLETION_SCHEMA_VERSION_V3
      ? validatedCompletion.qualityUseEvidenceRefId : null,
    created: true, notifications: { agentIds: [...registeredAgents].sort(), wakeupRequestIds: wakes.map((wake) => wake.wakeupRequestId) } };
}
