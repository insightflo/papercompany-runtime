// server/src/services/workflow/workflow-child-reconciler.ts
//
// [purpose] workflow→workflow waiting 스텝 회복 pass(0101, fix round 4 + cycle A §5/§10).
//   후보 선출(workflow-child-recovery-candidates.ts: recoveryKind CASE), 정산 분기
//   (workflow-child-recovery-actions.ts), 오케스트레이션을 분리한다. 모든 액션은 경계에서
//   후보를 재적재(refresh)해 클래스를 재확인하고, 변경 시 1회 재분기한다(재귀 루프 없음).
//   [cycle A §5] refresh 를 먼저 하고 stale fallback 은 없다. 죽은 부모 취소/절대 마감 정산은
//   내구 신원으로 즉시 처리하고, 정의/스텝 해석은 그 이후 필요한 분기에서만 한다.
// [authority] 모든 판정은 구조화 DB 레코드만 읽는다(규칙 7/8).
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepInvocations } from "@paperclipai/db";
import { normalizeWorkflowStepsForExecution } from "./dag-engine.js";
import { repairLegacyChildLink } from "./workflow-child-legacy-link.js";
import {
  dispatchWorkflowChildStepWithOutcome,
} from "./workflow-child-dispatch.js";
import { isWorkflowChildStep } from "./workflow-child-guards.js";
import {
  isAdopted,
  refreshWorkflowChildRecoveryRow,
  selectActionableCandidates,
  type ChildRecoveryRow,
} from "./workflow-child-recovery-candidates.js";
import {
  dispatchLifecycleAction,
  runStartOrResume,
  settleDeletedChildTombstone,
  settleTerminalChild,
} from "./workflow-child-recovery-actions.js";

export type WorkflowChildReconciliationResult = {
  stepRunId: string;
  action: "recovered" | "skipped" | "failed";
  reason: string;
};

/**
 * metadata.workflowChild 대기 중 스텝의 자식이 살아있는(또는 살릴 수 있는) 상태인지.
 * invocation 링크 + 자식 run 행이 존재하면 live — 비종말 실행, 커밋 후 미시작(회복으로 시작
 * 가능), 클레임 후 미 materialized(회복으로 이어받기), 종말-미정산 모두 포함. 링크 NULL(크래시
 * 클레임)이나 삭제(tombstone)는 live 가 아니다.
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

/** waiting 스텝 회복 pass(#208 패턴, recoveryKind 기반 actionable 선출). */
export async function reconcileWorkflowChildStepWaits(
  db: Db,
  options: { now?: Date; olderThanMs?: number; limit?: number } = {},
): Promise<WorkflowChildReconciliationResult[]> {
  // olderThanMs 는 하위 호환용으로 수용만 한다 — 즉시 actionable 상태는 나이 불문이며,
  // 새 클레임 임대 만료는 DB 시계 기준 별도 관리다(fix4 §2.2).
  const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
  const now = options.now ?? new Date();

  const candidates = await selectActionableCandidates(db, limit);

  const results: WorkflowChildReconciliationResult[] = [];
  for (const candidate of candidates) {
    results.push(...(await reconcileSingleCandidate(db, candidate, now)));
  }
  return results;
}

/** 후보 1건 처리 — stale fallback 없이 refresh 를 먼저 하고(cycle A §5), 클래스별로 1회 재분기한다. */
async function reconcileSingleCandidate(
  db: Db,
  candidate: ChildRecoveryRow,
  now: Date,
): Promise<WorkflowChildReconciliationResult[]> {
  try {
    // [cycle A §5] refresh 가 1차 — null 이면 stale 후보로 쓰지 않는다("더 이상 actionable 없음").
    let row = await refreshWorkflowChildRecoveryRow(db, candidate.invocation.id);
    if (!row) {
      return [{ stepRunId: candidate.stepRun.id, action: "skipped", reason: "candidate is no longer actionable" }];
    }
    // [cycle A §10] settle-terminal / start-or-resume 의 coherent claimed+nonnull 영수증은
    //   선택된 뮤테이터 전에 판별자를 수리하고 1회 재적재해 같은 이터레이션에서 진행한다.
    for (let pass = 0; pass < 2; pass += 1) {
      if (!isLegacyRepairableClass(row)) break;
      const repaired = await repairLegacyChildLink(db, {
        companyId: row.run.companyId,
        parentRunId: row.run.id,
        parentStepRunId: row.stepRun.id,
        invocationId: row.invocation.id,
        generation: row.invocation.generation,
        childRunId: row.invocation.childRunId!,
      });
      if (repaired === "ineligible" || repaired === "busy") {
        return [{ stepRunId: row.stepRun.id, action: "skipped", reason: `legacy claimed receipt repair yielded (${repaired})` }];
      }
      const refreshed = await refreshWorkflowChildRecoveryRow(db, row.invocation.id);
      if (!refreshed) {
        // [cycle B §7] 수리 자체가 이 호출의 커밋된 변이다 — 실제 효과를 정확히 보고한다
        //   (무효화되어도 "수리됨"은 유지; 실행 주장은 하지 않는다).
        if (repaired === "linked") {
          return [{ stepRunId: row.stepRun.id, action: "recovered", reason: "legacy link repaired" }];
        }
        return [{ stepRunId: row.stepRun.id, action: "skipped", reason: "legacy repair left the candidate no longer actionable" }];
      }
      row = refreshed;
    }
    return await actOnRefreshedRow(db, row, now);
  } catch (error) {
    return [{
      stepRunId: candidate.stepRun.id,
      action: "failed",
      reason: error instanceof Error ? error.message : String(error),
    }];
  }
}

