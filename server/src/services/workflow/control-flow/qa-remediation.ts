// server/src/services/workflow/control-flow/qa-remediation.ts
//
// [purpose] QA 기계적 재작업 루프의 근본 완화 — "문구 교체" 수준의 기계적 반려에 생산자 에이전트를
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
//     같은 verdict 를 두 번 적용하지 않는다(재평가 시 "waiting" 홀드).
//   - bounded: QA stepRun 당 remediation 시도(이벤트 수) 상한. 초과/실패 시 기존 생산자 재작업 경로로 폴백.
//   - fail-closed: 어떤 조건이든 증명되지 않으면 not_applicable — caller(loop-driver)는 기존 재작업 경로 유지.
//
// [ordering] wake(QA 재실행) 먼저 → 파일 기록 → 이벤트 기록. wake 가 거부되면 아무것도 쓰지 않는다.
//   파일 기록 실패 시 write_failed 이벤트를 남기고 폴백한다(생산자 재실행이 산출물을 재생성해 치유).

import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, count, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowTransitionEvents, workflowStepRuns } from "@paperclipai/db";
import type { WorkflowQaRemediations, WorkflowVerdictFinding } from "@paperclipai/shared";
import type { EdgeBearingStep } from "./edge-condition.js";
import { isStructuralGateStep } from "./structural-gate.js";
import { isDeliveryReadbackStep } from "../delivery-verification-gate.js";
import { loadLatestQaRemediations } from "../validation-verdict-ledger.js";
import { loadProducerOwnReworkContext } from "./rework-producer-context.js";
import { isLatestQaExecution } from "./qa-cap-acceptance.js";

type StepRun = typeof workflowStepRuns.$inferSelect;

/** loop-driver 가 보는 run 의 최소 구조(구조적 호환). */
interface RemediationLoopRun {
  readonly id: string;
  readonly companyId: string;
  readonly status: string;
  readonly missionId?: string | null;
}

export const QA_REMEDIATION_EVENT_TYPE = "qa_remediation_applied";
/** QA stepRun 당 최대 remediation 시도 수(성공/실패 무관, 이벤트 수 기준). */
export const QA_REMEDIATION_MAX_ATTEMPTS = 3;
/** 단일 대상 파일 크기 상한 — 거대 산출물 실수 기록 방지. */
export const QA_REMEDIATION_MAX_FILE_BYTES = 2 * 1024 * 1024;

export type QaRemediationOutcome = "applied" | "waiting" | "not_applicable";

export interface QaRemediationPassResult {
  readonly outcome: QaRemediationOutcome;
  readonly detail?: string;
}

/** loop-driver 의 fresh 반려 QA 항목(구조만 요구). */
export interface RemediationRejectedQa {
  readonly edge: { readonly stepId: string };
  readonly qaRun?: StepRun | null;
}

export interface TryQaRemediationInput {
  readonly db: Db;
  readonly run: RemediationLoopRun;
  readonly steps: ReadonlyArray<EdgeBearingStep>;
  readonly producerStep: EdgeBearingStep;
  readonly producerRun: StepRun;
  readonly rejectedQas: readonly RemediationRejectedQa[];
  /** QA stepId → 공식 findings(없음=null). source_data 계층이 하나라도 있으면 기계적 수정 불가. */
  readonly findingsByQaStepId: ReadonlyMap<string, readonly WorkflowVerdictFinding[] | null>;
  /** QA 재실행(dag-engine wakeExistingWorkflowStepIssue 래핑). 순환 import 회피를 위해 주입받는다. */
  readonly refireQaStep: (qa: { stepId: string; stepRunId: string; issueId: string }) => Promise<boolean>;
}

interface QualifiedQa {
  readonly qaRun: StepRun;
  readonly remediations: WorkflowQaRemediations;
  readonly heartbeatRunId: string | null;
  readonly sourceVerdictEventId: string;
}

function isHardBlockedQaStep(def: EdgeBearingStep | undefined): boolean {
  // 구조/납품 확정 게이트는 결정론적 검증 자체가 목적 — 기계적 패치로 우회 불가(fail-closed).
  if (!def) return true;
  return isStructuralGateStep(def as never) || isDeliveryReadbackStep(def as never);
}

/** [current-generation freshness, fail-closed] 판정 observedAt 이 producer 완료 이후여야 한다. */
function isFreshRemediation(observedAt: Date | null, producerCompletedAt: Date | null): boolean {
  if (!producerCompletedAt || !observedAt) return false;
  return observedAt.getTime() >= producerCompletedAt.getTime();
}

async function remediationAttemptCount(db: Db, companyId: string, qaStepRunId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(workflowTransitionEvents)
    .where(and(
      eq(workflowTransitionEvents.companyId, companyId),
      eq(workflowTransitionEvents.workflowStepRunId, qaStepRunId),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_EVENT_TYPE),
    ));
  return Number(row?.n ?? 0);
}

