// server/src/services/workflow/control-flow/qa-remediation.ts
//
// [purpose] QA 기계적 재작업 루프의 근본 완화 — "문구 교체" 수준의 기계적 반별에 생산자 에이전트를
//   재실행(수십 분)하는 대신, 공식 request_changes verdict 에 동봉된 schema-validated
//   `remediations`(string_replace 항목들)을 결정론적으로 적용하고 QA 스텝만 재실행한다.
//
// [authority] remediations 는 오직 공식 workflow_api verdict 이벤트 payload 의 구조 필드에서만 읽는다
//   (validation-verdict-ledger.loadLatestQaRemediations — payload JSON 은 schema 재검증). 자연어
//   reason/comment/stdout 은 절대 적용 권위가 아니다(rule 8).
//
// [safety]
//   - boundary: remediation file 은 생산자의 active workProduct 절대경로 또는 그 디렉터리 내부로 한정.
//   - determinism: find 는 대상 파일(현재까지 적용된 시뮬레이션 내용 기준)에서 정확히 한 번 나타나야 한다.
//   - idempotency: workflow root 는 exact source verdict/attempt 에 묶인 reservation/completion/wake 키를 사용해
//     같은 verdict 를 두 번 적용하거나 재QA wake 를 중복 생성하지 않는다.
//   - bounded: root 가 attempt/reservation 상한과 불확실한 기존 효과를 typed hold 로 판정한다.
//   - fail-closed: root 의 명시적 not_applicable 만 기존 producer rework 를 허용하고, hold 는 fallback 하지 않는다.
//
// [ordering] C02의 생산자 증명·binding 지원 경로는 불변 파일 저장→발급→내구 큐→확정 후 전달한다.
//   남은 legacy workflow 경로도 식별자 전용 요청으로 root transaction 밖에 나가 기존 guarded reconcile을
//   사용한다.

import { writeFile } from "node:fs/promises";
import { and, eq, inArray, or, isNotNull } from "drizzle-orm";
import type { WorkflowStep } from "../dag-engine.js";
import type { workflowDefinitions, Db } from "@paperclipai/db";
import { wakeExistingWorkflowStepIssue } from "../workflow-step-wake.js";
import {
  currentQaRemediationRootResolution,
  QaRemediationReconcileRequired,
  tryQaCorrectionFollowup,
} from "./qa-correction-followup-reconcile.js";
import { QaRemediationReconcileError } from "./qa-remediation-reconcile.js";
import { workflowTransitionEvents, workflowRecoveryAuthorities, heartbeatRuns, workflowStepRuns, workflowRuns } from "@paperclipai/db";
import { logger } from "../../../middleware/logger.js";
import {
  QA_REMEDIATION_EVENT_TYPE, remediationIdempotencyKey,
  type QaRemediationPassResult,
  type TryQaRemediationInput,
} from "./qa-remediation-contract.js";
import { hasPendingQaRemediationForRun, workflowRunHasC5AdmissionScope } from "./qa-remediation-admission-root.js";
import { currentReplacementRootNotifications } from "../../issue-assignment-wakeup.js";
import { captureMechanicalReworkPatterns, computeDefectSignature } from "./knowledge-draft-capture.js";
import { loadLatestQaRemediations } from "../validation-verdict-ledger.js";
import type { QaRemediationCompletion } from "./qa-remediation-completion.js";
import { QA_REMEDIATION_PREPARATION_EVENT_TYPE } from "./qa-remediation-preparation-contract.js";
import { hashQaCorrectionPayload } from "./qa-correction-contract.js";
import { collectQualifiableQaRemediations } from "./qa-remediation-qualification.js";

export {
  QA_REMEDIATION_EVENT_TYPE,
  QA_REMEDIATION_MAX_ATTEMPTS,
  QA_REMEDIATION_MAX_FILE_BYTES,
  remediationAlreadyApplied,
  remediationAttemptCount,
  remediationIdempotencyKey,
} from "./qa-remediation-contract.js";
export type {
  PreparedFile,
  QaRemediationOutcome,
  QaRemediationPassResult,
  QualificationResult,
  QualifiedQa,
  RemediationRejectedQa,
  TryQaRemediationInput,
} from "./qa-remediation-contract.js";
export { collectQualifiableQaRemediations, isInsideBoundary } from "./qa-remediation-qualification.js";

