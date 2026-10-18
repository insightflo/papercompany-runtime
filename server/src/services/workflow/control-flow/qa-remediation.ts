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
//   - idempotency: qa_remediation_applied 이벤트의 idempotencyKey 가 원천 verdict event id 를 물고 있어
//     같은 verdict 를 두 번 적용하지 않는다(재평가 시 "waiting" 홀드). Quality current_output 경로도
//     같은 이벤트/키 계약을 쓴다(T3 연결).
//   - bounded: QA stepRun 당 remediation 시도(이벤트 수) 상한. 초과/실패 시 기존 생산자 재작업 경로로 폴백.
//   - fail-closed: 어떤 조건이든 증명되지 않으면 not_applicable — caller(loop-driver)는 기존 재작업 경로 유지.
//
// [ordering] 일반 경로: wake(QA 재실행) 먼저 → 파일 기록 → 이벤트 기록. wake 가 거부되면 아무것도 쓰지 않는다.
//   파일 기록 실패 시 write_failed 이벤트를 남기고 폴백한다. Quality current_output 경로
//   (services/quality/current-output.ts)는 아래 export 된 자격검사/기록 코어를 재사용하되 깨우지 않는다.

import { writeFile } from "node:fs/promises";
import { workflowTransitionEvents } from "@paperclipai/db";
import { logger } from "../../../middleware/logger.js";
import {
  QA_REMEDIATION_EVENT_TYPE,
  remediationIdempotencyKey,
  type PreparedFile,
  type QaRemediationPassResult,
  type QualifiedQa,
  type TryQaRemediationInput,
} from "./qa-remediation-contract.js";
import { collectQualifiableQaRemediations } from "./qa-remediation-qualification.js";
import { captureMechanicalReworkPatterns, computeDefectSignature } from "./knowledge-draft-capture.js";

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

/**
 * [T3 추출] write phase: 패치 파일 기록 + 감사 이벤트 기록. extraEventPayload 로 호출자(Quality
 *   current_output)가 머신 생성 추가 필드(file 이전/이후 hash)를 같은 이벤트에 넣을 수 있다.
 */
export async function writeQaRemediationPatches(input: Pick<TryQaRemediationInput, "db" | "run" | "producerStep" | "producerRun"> & {
  qualified: readonly QualifiedQa[]; fileBuffers: ReadonlyMap<string, PreparedFile>;
  extraEventPayload?: (qa: QualifiedQa) => Record<string, unknown>;
}): Promise<{ writeError: string | null }> {
  const { db, run } = input;
  let writeError: string | null = null;
  for (const [file, entry] of input.fileBuffers) {
    try {
      await writeFile(file, entry.content, "utf8");
    } catch (error) {
      writeError = error instanceof Error ? error.message : String(error);
      break;
    }
  }

  const nowIso = new Date().toISOString();
  for (const qa of input.qualified) {
    await db.insert(workflowTransitionEvents).values({
      companyId: run.companyId,
      missionId: run.missionId ?? null,
      workflowRunId: run.id,
      workflowStepRunId: qa.qaRun.id,
      issueId: qa.qaRun.issueId ?? null,
      heartbeatRunId: qa.heartbeatRunId,
      eventType: QA_REMEDIATION_EVENT_TYPE,
      layer: "workflow_validation",
      decision: writeError ? "mechanical_remediation_write_failed" : "mechanical_remediation_applied",
      verdict: "request_changes",
      reason: "workflow_api",
      reasonCode: "qa_remediation",
      idempotencyKey: remediationIdempotencyKey(run.companyId, qa.qaRun.id, qa.sourceVerdictEventId),
      payload: {
        kind: "qa_remediation_applied",
        outcome: writeError ? "write_failed" : "applied",
        producerStepId: input.producerStep.id,
        producerStepRunId: input.producerRun.id,
        producerIteration: input.producerRun.iterationIndex ?? 0,
        qaStepId: qa.qaRun.stepId,
        sourceVerdictEventId: qa.sourceVerdictEventId,
        appliedAt: nowIso,
        items: qa.remediations.items,
        // [P1 결함 서명] 동일 교정 반복 감지용 머신 생성 해시(knowledge-draft-capture 규약 v1).
        signatures: qa.remediations.items.map((item) => computeDefectSignature(item.find, item.replace)),
        ...(input.extraEventPayload ? input.extraEventPayload(qa) : {}),
        ...(writeError ? { writeError } : {}),
      },
    }).onConflictDoNothing();
  }
  return { writeError };
}

/**
 * [purpose] fresh 반려 QA 전원이 기계 remediable 이면 결정론적 패치 + QA 재실행, 아니면 not_applicable.
 *   "waiting" = 이 verdict 들은 이미 remediation 이 적용된 상태(재실행 대기 중) — caller 는 재작업도 스킵.
 */
export async function tryQaRemediationPass(input: TryQaRemediationInput): Promise<QaRemediationPassResult> {
  const { db, run } = input;
  const prepared = await collectQualifiableQaRemediations(input);
  if (prepared.status !== "qualified") return { outcome: prepared.status, detail: prepared.detail };
  const { qualified, fileBuffers } = prepared;

  // wake first: QA 재실행이 거부되면 아무것도 기록하지 않는다(원자성 — 부분 상태 없음).
  for (const qa of qualified) {
    if (!qa.qaRun.issueId) return { outcome: "not_applicable", detail: "qualified qa lost issue binding" };
    const queued = await input.refireQaStep({ stepId: qa.qaRun.stepId, stepRunId: qa.qaRun.id, issueId: qa.qaRun.issueId });
    if (!queued) return { outcome: "not_applicable", detail: `qa re-fire refused for ${qa.qaRun.stepId}` };
  }

  const { writeError } = await writeQaRemediationPatches({ db, run, producerStep: input.producerStep, producerRun: input.producerRun, qualified, fileBuffers });

  if (writeError) return { outcome: "not_applicable", detail: `remediation write failed: ${writeError}` };

  // [P1 지식 초안 캡처 — 비차단] 모든 제어 판정/기록이 끝난 뒤의 부수 기록. 실패해도
  //   applied 반환과 재작업 경로는 절대 바뀌지 않는다(규칙 7 — 실행통제 영향 0).
  try {
    for (const qa of qualified) {
      await captureMechanicalReworkPatterns({
        db,
        companyId: run.companyId,
        remediationEventType: QA_REMEDIATION_EVENT_TYPE,
        producerStepId: input.producerStep.id,
        qaStepId: qa.qaRun.stepId,
        sourceVerdictEventId: qa.sourceVerdictEventId,
        items: qa.remediations.items,
      });
    }
  } catch (error) {
    logger.warn({ err: error, runId: run.id }, "knowledge-draft-capture non-blocking failure");
  }

  return { outcome: "applied", detail: `${qualified.length} qa remediated without producer rework` };
}
