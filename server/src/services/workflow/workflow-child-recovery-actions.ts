// server/src/services/workflow/workflow-child-recovery-actions.ts
//
// [purpose] workflow→workflow 자식 회복의 상태별 정산 분기 전용 모듈(fix4 §4 + cycle A §5).
//   모든 액션은 실행 권위(임대/소유 토큰/fence)를 스스로 재검증하며, "recovered"는 실제 소유
//   진행(시작/정산/입양 복구)이 확정될 때만 보고한다. HealthyUnadopted 계약: materialized 자식은
//   절대 실행 재진입/시작 시각 재설정 없이 adoption 복구만 받는다.
//   [cycle A §5] runStartOrResume 는 adoption 복구 성공 후 1회 refresh 하고, 변경된 클래스에 따라
//   1회 재분기한다(라이프사이클 뮤테이터/adopt-only/skip) — materialized 로 바뀐 후보는 절대 자동
//   실행 재진입을 받지 않는다.
// [authority] 모든 판정은 구조화 DB 레코드만 읽는다(규칙 7/8).
import type { Db } from "@paperclipai/db";
import { normalizeWorkflowStepsForExecution, executeWorkflowRunWithStartOutcome } from "./dag-engine.js";
import { failChildStep, runWorkflowChildCompletionHook } from "./workflow-child-completion.js";
import { adoptChildForWaitingStep } from "./workflow-child-execution.js";
import { expireWorkflowChildStart } from "./workflow-child-start-lease.js";
import { repairLegacyChildLink } from "./workflow-child-legacy-link.js";
import {
  isAdopted,
  refreshWorkflowChildRecoveryRow,
  type ChildRecoveryRow,
} from "./workflow-child-recovery-candidates.js";
import type { WorkflowChildReconciliationResult } from "./workflow-child-reconciler.js";

/**
 * [cycle B F4] linked-only 잠금 뮤테이터(취소/만료) 외부 진입 레거시 수리 — coherent claimed+nonnull
 *   영수증은 뮤테이터 진입 전에 판별자를 수리한다(DEAD/AUTO 수리 가드는 repairLegacyChildLink 내부).
 *   수리 실패(busy/ineligible)는 "skipped" — 무제한 취소/시작 없이 양보한다. 이미 linked 면 null.
 */
async function repairClaimedReceiptAtMutatorEntry(
  db: Db,
  row: ChildRecoveryRow,
): Promise<"skipped" | null> {
  if (row.invocation.state !== "claimed" || row.invocation.childRunId === null) return null;
  const repaired = await repairLegacyChildLink(db, {
    companyId: row.run.companyId,
    parentRunId: row.run.id,
    parentStepRunId: row.stepRun.id,
    invocationId: row.invocation.id,
    generation: row.invocation.generation,
    childRunId: row.invocation.childRunId,
  });
  return repaired === "busy" || repaired === "ineligible" ? "skipped" : null;
}

/** 요청된 wait 모드(invocation 내구 값)를 반영해 adoption 을 원자 복구한다. */
async function repairAdoption(db: Db, row: ChildRecoveryRow, now: Date): Promise<boolean> {
  const step = normalizeWorkflowStepsForExecution(row.definition!.stepsJson)
    .find((candidate) => candidate.id === row.stepRun.stepId);
  if (!step) return false;
  return await adoptChildForWaitingStep(db, {
    companyId: row.run.companyId,
    run: row.run,
    step,
    stepRun: row.stepRun,
    now,
    // [fix3 P1-1 / fix4 §6] 요청 모드는 invocation 의 내구 컬럼이 권위다(정의 변경 소급 금지).
    wait: row.invocation.wait,
    renderedInputs: {},
    invocationId: row.invocation.id,
    childRunId: row.invocation.childRunId!,
    generation: row.invocation.generation,
  });
}