/** [cycle A §10 + cycle B F4] 판별자 선수리 대상 클래스 — non-null 자식 5개 클래스 전부다.
 *  cancel-dead-parent/expire-start/settle-terminal/start-or-resume/adopt-only 의 coherent
 *  claimed+nonnull 영수증은 선택된 뮤테이터 전에 1회 수리하고 1회 refresh 한다(수리 승자는
 *  고유 변이로 유지). settle-deleted/create-claimed 는 자식이 NULL(tombstone/생성)이므로 대상 아님.
 */
function isLegacyRepairableClass(row: ChildRecoveryRow): boolean {
  return [
    "cancel-dead-parent",
    "expire-start",
    "settle-terminal",
    "start-or-resume",
    "adopt-only",
  ].includes(row.recoveryKind)
    && row.invocation.state === "claimed"
    && row.invocation.childRunId !== null;
}

/** refresh 된 클래스로 1회 분기 — 라이프사이클 먼저, 정의/스텝 해석은 필요한 분기에서만(cycle A §5). */
async function actOnRefreshedRow(
  db: Db,
  row: ChildRecoveryRow,
  now: Date,
): Promise<WorkflowChildReconciliationResult[]> {
  const adopted = isAdopted(row.stepRun, row.invocation);
  // [cycle A §5] 라이프사이클 우선 — 죽은 부모 취소/절대 마감 정산은 내구 신원으로 즉시 처리한다.
  //   뮤테이터가 잠금 하 DEAD / 미 materialized+경과 마감을 재검증하며 정의 해석은 없다.
  const lifecycle = await dispatchLifecycleAction(db, row);
  if (lifecycle) return lifecycle;
  // 라이프사이클 이후에만 정의/스텝을 해석한다 — 정의 삭제는 라이프사이클 정산을 가로막지 않는다.
  if (!row.definition) {
    return [{ stepRunId: row.stepRun.id, action: "skipped", reason: "workflow definition no longer available" }];
  }
  const steps = normalizeWorkflowStepsForExecution(row.definition.stepsJson);
  const step = steps.find((candidateStep) => candidateStep.id === row.stepRun.stepId);
  if (!step || !isWorkflowChildStep(step)) {
    return [{ stepRunId: row.stepRun.id, action: "skipped", reason: "not a workflow-type step" }];
  }
  switch (row.recoveryKind) {
    case "settle-deleted":
      return await settleDeletedChildTombstone(db, row, step.id);
    case "settle-terminal":
      return await settleTerminalChild(db, row, adopted, now);
    case "create-claimed":
      return await dispatchCreateClaimed(db, row, step, now);
    case "start-or-resume":
      return await runStartOrResume(db, row, adopted, now);
    case "adopt-only":
      return await import("./workflow-child-recovery-actions.js").then((m) => m.adoptOnlyRepair(db, row, now));
    default:
      return [{ stepRunId: row.stepRun.id, action: "skipped", reason: "candidate is no longer actionable" }];
  }
}

/** claimed NULL 클레임의 재 dispatch — 원자 클레임 트랜잭션(cap 포함)이 회복/생성을 판정. */
async function dispatchCreateClaimed(
  db: Db,
  row: ChildRecoveryRow,
  step: ReturnType<typeof normalizeWorkflowStepsForExecution>[number],
  now: Date,
): Promise<WorkflowChildReconciliationResult[]> {
  // [cycle A §6] 타입핑 헬퍼 — waiting/skipped 는 진행 없음(recovered 아님), failed 만 실패.
  const outcome = await dispatchWorkflowChildStepWithOutcome(db, {
    run: row.run,
    definition: row.definition!,
    step,
    stepRun: row.stepRun,
    now,
  });
  if (outcome.outcome === "progressed") {
    return [{ stepRunId: row.stepRun.id, action: "recovered", reason: "pending-claim re-dispatched" }];
  }
  if (outcome.outcome === "failed") {
    return [{ stepRunId: row.stepRun.id, action: "failed", reason: "pending-claim re-dispatch failed the step" }];
  }
  return [{ stepRunId: row.stepRun.id, action: "skipped", reason: `pending-claim re-dispatch made no progress (${outcome.outcome})` }];
}
