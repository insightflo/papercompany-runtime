// server/src/services/workflow/workflow-child-reconciler.ts
//
// [purpose] descope v1 — workflow→workflow waiting 스텝 회복 pass. 후보 선출
//   (workflow-child-recovery-candidates.ts: actionable 6계열 + 별도 invalid-state 진단), 정산
//   분기(workflow-child-recovery-actions.ts), 오케스트레이션을 분리한다. 법정 상태(설계 §2 표)
//   만 처리하고, 모든 액션은 경계에서 후보를 재적재(refresh)해 클래스를 재확인한다.
//   invalid-state 진단은 구조화 사유만 남기고 실행 행을 절대 바꾸지 않으며(fail-closed), missing
//   은 plain authorization 이 아니다. 수리/수동 resume 경로는 존재하지 않는다(D3/D5).
// [authority] 모든 판정은 구조화 DB 레코드만 읽는다(규칙 7/8).
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepInvocations } from "@paperclipai/db";
import { normalizeWorkflowStepsForExecution } from "./dag-engine.js";
import { isWorkflowChildStep } from "./workflow-child-guards.js";
import {
  isAdopted,
  refreshWorkflowChildRecoveryRow,
  selectActionableCandidates,
  selectInvalidChildStartDiagnostics,
  type ChildRecoveryRow,
} from "./workflow-child-recovery-candidates.js";
import {
  adoptOnlyRepair,
  dispatchLifecycleAction,
  runStartOrResume,
  settleDeletedChildTombstone,
  settleTerminalChild,
} from "./workflow-child-recovery-actions.js";
import {
  isChildStartContention,
  isChildStartDatabaseTimeout,
} from "./workflow-child-start-contention.js";

export type WorkflowChildReconciliationResult = {
  stepRunId: string;
  action: "recovered" | "skipped" | "failed";
  reason: string;
  /** 기계 판정 코드(선택) — invalid-state 진단 등 구조화 사유. 파싱 권위 아님, 표시/감사용. */
  code?: string;
};

/**
 * metadata.workflowChild 대기 중 스텝의 자식이 살아있는(또는 살릴 수 있는) 상태인지.
 * linked invocation + 자식 run 행이 존재하면 live — 링크 NULL(tombstone)이나 발견 실패는
 * live 가 아니다. missing 은 plain authorization 이 아니다.
 */
export async function hasLiveWorkflowChildWait(
  db: Db,
  stepRun: { id: string; metadata: unknown },
): Promise<boolean> {
  const [invocation] = await db
    .select()
    .from(workflowStepInvocations)
    .where(eq(workflowStepInvocations.parentStepRunId, stepRun.id))
    .limit(1);
  if (!invocation || invocation.childRunId === null) return false;
  const [childRun] = await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, invocation.childRunId))
    .limit(1);
  return Boolean(childRun);
}

/** waiting 스텝 회복 pass — actionable 후보 + 별도 bounded invalid-state 진단. */
export async function reconcileWorkflowChildStepWaits(
  db: Db,
  options: { now?: Date; olderThanMs?: number; limit?: number } = {},
): Promise<WorkflowChildReconciliationResult[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
  const now = options.now ?? new Date();

  const candidates = await selectActionableCandidates(db, limit);
  const results: WorkflowChildReconciliationResult[] = [];
  for (const candidate of candidates) {
    results.push(...(await reconcileSingleCandidate(db, candidate, now)));
  }
  // invalid-state 진단 — bounded keyset pagination 으로 actionable 슬롯과 분리한다. 하나의
  // 비정합 행이 후보 한도를 소모하지 않고, 행은 무변경이다.
  const invalid = await selectInvalidChildStartDiagnostics(db, { limit: Math.min(limit, 10) });
  for (const diagnostic of invalid) {
    results.push({
      stepRunId: diagnostic.parentStepRunId,
      action: "skipped",
      code: diagnostic.reason,
      reason: `invalid_child_start:${diagnostic.reason}`,
    });
  }
  return results;
}

/** 후보 1건 처리 — stale fallback 없이 refresh 를 먼저 하고, 클래스별로 1회 재분기한다. */
async function reconcileSingleCandidate(
  db: Db,
  candidate: ChildRecoveryRow,
  now: Date,
): Promise<WorkflowChildReconciliationResult[]> {
  try {
    // refresh 가 1차 — null 이면 stale 후보로 쓰지 않는다("더 이상 actionable 없음").
    const row = await refreshWorkflowChildRecoveryRow(db, candidate.invocation.id);
    if (!row) {
      return [{ stepRunId: candidate.stepRun.id, action: "skipped", reason: "candidate is no longer actionable" }];
    }
    return await actOnRefreshedRow(db, row, now);
  } catch (error) {
    // [설계 §3] 경합(55P03/40P01/40001)은 실패가 아니다 — bounded skipped, 실행 행 무변경.
    // 57014 는 타임아웃 진단 — 회복/실패 정산 근거 없이 skipped 로 양보한다.
    if (isChildStartContention(error) || isChildStartDatabaseTimeout(error)) {
      return [{
        stepRunId: candidate.stepRun.id,
        action: "skipped",
        reason: "child reconciliation lost a lock race or hit a statement timeout; execution rows unchanged",
      }];
    }
    return [{
      stepRunId: candidate.stepRun.id,
      action: "failed",
      reason: error instanceof Error ? error.message : String(error),
    }];
  }
}

/** refresh 된 클래스로 1회 분기 — 라이프사이클 먼저, 정의/스텝 해석은 필요한 분기에서만. */
async function actOnRefreshedRow(
  db: Db,
  row: ChildRecoveryRow,
  now: Date,
): Promise<WorkflowChildReconciliationResult[]> {
  const adopted = isAdopted(row.stepRun, row.invocation);
  // 라이프사이클 우선 — 죽은 부모 취소/절대 마감 정산은 내구 신원으로 즉시 처리한다.
  const lifecycle = await dispatchLifecycleAction(db, row);
  if (lifecycle) return lifecycle;
  switch (row.recoveryKind) {
    case "tombstone-settle":
      return await settleDeletedChildTombstone(db, row);
    case "terminal-settle":
      return await settleTerminalChild(db, row, adopted, now);
    case "start-unmaterialized": {
      // dispatch 진입만 정의/스텝 해석이 필요하다(정의 삭제는 라이프사이클 정산을 가로막지 않는다).
      if (!row.definition) {
        return [{ stepRunId: row.stepRun.id, action: "skipped", reason: "workflow definition no longer available" }];
      }
      const steps = normalizeWorkflowStepsForExecution(row.definition.stepsJson);
      const step = steps.find((candidateStep) => candidateStep.id === row.stepRun.stepId);
      if (!step || !isWorkflowChildStep(step)) {
        return [{ stepRunId: row.stepRun.id, action: "skipped", code: "not_workflow_type_step", reason: "not a workflow-type step" }];
      }
      return await runStartOrResume(db, row, adopted, now);
    }
    case "adopt-only":
      return await adoptOnlyRepair(db, row, now);
    default:
      return [{ stepRunId: row.stepRun.id, action: "skipped", reason: "candidate is no longer actionable" }];
  }
}