/**
 * [cycle A §5] 라이프사이클 우선 분기 — 죽은 부모 취소/절대 마감 정산. 뮤테이터가 잠금 하
 * DEAD/미 materialized+경과 마감을 재검증하고, 정의/입양/스텝 해석은 하지 않는다.
 * 대상 클래스가 아니면 null 을 반환한다(호출자가 다음 분기로 진행).
 */
export async function dispatchLifecycleAction(
  db: Db,
  row: ChildRecoveryRow,
): Promise<WorkflowChildReconciliationResult[] | null> {
  if (row.recoveryKind === "cancel-dead-parent") {
    const repair = await repairClaimedReceiptAtMutatorEntry(db, row);
    if (repair) {
      return [{ stepRunId: row.stepRun.id, action: "skipped", reason: `dead-parent legacy receipt repair yielded (${repair})` }];
    }
    const { cancelWorkflowRunWithCleanup } = await import("./dag-engine.js");
    const cancelled = await cancelWorkflowRunWithCleanup(db, row.invocation.childRunId!, row.run.companyId, {
      childParentFence: {
        invocationId: row.invocation.id,
        generation: row.invocation.generation,
        parentRunId: row.run.id,
        parentStepRunId: row.stepRun.id,
      },
    });
    return [{
      stepRunId: row.stepRun.id,
      action: cancelled ? "recovered" : "skipped",
      reason: cancelled ? "dead-parent linked child cancelled before adoption" : "dead-parent child cancellation claimed by another worker",
    }];
  }
  if (row.recoveryKind === "expire-start") {
    const repair = await repairClaimedReceiptAtMutatorEntry(db, row);
    if (repair) {
      return [{ stepRunId: row.stepRun.id, action: "skipped", reason: `start expiry legacy receipt repair yielded (${repair})` }];
    }
    const expired = await expireWorkflowChildStart(db, {
      companyId: row.run.companyId,
      parentRunId: row.run.id,
      parentStepRunId: row.stepRun.id,
      invocationId: row.invocation.id,
      generation: row.invocation.generation,
      childRunId: row.invocation.childRunId!,
    });
    if (!expired?.settled) {
      return [{ stepRunId: row.stepRun.id, action: "skipped", reason: "start deadline expiry settled by another worker" }];
    }
    const completed = await runWorkflowChildCompletionHook(db, {
      id: row.invocation.childRunId!,
      companyId: row.run.companyId,
      status: expired.childStatus,
    });
    return [{
      stepRunId: row.stepRun.id,
      action: "recovered",
      reason: completed ? `start deadline expiry propagated (${expired.childStatus})` : "start deadline expiry settled child only",
    }];
  }
  return null;
}

/** 링크됐던 자식이 삭제된 tombstone — never-created 와 구분해 fenced 실패 정산. */
export async function settleDeletedChildTombstone(
  db: Db,
  row: ChildRecoveryRow,
  stepId: string,
): Promise<WorkflowChildReconciliationResult[]> {
  const settled = await failChildStep(db, {
    companyId: row.run.companyId,
    workflowRunId: row.run.id,
    stepRunId: row.stepRun.id,
    stepId,
    errorCode: "child_run_failed",
    detail: "linked child workflow run was deleted",
    fence: { invocationId: row.invocation.id, generation: row.invocation.generation, childDeleted: true },
  });
  return [{
    stepRunId: row.stepRun.id,
    action: settled ? "recovered" : "skipped",
    reason: settled ? "deleted child tombstone settled child_run_failed" : "deleted child but step not completable",
  }];
}