/** Existing DAG refire contract, kept here with the remediation owner to avoid a runtime DAG import. */
export function createQaRemediationRefire(input: {
  db: Db; run: typeof workflowRuns.$inferSelect; definition: typeof workflowDefinitions.$inferSelect;
  steps: readonly WorkflowStep[]; stepRuns: readonly (typeof workflowStepRuns.$inferSelect)[];
}): TryQaRemediationInput["refireQaStep"] {
  return async (qa) => {
    const step = input.steps.find(s => s.id === qa.stepId);
    if (!step || !qa.issueId) return false;
    const qaRun = input.stepRuns.find(sr => sr.id === qa.stepRunId);
    return wakeExistingWorkflowStepIssue({
      db: input.db, run: input.run, definition: input.definition, step,
      stepRunId: qa.stepRunId, stepRunMetadata: qaRun?.metadata, issueId: qa.issueId,
      allowCompletedIssue: true, allowBlockedIssue: true, forceFreshSession: true,
      idempotencyKey: `qa-remediation-refire:${input.run.id}:${qa.stepRunId}`,
    });
  };
}

/**
 * [purpose] C02 correction 경로를 우선 처리한 뒤, legacy workflow 요청을 identifier-only root reconcile 로 넘긴다.
 *   durable completed 는 기존 waiting loop 결과로, root-confirmed not_applicable 만 producer rework 로 이어진다.
 */
export async function tryQaRemediationPass(input: TryQaRemediationInput): Promise<QaRemediationPassResult> {
  const { db, run } = input;
  const correction = await tryQaCorrectionFollowup(input);
  if (correction) return correction;
  if (!await directEntryHasC5Scope(input)
    && (!currentReplacementRootNotifications(db) || !await workflowRunHasC5AdmissionScope(db, run.id))) return legacyDirectPass(input);
  const qaStepRunIds = input.rejectedQas.map((qa) => qa.qaRun?.id);
  if (!run.missionId || qaStepRunIds.length === 0 || qaStepRunIds.some((id) => !id)
    || new Set(qaStepRunIds).size !== qaStepRunIds.length) {
    throw new QaRemediationReconcileError("request");
  }
  const request = {
    companyId: run.companyId,
    missionId: run.missionId,
    workflowRunId: run.id,
    producerStepRunId: input.producerRun.id,
    qaStepRunIds: qaStepRunIds as string[],
  };
  const syncIdentity = await qaRemediationSyncIdentity(input, request);
  const rootResolution = currentQaRemediationRootResolution(db, request, syncIdentity);
  if (rootResolution?.outcome === "completed") {
    if (rootResolution.created) await captureCompletedRemediationPatterns(input, rootResolution.completion);
    return { outcome: "waiting", detail: "guarded root completion and QA wake are durable; producer rework is withheld" };
  }
  if (rootResolution?.outcome === "superseded_by_replacement") {
    return { outcome: "waiting", detail: "consumed replacement preserves original completion without new publication or rework" };
  }
  if (rootResolution?.outcome === "not_applicable") {
    const currentQualification = await collectQualifiableQaRemediations(input);
    if (currentQualification.status === "waiting") {
      return { outcome: "waiting", detail: "current qualification remains behind an existing remediation effect" };
    }
    if (currentQualification.status === "qualified") {
      throw new QaRemediationReconcileError("root_resolution_stale");
    }
    if (!await hasRemediationHistory(db, request)) {
      return { outcome: "not_applicable", detail: "guarded root and current history re-read found no applicable or attempted effect" };
    }
  }
  throw new QaRemediationReconcileRequired(request, syncIdentity);
}

