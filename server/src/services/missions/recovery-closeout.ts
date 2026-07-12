// server/src/services/missions/recovery-closeout.ts
//
// 복구된 producer + QA PASS → failed workflow step/run 재조정(req 4). 전역 issue-done 덮어쓰기 ❌.
// 동일 workflowRun/DAG dependency 에서 QA gate 가 검증한 producer source issue 를 DAG 역참조로 정확히
// resolve 하여 그 producer 의 failed step 만 CAS completed 로 재조정. 다른 failed step/run/issue 미건드.
// 판정 로직은 classifyRecoveryCloseout(pure), DB mutation 은 reconcileRecoveredWorkflowStep.
// producer 는 항상 DAG resolve(외부 override 금지 — 같은 run 의 다른 실패 step 닫기 방지).

import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  issueWorkProducts,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { resolveProducerStepIdFromDag } from "./workflow-qa-rework.js";

export const RECOVERY_CLOSEOUT_MARKER_KEY = "recoveryCloseout";
const ACTIVE_WORK_PRODUCT_STATUS = "active";
const PASS_VERDICT = "pass";
const CLOSEOUT_ACTOR_TYPE = "system";
const CLOSEOUT_ACTOR_ID = "recovery-closeout";

export type RecoveryCloseoutSkipReason =
  | "no_qa_gate"
  | "producer_unresolved"
  | "no_active_workproduct"
  | "no_fresh_qa_pass"
  | "no_failed_step"
  | "already_completed"
  | "missing_generation_proof";

export type RecoveryCloseoutResult =
  | {
      reconciled: true;
      workflowStepRunId: string;
      workflowRunId: string;
      stepPriorStatus: string;
    }
  | { skipped: true; reason: RecoveryCloseoutSkipReason };

export interface RecoveryCloseoutClassification {
  hasActiveWorkProduct: boolean;
  hasFreshQaPass: boolean; // PASS verdict on QA gate, current generation(producerCompletedAt 이후), 동일 run
  hasFailedProducerStep: boolean;
  alreadyCompleted: boolean;
}

export type RecoveryCloseoutGate =
  | { reconcile: true }
  | { reconcile: false; reason: "no_active_workproduct" | "already_completed" | "no_fresh_qa_pass" | "no_failed_step" };

// pure 게이트. 단위 테스트 대상.
export function classifyRecoveryCloseout(c: RecoveryCloseoutClassification): RecoveryCloseoutGate {
  if (!c.hasActiveWorkProduct) return { reconcile: false, reason: "no_active_workproduct" };
  if (c.alreadyCompleted) return { reconcile: false, reason: "already_completed" };
  if (!c.hasFreshQaPass) return { reconcile: false, reason: "no_fresh_qa_pass" };
  if (!c.hasFailedProducerStep) return { reconcile: false, reason: "no_failed_step" };
  return { reconcile: true };
}

export interface RecoveryCloseoutInput {
  companyId: string;
  missionId: string;
  /** QA gate issue id(검증자). producer 는 동일 run 의 DAG 역참조로 resolve(override 불가). */
  qaGateIssueId: string;
  /** producer 현재 반복 완료 시각 — current-generation PASS 의 필수 기준. 없으면 skip. */
  producerCompletedAt?: Date | null;
  /** 감사 마커의 호출 출처(supervision/heartbeat 등). */
  source?: string;
}

type ProducerResolution = {
  producerIssueId: string;
  workflowRunId: string;
};