/** 종말 자식 정산 — 미입양이면 권위 링크로 adoption 복구 후 fenced hook. */
export async function settleTerminalChild(
  db: Db,
  row: ChildRecoveryRow,
  adopted: boolean,
  now: Date,
): Promise<WorkflowChildReconciliationResult[]> {
  if (!adopted) {
    const repaired = await repairAdoption(db, row, now);
    if (!repaired) {
      return [{ stepRunId: row.stepRun.id, action: "skipped", reason: "terminal child adoption repair lost a race" }];
    }
  }
  const completed = await runWorkflowChildCompletionHook(db, {
    id: row.invocation.childRunId!,
    companyId: row.run.companyId,
    status: row.childStatus!,
  });
  return [{
    stepRunId: row.stepRun.id,
    action: completed ? "recovered" : "skipped",
    reason: completed ? `child ${row.childStatus} propagated` : "terminal child but step not completable",
  }];
}

/**
 * 시작/이어받기(fix4 §2.2 + cycle A §5) — 미입양이면 먼저 adoption 복구(내구 wait 모드)하고,
 * 성공 후 1회 refresh 한다. refresh 결과:
 *  - null → 양보(skip). adopt-only → adoption 전용 복구만(실행 재진입 없음).
 *  - cancel-dead-parent / expire-start → 라이프사이클 뮤테이터로 1회 재분기.
 *  - start-or-resume 유지 → execute 진입(임대 소유자만 초기화). 그 외 클래스 → 양보.
 * busy/materialized/expired/ineligible 은 소유자·정산 경로에 양보하는 no-op(스텝 실패 아님).
 */
export async function runStartOrResume(
  db: Db,
  row: ChildRecoveryRow,
  adopted: boolean,
  now: Date,
): Promise<WorkflowChildReconciliationResult[]> {
  if (!adopted) {
    const repaired = await repairAdoption(db, row, now);
    if (!repaired) {
      return [{ stepRunId: row.stepRun.id, action: "skipped", reason: "start candidate adoption repair lost a race" }];
    }
  }
  // [cycle A §5] refresh 자체는 잠금이 아니므로 뮤테이터가 여전히 권위다. 변경된 클래스는 1회만 재분기.
  const refreshed = await refreshWorkflowChildRecoveryRow(db, row.invocation.id);
  if (!refreshed) {
    return [{ stepRunId: row.stepRun.id, action: "skipped", reason: "start candidate is no longer actionable after adoption repair" }];
  }
  if (refreshed.recoveryKind === "adopt-only") {
    return await adoptOnlyRepair(db, refreshed, now);
  }
  const lifecycle = await dispatchLifecycleAction(db, refreshed);
  if (lifecycle) return lifecycle;
  if (refreshed.recoveryKind !== "start-or-resume") {
    return [{
      stepRunId: row.stepRun.id,
      action: "skipped",
      reason: `start candidate changed class after adoption repair (${refreshed.recoveryKind})`,
    }];
  }
  const outcome = await executeWorkflowRunWithStartOutcome(db, row.invocation.childRunId!);
  // [cycle A §7/§8] recovered 는 이 호출이 시작을 소유했을 때만 — settled(만료 정산 승리)도
  //   소유 정산이므로 recovered 다. 그 외는 소유자/정산 경로에 양보한다.
  if (outcome.kind === "started" || outcome.kind === "settled") {
    return [{
      stepRunId: row.stepRun.id,
      action: "recovered",
      reason: outcome.kind === "started"
        ? "recovery won the start lease and initialized the child"
        : "recovery won the deadline expiry settlement for the child",
    }];
  }
  return [{
    stepRunId: row.stepRun.id,
    action: "skipped",
    reason: `start candidate yielded to another owner (${outcome.kind})`,
  }];
}

/** materialized 살아있는 자식의 adoption 전용 복구 — 실행 재진입/시작 시각 변경 없음(fix4 finding 4). */
export async function adoptOnlyRepair(
  db: Db,
  row: ChildRecoveryRow,
  now: Date,
): Promise<WorkflowChildReconciliationResult[]> {
  const repaired = await repairAdoption(db, row, now);
  return [{
    stepRunId: row.stepRun.id,
    action: repaired ? "recovered" : "skipped",
    reason: repaired ? "healthy materialized child re-adopted (adoption only)" : "materialized child adoption lost a race",
  }];
}