/** Only proven unlinked direct callers retain the original legacy publication contract. */
async function directEntryHasC5Scope({ db, run }: TryQaRemediationInput): Promise<boolean> {
  const [current] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.id, run.id), eq(workflowRuns.companyId, run.companyId)));
  if (!current || current.missionId !== run.missionId
    || current.status !== run.status) throw new QaRemediationReconcileError("request");
  const steps = await db.select({ status: workflowStepRuns.status }).from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id));
  const [authority] = await db.select({ id: workflowRecoveryAuthorities.id }).from(workflowRecoveryAuthorities)
    .where(and(eq(workflowRecoveryAuthorities.companyId, run.companyId), or(
      eq(workflowRecoveryAuthorities.workflowRunId, run.id), eq(workflowRecoveryAuthorities.replacementRunId, run.id)))).limit(1);
  const [history] = await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents)
    .where(and(eq(workflowTransitionEvents.companyId, run.companyId), eq(workflowTransitionEvents.workflowRunId, run.id),
      inArray(workflowTransitionEvents.eventType, ["qa_remediation_prepared", "qa_remediation_completed", "qa_correction_prepared"])) ).limit(1);
  const [actual] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .innerJoin(workflowStepRuns, eq(workflowStepRuns.id, heartbeatRuns.workflowStepRunId))
    .where(and(eq(heartbeatRuns.companyId, run.companyId), eq(workflowStepRuns.workflowRunId, run.id),
      isNotNull(heartbeatRuns.executorOwnerId), isNotNull(heartbeatRuns.executionToken))).limit(1);
  if (authority || history) await hasPendingQaRemediationForRun(db, current);
  return Boolean(authority || history || actual || steps.some(step => step.status === "held" || step.status === "blocked"));
}

async function legacyDirectPass(input: TryQaRemediationInput): Promise<QaRemediationPassResult> {
  const { db, run } = input, prepared = await collectQualifiableQaRemediations(input);
  if (prepared.status !== "qualified") return { outcome: prepared.status, detail: prepared.detail };
  const { qualified, fileBuffers } = prepared;
  for (const qa of qualified) {
    if (!qa.qaRun.issueId) return { outcome: "not_applicable", detail: "qualified qa lost issue binding" };
    if (!await input.refireQaStep({ stepId: qa.qaRun.stepId, stepRunId: qa.qaRun.id, issueId: qa.qaRun.issueId }))
      return { outcome: "not_applicable", detail: `qa re-fire refused for ${qa.qaRun.stepId}` };
  }
  let writeError: string | null = null;
  for (const [file, entry] of fileBuffers) {
    try { await writeFile(file, entry.content, "utf8"); }
    catch (error) { writeError = error instanceof Error ? error.message : String(error); break; }
  }
  const nowIso = new Date().toISOString();
  for (const qa of qualified) {
    await db.insert(workflowTransitionEvents).values({
      companyId: run.companyId, missionId: run.missionId ?? null, workflowRunId: run.id,
      workflowStepRunId: qa.qaRun.id, issueId: qa.qaRun.issueId ?? null, heartbeatRunId: qa.heartbeatRunId,
      eventType: QA_REMEDIATION_EVENT_TYPE, layer: "workflow_validation", verdict: "request_changes",
      decision: writeError ? "mechanical_remediation_write_failed" : "mechanical_remediation_applied",
      reason: "workflow_api", reasonCode: "qa_remediation",
      idempotencyKey: remediationIdempotencyKey(run.companyId, qa.qaRun.id, qa.sourceVerdictEventId),
      payload: { kind: "qa_remediation_applied", outcome: writeError ? "write_failed" : "applied",
        producerStepId: input.producerStep.id, producerStepRunId: input.producerRun.id,
        producerIteration: input.producerRun.iterationIndex ?? 0, qaStepId: qa.qaRun.stepId,
        sourceVerdictEventId: qa.sourceVerdictEventId, appliedAt: nowIso, items: qa.remediations.items,
        signatures: qa.remediations.items.map(item => computeDefectSignature(item.find, item.replace)),
        ...(writeError ? { writeError } : {}) },
    }).onConflictDoNothing();
  }
  if (writeError) return { outcome: "not_applicable", detail: `remediation write failed: ${writeError}` };
  try {
    for (const qa of qualified) await captureMechanicalReworkPatterns({ db, companyId: run.companyId,
      remediationEventType: QA_REMEDIATION_EVENT_TYPE, producerStepId: input.producerStep.id,
      qaStepId: qa.qaRun.stepId, sourceVerdictEventId: qa.sourceVerdictEventId, items: qa.remediations.items });
  } catch (error) { logger.warn({ err: error, runId: run.id }, "knowledge-draft-capture non-blocking failure"); }
  return { outcome: "applied", detail: `${qualified.length} qa remediated without producer rework` };
}