async function remediationAlreadyApplied(
  db: Db,
  companyId: string,
  qaStepRunId: string,
  sourceVerdictEventId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: workflowTransitionEvents.id })
    .from(workflowTransitionEvents)
    .where(and(
      eq(workflowTransitionEvents.companyId, companyId),
      eq(workflowTransitionEvents.workflowStepRunId, qaStepRunId),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_EVENT_TYPE),
      eq(workflowTransitionEvents.idempotencyKey, `qa-remediation-applied:${companyId}:${qaStepRunId}:${sourceVerdictEventId}`),
    ))
    .limit(1);
  return Boolean(row);
}

/** 생산자 active workProduct 절대경로 → (정확 파일 허용집, 디렉터리 허용집). */
async function loadProducerArtifactBoundary(input: TryQaRemediationInput): Promise<{
  allowedFiles: Set<string>;
  allowedDirs: string[];
} | null> {
  if (!input.producerRun.issueId) return null;
  const context = await loadProducerOwnReworkContext({
    db: input.db,
    companyId: input.run.companyId,
    missionId: input.run.missionId ?? null,
    workflowRunId: input.run.id,
    producerStepId: input.producerStep.id,
    producerIssueId: input.producerRun.issueId,
  });
  const allowedFiles = new Set<string>();
  const allowedDirs: string[] = [];
  for (const product of context.workProducts) {
    if (!path.isAbsolute(product.ref)) continue;
    const resolved = path.resolve(product.ref);
    allowedFiles.add(resolved);
    allowedDirs.push(path.dirname(resolved));
  }
  return allowedDirs.length > 0 ? { allowedFiles, allowedDirs } : null;
}