// QA gate issue → 동일 run 의 producer source issue 를 DAG 역참조로 resolve.
async function resolveProducer(db: Db, input: RecoveryCloseoutInput): Promise<ProducerResolution | null> {
  const qaStepRow = await db
    .select({ stepRun: workflowStepRuns, run: workflowRuns, definition: workflowDefinitions })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
    .where(and(eq(workflowRuns.companyId, input.companyId), eq(workflowStepRuns.issueId, input.qaGateIssueId)))
    .orderBy(desc(workflowStepRuns.startedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!qaStepRow) return null;
  const workflowRunId = qaStepRow.run.id;
  const steps = qaStepRow.definition.stepsJson as Parameters<typeof resolveProducerStepIdFromDag>[1] | null;
  if (!steps) return null;
  const producerStepId = resolveProducerStepIdFromDag(qaStepRow.stepRun.stepId, steps);
  if (!producerStepId) return null;
  const producerStepRow = await db
    .select({ issueId: workflowStepRuns.issueId })
    .from(workflowStepRuns)
    .where(and(
      eq(workflowStepRuns.workflowRunId, workflowRunId),
      eq(workflowStepRuns.stepId, producerStepId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!producerStepRow?.issueId) return null;
  return { producerIssueId: producerStepRow.issueId, workflowRunId };
}

// 복구 producer + current-gen PASS → 그 producer 의 failed step 만 completed 재조정.
// evidence 부족/이미 완료/다른 run verdict/producerCompletedAt 부재 → 0 mutation(skipped). idempotent.
export async function reconcileRecoveredWorkflowStep(
  db: Db,
  input: RecoveryCloseoutInput,
): Promise<RecoveryCloseoutResult> {
  const resolution = await resolveProducer(db, input);
  if (!resolution) return { skipped: true, reason: "producer_unresolved" };
  const { producerIssueId, workflowRunId } = resolution;

  // current-generation proof 필수 — 없으면 증거 부족 skip.
  if (!input.producerCompletedAt) {
    return { skipped: true, reason: "missing_generation_proof" };
  }

  // (1) active workProduct on producer.
  const activeWorkProduct = await db
    .select({ id: issueWorkProducts.id })
    .from(issueWorkProducts)
    .where(and(
      eq(issueWorkProducts.companyId, input.companyId),
      eq(issueWorkProducts.issueId, producerIssueId),
      eq(issueWorkProducts.status, ACTIVE_WORK_PRODUCT_STATUS),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  // (2) producer failed step in this run.
  const failedStep = await db
    .select({ id: workflowStepRuns.id, status: workflowStepRuns.status, metadata: workflowStepRuns.metadata })
    .from(workflowStepRuns)
    .where(and(
      eq(workflowStepRuns.workflowRunId, workflowRunId),
      eq(workflowStepRuns.issueId, producerIssueId),
      eq(workflowStepRuns.status, "failed"),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  // already-completed(재호출 idempotency).
  const completedStep = failedStep ? null : await db
    .select({ id: workflowStepRuns.id })
    .from(workflowStepRuns)
    .where(and(
      eq(workflowStepRuns.workflowRunId, workflowRunId),
      eq(workflowStepRuns.issueId, producerIssueId),
      eq(workflowStepRuns.status, "completed"),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  // (3) current-gen official PASS on QA gate, 동일 run, observedAt >= producerCompletedAt.
  const freshPass = await db
    .select({ id: workflowTransitionEvents.id })
    .from(workflowTransitionEvents)
    .where(and(
      eq(workflowTransitionEvents.companyId, input.companyId),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      eq(workflowTransitionEvents.verdict, PASS_VERDICT),
      eq(workflowTransitionEvents.issueId, input.qaGateIssueId),
      eq(workflowTransitionEvents.workflowRunId, workflowRunId),
      gte(workflowTransitionEvents.createdAt, input.producerCompletedAt),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  const gate = classifyRecoveryCloseout({
    hasActiveWorkProduct: Boolean(activeWorkProduct),
    hasFreshQaPass: Boolean(freshPass),
    hasFailedProducerStep: Boolean(failedStep),
    alreadyCompleted: Boolean(completedStep),
  });
  if (!gate.reconcile) return { skipped: true, reason: gate.reason };
  if (!failedStep) return { skipped: true, reason: "no_failed_step" };

  // CAS: status='failed' → 'completed' (WHERE status='failed' 동시성 안전). metadata 감사 마커.
  const priorMetadata = (failedStep.metadata ?? {}) as Record<string, unknown>;
  const marker = {
    source: input.source ?? "recovery_closeout",
    qaGateIssueId: input.qaGateIssueId,
    producerIssueId,
    workProductId: activeWorkProduct!.id,
    qaPassTransitionEventId: freshPass!.id,
    closedAt: new Date().toISOString(),
  };
  const updatedMetadata = { ...priorMetadata, [RECOVERY_CLOSEOUT_MARKER_KEY]: marker };
  const updated = await db
    .update(workflowStepRuns)
    .set({ status: "completed", metadata: updatedMetadata, completedAt: new Date() })
    .where(and(eq(workflowStepRuns.id, failedStep.id), eq(workflowStepRuns.status, "failed")))
    .returning({ id: workflowStepRuns.id });

  if (updated.length === 0) {
    return { skipped: true, reason: "already_completed" };
  }

  // audit log — 실제 변경된 한 step 에만. actorType=system, actorId=recovery-closeout 명시.
  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: CLOSEOUT_ACTOR_TYPE,
    actorId: CLOSEOUT_ACTOR_ID,
    action: "mission.recovery_closeout_reconciled_step",
    entityType: "workflow_step_run",
    entityId: failedStep.id,
    details: marker,
  }).onConflictDoNothing();

  return {
    reconciled: true,
    workflowStepRunId: failedStep.id,
    workflowRunId,
    stepPriorStatus: failedStep.status,
  };
}
