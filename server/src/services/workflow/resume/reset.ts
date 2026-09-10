import { and, eq } from "drizzle-orm";
import { workflowStepRuns } from "@paperclipai/db";
import { badRequest, conflict } from "../../../errors.js";
import {
  appendWorkflowAuthorityTransition,
  supersedeWorkflowDelegationsForGeneration,
} from "../authority/transitions.js";
import type { ResumeMutationTransaction, ResumeStepRunRow } from "./serialization.js";

/**
 * [파일 목적] Task6a resume reset 의 bounded primitive. serialization 이 잠근
 *   workflow_step_runs 행 배열만 입력으로 받아 계약 필드를 pending 리셋하고
 *   executionGeneration/statusTransitionVersion 를 각각 +1 한다(CAS 보호).
 * [수정시 주의]
 *   - 적격성 판정은 caller preview 가 책임진다. 이 함수는 status/issue/counter 기본 계약만
 *     방어한다(completed/running, nonnull issueId, 중복, crossrun, overflow 거부).
 *   - retryCount/iterationIndex/originalStatus/agentName/legacyPluginStepEntityId/
 *     dispatchAuthorityKind 는 리셋하지 않는다(루프 재시도가 아니다).
 *   - metadata 는 allowlist(failureCascadeSkipped, controlFlowSkipped, controlNodeGraceWait,
 *     controlNodeResult, controlNodeError) 만 제거하고 resumeRequestId 를 설정한다.
 *     그 외 키는 절대 지우지 않는다.
 *   - 위임/권한 무효화는 반드시 authority/transitions.ts 공식 경로로만 수행한다.
 *     수동 delegation mutation 금지. CAS 실패는 conflict — caller 트랜잭션이 전체 롤백한다.
 */

const PG_INT_MAX = 2_147_483_647;
const RESUME_METADATA_RESET_ALLOWLIST: readonly string[] = [
  "failureCascadeSkipped",
  "controlFlowSkipped",
  "controlNodeGraceWait",
  "controlNodeResult",
  "controlNodeError",
];

export interface ResetForResumeInput {
  companyId: string;
  workflowRunId: string;
  requestId: string;
  steps: ResumeStepRunRow[];
  now: Date;
}

function isSafeNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizedMetadata(step: ResumeStepRunRow): Record<string, unknown> {
  const metadata = step.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? { ...metadata }
    : {};
}

function validateResetInput(input: ResetForResumeInput): void {
  const steps = input.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw badRequest("resume reset requires at least one locked workflow step run");
  }
  const seenStepIds = new Set<string>();
  const seenIds = new Set<string>();
  for (const step of steps) {
    if (seenStepIds.has(step.stepId)) {
      throw badRequest(`resume reset duplicate stepId: ${step.stepId}`);
    }
    if (seenIds.has(step.id)) {
      throw badRequest(`resume reset duplicate step run id: ${step.id}`);
    }
    seenStepIds.add(step.stepId);
    seenIds.add(step.id);
    if (step.workflowRunId !== input.workflowRunId) {
      throw badRequest(`resume reset step ${step.id} belongs to another workflow run`);
    }
    if (step.status === "completed" || step.status === "running") {
      throw badRequest(`resume reset refuses ${step.status} step run: ${step.id}`);
    }
    if (step.issueId !== null) {
      throw badRequest(`resume reset refuses step run with issue binding: ${step.id}`);
    }
    if (!isSafeNonNegative(step.executionGeneration) || step.executionGeneration + 1 > PG_INT_MAX) {
      throw badRequest(`resume reset unsafe executionGeneration on step run: ${step.id}`);
    }
    if (!isSafeNonNegative(step.statusTransitionVersion) || step.statusTransitionVersion + 1 > PG_INT_MAX) {
      throw badRequest(`resume reset unsafe statusTransitionVersion on step run: ${step.id}`);
    }
  }
}

/**
 * [목적] 잠긴 step_run 행들을 resume pending 상태로 리셋하고 stepId → 새 generation 매핑을 반환.
 * [입력] caller tx 와 serialization 이 공급한 locked steps. [출력] Record<stepId, newGeneration>.
 * [주의] CAS 불일치는 conflict — caller 가 트랜잭션 전체를 롤백해야 한다. 정책 증명이 아니다.
 *   반환 map 은 Object.fromEntries 로 own key 만 생성한다. stepId 는 임의 TEXT 계약이므로
 *   "__proto__"/"constructor" 도 유효한 shared contract key 이며 prototype setter 로 유실되면 안 된다.
 */
export async function resetForResume(
  tx: ResumeMutationTransaction,
  input: ResetForResumeInput,
): Promise<Record<string, number>> {
  validateResetInput(input);
  const appliedEntries: Array<[string, number]> = [];
  for (const step of input.steps) {
    const nextGeneration = step.executionGeneration + 1;
    const nextTransitionVersion = step.statusTransitionVersion + 1;
    const metadata = normalizedMetadata(step);
    for (const key of RESUME_METADATA_RESET_ALLOWLIST) delete metadata[key];
    metadata.resumeRequestId = input.requestId;
    const updated = await tx.update(workflowStepRuns).set({
      status: "pending",
      startedAt: null,
      completedAt: null,
      dispatchOwnerWakeupRequestId: null,
      dispatchOwnerHeartbeatRunId: null,
      evidenceReadyAt: null,
      dispatchReadyAt: null,
      sessionId: null,
      lastDispatchAttemptAt: null,
      lastDispatchAcceptedAt: null,
      lastDispatchErrorAt: null,
      lastDispatchErrorSummary: null,
      lastDispatchRequestId: null,
      executionGeneration: nextGeneration,
      statusTransitionVersion: nextTransitionVersion,
      metadata,
    }).where(and(
      eq(workflowStepRuns.id, step.id),
      eq(workflowStepRuns.workflowRunId, input.workflowRunId),
      eq(workflowStepRuns.executionGeneration, step.executionGeneration),
      eq(workflowStepRuns.statusTransitionVersion, step.statusTransitionVersion),
      eq(workflowStepRuns.status, step.status),
    )).returning({ id: workflowStepRuns.id });
    if (updated.length !== 1) {
      throw conflict(`resume reset CAS lost for step run: ${step.id}`);
    }
    await supersedeWorkflowDelegationsForGeneration(tx, {
      workflowRunId: input.workflowRunId,
      workflowStepRunId: step.id,
      executionGeneration: step.executionGeneration,
      now: input.now,
    });
    await appendWorkflowAuthorityTransition(tx, {
      companyId: input.companyId,
      workflowRunId: input.workflowRunId,
      workflowStepRunId: step.id,
      executionGeneration: nextGeneration,
      reason: "workflow_resume_reset",
      idempotencyKey: `resume:${input.requestId}:${step.id}:${nextGeneration}`,
      payload: {
        resumeRequestId: input.requestId,
        previousGeneration: step.executionGeneration,
      },
    });
    appliedEntries.push([step.stepId, nextGeneration]);
  }
  return Object.fromEntries(appliedEntries);
}