function isInsideBoundary(file: string, boundary: { allowedFiles: Set<string>; allowedDirs: string[] }): boolean {
  if (!path.isAbsolute(file)) return false;
  const resolved = path.resolve(file);
  if (boundary.allowedFiles.has(resolved)) return true;
  return boundary.allowedDirs.some((dir) => {
    const rel = path.relative(dir, resolved);
    return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
}

/**
 * [purpose] fresh 반려 QA 전원이 기계 remediable 이면 결정론적 패치 + QA 재실행, 아니면 not_applicable.
 *   "waiting" = 이 verdict 들은 이미 remediation 이 적용된 상태(재실행 대기 중) — caller 는 재작업도 스킵.
 */
export async function tryQaRemediationPass(input: TryQaRemediationInput): Promise<QaRemediationPassResult> {
  const { db, run } = input;
  if (run.status === "cancelled") return { outcome: "not_applicable", detail: "run cancelled" };
  if (input.rejectedQas.length === 0) return { outcome: "not_applicable", detail: "no rejected qas" };

  const qualified: QualifiedQa[] = [];
  let waitingCount = 0;
  for (const q of input.rejectedQas) {
    const qaRun = q.qaRun;
    if (!qaRun || !qaRun.issueId) return { outcome: "not_applicable", detail: "rejected qa missing issue binding" };

    // 구조/납품 게이트 하드 블록(fail-closed) — 결정론적 게이트를 패치로 우회할 수 없다.
    const qaStepDef = input.steps.find((s) => s.id === q.edge.stepId);
    if (isHardBlockedQaStep(qaStepDef)) return { outcome: "not_applicable", detail: `hard-blocked qa step ${q.edge.stepId}` };

    // 원천 데이터 결함이 섞여 있으면 기계적 산출물 수정으로 해결 불가 — 생산자 재작업/오너 라우팅에 맡긴다.
    const findings = input.findingsByQaStepId.get(q.edge.stepId) ?? null;
    if (findings?.some((finding) => finding.layer === "source_data")) {
      return { outcome: "not_applicable", detail: `qa ${q.edge.stepId} carries source_data findings` };
    }

    const loaded = await loadLatestQaRemediations({ db, companyId: run.companyId, issueId: qaRun.issueId });
    if (!loaded) return { outcome: "not_applicable", detail: `qa ${q.edge.stepId} has no applicable remediations` };
    // exact current QA step-run binding: 이전 세대 verdict 의 remediation 은 절대 적용하지 않는다.
    if (!loaded.workflowStepRunId || loaded.workflowStepRunId !== qaRun.id) {
      return { outcome: "not_applicable", detail: `qa ${q.edge.stepId} remediation bound to foreign step run` };
    }
    // current producer generation 판정(unknown 시 fail-closed).
    if (!isFreshRemediation(loaded.observedAt, input.producerRun.completedAt ?? null)) {
      return { outcome: "not_applicable", detail: `qa ${q.edge.stepId} remediation not fresh for producer generation` };
    }
    // [execution freshness] verdict heartbeat 가 이 QA step 의 최신 실행이어야 한다(재발행 이후 판정 스킵).
    if (!(await isLatestQaExecution(db, qaRun.issueId, qaRun.id, loaded.heartbeatRunId))) {
      return { outcome: "not_applicable", detail: `qa ${q.edge.stepId} verdict superseded by newer execution` };
    }
    // [idempotency] 이 verdict event 에 대한 remediation 이 이미 적용됐다면 재적용/재작업 모두 스킵(홀드).
    if (await remediationAlreadyApplied(db, run.companyId, qaRun.id, loaded.sourceVerdictEventId)) {
      waitingCount += 1;
      continue;
    }
    // [bounded] QA stepRun 당 시도 상한 — 초과 시 생산자 재작업 경로로 폴백.
    const attempts = await remediationAttemptCount(db, run.companyId, qaRun.id);
    if (attempts >= QA_REMEDIATION_MAX_ATTEMPTS) {
      return { outcome: "not_applicable", detail: `qa ${q.edge.stepId} remediation attempt cap exhausted` };
    }

    qualified.push({
      qaRun,
      remediations: loaded.remediations,
      heartbeatRunId: loaded.heartbeatRunId,
      sourceVerdictEventId: loaded.sourceVerdictEventId,
    });
  }

  if (qualified.length === 0 && waitingCount === input.rejectedQas.length) {
    return { outcome: "waiting", detail: "all rejected qa verdicts already remediated; awaiting fresh QA verdict" };
  }

  // boundary: 생산자 등록 산출물 경로/디렉터리 외부 파일은 절대 건드리지 않는다.
  const boundary = await loadProducerArtifactBoundary(input);
  if (!boundary) return { outcome: "not_applicable", detail: "producer has no absolute-path active work products" };

  // two-phase validate: 파일 읽기 + 순차 find 검증(정확히 한 번). 하나라도 실패하면 전체 폴백.
  const fileBuffers = new Map<string, { content: string; itemCount: number }>();
  for (const qa of qualified) {
    for (const item of qa.remediations.items) {
      if (!isInsideBoundary(item.file, boundary)) {
        return { outcome: "not_applicable", detail: `remediation file outside producer artifact boundary: ${item.file}` };
      }
      const resolved = path.resolve(item.file);
      let entry = fileBuffers.get(resolved);
      if (!entry) {
        let size: number;
        try {
          size = (await stat(resolved)).size;
        } catch {
          return { outcome: "not_applicable", detail: `remediation target missing: ${resolved}` };
        }
        if (size > QA_REMEDIATION_MAX_FILE_BYTES) {
          return { outcome: "not_applicable", detail: `remediation target too large: ${resolved}` };
        }
        try {
          entry = { content: await readFile(resolved, "utf8"), itemCount: 0 };
        } catch {
          return { outcome: "not_applicable", detail: `remediation target unreadable: ${resolved}` };
        }
        fileBuffers.set(resolved, entry);
      }
      const first = entry.content.indexOf(item.find);
      if (first === -1 || entry.content.indexOf(item.find, first + 1) !== -1) {
        return { outcome: "not_applicable", detail: `find not exactly-once in ${resolved} (qa ${qa.qaRun.stepId})` };
      }
      entry.content = entry.content.slice(0, first) + item.replace + entry.content.slice(first + item.find.length);
      entry.itemCount += 1;
    }
  }

  // wake first: QA 재실행이 거부되면 아무것도 기록하지 않는다(원자성 — 부분 상태 없음).
  for (const qa of qualified) {
    if (!qa.qaRun.issueId) return { outcome: "not_applicable", detail: "qualified qa lost issue binding" };
    const queued = await input.refireQaStep({ stepId: qa.qaRun.stepId, stepRunId: qa.qaRun.id, issueId: qa.qaRun.issueId });
    if (!queued) {
      return { outcome: "not_applicable", detail: `qa re-fire refused for ${qa.qaRun.stepId}` };
    }
  }

  // write phase: 모든 패치 파일 기록. 실패 시 감사 이벤트(write_failed) 후 기존 경로 폴백.
  let writeError: string | null = null;
  for (const [file, entry] of fileBuffers) {
    try {
      await writeFile(file, entry.content, "utf8");
    } catch (error) {
      writeError = error instanceof Error ? error.message : String(error);
      break;
    }
  }

  const nowIso = new Date().toISOString();
  for (const qa of qualified) {
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
      idempotencyKey: `qa-remediation-applied:${run.companyId}:${qa.qaRun.id}:${qa.sourceVerdictEventId}`,
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
        ...(writeError ? { writeError } : {}),
      },
    }).onConflictDoNothing();
  }

  if (writeError) {
    return { outcome: "not_applicable", detail: `remediation write failed: ${writeError}` };
  }
  return { outcome: "applied", detail: `${qualified.length} qa remediated without producer rework` };
}