function attemptIdentity(stepRun: {
  id: string; stepId: string; issueId: string | null;
  executionGeneration: number; retryCount: number; iterationIndex: number | null;
  dispatchOwnerWakeupRequestId: string | null; dispatchOwnerHeartbeatRunId: string | null;
  completedAt: Date | null;
} | null | undefined) {
  if (!stepRun) return null;
  return {
    id: stepRun.id, stepId: stepRun.stepId, issueId: stepRun.issueId,
    executionGeneration: stepRun.executionGeneration,
    retryCount: stepRun.retryCount, iterationIndex: stepRun.iterationIndex,
    dispatchOwnerWakeupRequestId: stepRun.dispatchOwnerWakeupRequestId,
    dispatchOwnerHeartbeatRunId: stepRun.dispatchOwnerHeartbeatRunId,
    completedAt: stepRun.completedAt?.toISOString() ?? null,
  };
}

async function qaRemediationSyncIdentity(input: TryQaRemediationInput,
  request: { companyId: string; missionId: string; workflowRunId: string; producerStepRunId: string; qaStepRunIds: string[] }): Promise<string> {
  const qas = await Promise.all(input.rejectedQas.map(async ({ qaRun }) => {
    const source = qaRun?.issueId
      ? await loadLatestQaRemediations({ db: input.db, companyId: input.run.companyId, issueId: qaRun.issueId })
      : null;
    return {
      attempt: attemptIdentity(qaRun),
      source: source ? { eventId: source.sourceVerdictEventId, heartbeatRunId: source.heartbeatRunId,
        remediationsHash: hashQaCorrectionPayload(source.remediations.items) } : null,
    };
  }));
  qas.sort((a, b) => (a.attempt?.id ?? "").localeCompare(b.attempt?.id ?? ""));
  return JSON.stringify({ request: { ...request, qaStepRunIds: [...request.qaStepRunIds].sort() },
    run: { status: input.run.status, missionId: input.run.missionId },
    producer: attemptIdentity(input.producerRun), qas,
    findings: [...input.findingsByQaStepId.entries()].sort(([a], [b]) => a.localeCompare(b)) });
}

async function hasRemediationHistory(db: Db, request: {
  companyId: string; workflowRunId: string; producerStepRunId: string; qaStepRunIds: string[];
}): Promise<boolean> {
  const [preparations, legacy] = await Promise.all([
    db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, request.companyId),
      eq(workflowTransitionEvents.workflowRunId, request.workflowRunId),
      eq(workflowTransitionEvents.workflowStepRunId, request.producerStepRunId),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE))),
    db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, request.companyId),
      eq(workflowTransitionEvents.workflowRunId, request.workflowRunId),
      inArray(workflowTransitionEvents.workflowStepRunId, request.qaStepRunIds),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_EVENT_TYPE))),
  ]);
  return preparations.length > 0 || legacy.length > 0;
}

async function captureCompletedRemediationPatterns(input: TryQaRemediationInput, completion: QaRemediationCompletion): Promise<void> {
  // This was non-blocking on the legacy success path. The durable completion, not memory or prepared bytes,
  // supplies the exact QA attempts; the source ledger is re-read before retaining the same optional side effect.
  try {
    for (const verdict of completion.verdicts) {
      const loaded = await loadLatestQaRemediations({ db: input.db, companyId: input.run.companyId,
        issueId: verdict.qa.issueId });
      if (!loaded || loaded.workflowStepRunId !== verdict.qa.stepRunId
        || loaded.sourceVerdictEventId !== verdict.eventId || loaded.heartbeatRunId !== verdict.heartbeatRunId) continue;
      await captureMechanicalReworkPatterns({
        db: input.db,
        companyId: input.run.companyId,
        remediationEventType: QA_REMEDIATION_EVENT_TYPE,
        producerStepId: completion.producer.stepId,
        qaStepId: verdict.qa.stepId,
        sourceVerdictEventId: verdict.eventId,
        items: loaded.remediations.items,
      });
    }
  } catch (error) {
    logger.warn({ err: error, runId: input.run.id }, "knowledge-draft-capture non-blocking failure");
  }
}
