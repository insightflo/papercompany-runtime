// server/src/services/workflow/workflow-child-recovery-actions.ts
//
// [purpose] descope v1 — workflow→workflow 자식 회복의 상태별 정산 분기 전용 모듈. 수리
//   (legacy repair)와 수동 resume 분기는 삭제됐다(D3/D5). 남는 액션은 세 가지다:
//   - same-child 초기화: 전체 신원 임대 취득(start-lease) 소유자만 — executeWorkflowRunWithStartOutcome
//     경유. unleased 시작 헬퍼는 존재하지 않는다.
//   - adoption: 표시 프로젝션 전용(새 시그니처 — identity + 관측 metadata 스냅숏).
//   - 정산: completion 모듈의 전용 엄격 최종 writer(linked/tombstone)로 위임.
//   "recovered"는 실제 소유 진행(시작/정산)이 커밋됐을 때만 보고한다. HealthyUnadopted 계약:
//   materialized 자식은 실행 재진입/시작 시각 재설정 없이 adoption 표시 복구만 받는다.
// [authority] 모든 판정은 구조화 DB 레코드만 읽는다(규칙 7/8).
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowStepRuns } from "@paperclipai/db";
import { executeWorkflowRunWithStartOutcome } from "./dag-engine.js";
import { failChildStep, runWorkflowChildCompletionHook } from "./workflow-child-completion.js";
import { adoptChildForWaitingStep } from "./workflow-child-execution.js";
import { expireWorkflowChildStart } from "./workflow-child-start-lease.js";
import type { WorkflowChildIdentity } from "./workflow-child-start-predicates.js";
import {
  isAdopted,
  refreshWorkflowChildRecoveryRow,
  type ChildRecoveryRow,
} from "./workflow-child-recovery-candidates.js";
import type { WorkflowChildReconciliationResult } from "./workflow-child-reconciler.js";

/** 후보 행에서 완전 신원 B 를 구성한다(generation 은 선출 단계에서 이미 1로 강제됐다). */
function identityOfRow(row: ChildRecoveryRow): WorkflowChildIdentity {
  if (row.invocation.childRunId === null) {
    throw new Error("child identity requested for a tombstone invocation — fail-closed");
  }
  return {
    companyId: row.run.companyId,
    parentRunId: row.run.id,
    parentStepRunId: row.stepRun.id,
    stepId: row.stepRun.stepId,
    invocationId: row.invocation.id,
    childRunId: row.invocation.childRunId,
    generation: 1,
  };
}

/** adoption 을 원자 복구한다(표시 프로젝션 전용) — 관측 metadata 는 직전에 재적재한다. */
async function repairAdoption(db: Db, row: ChildRecoveryRow, now: Date): Promise<boolean> {
  const [fresh] = await db
    .select({ metadata: workflowStepRuns.metadata })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.id, row.stepRun.id))
    .limit(1);
  return await adoptChildForWaitingStep(db, {
    identity: identityOfRow(row),
    observedMetadata: fresh?.metadata ?? null,
    now,
  });
}

/**
 * 라이프사이클 우선 분기 — 죽은 부모 취소/절대 마감 정산. 뮤테이터가 잠금 하 DEAD/경과 마감을
 * 재검증하며 정의/입양/스텝 해석은 하지 않는다. 대상 클래스가 아니면 null(호출자가 다음 분기).
 */
export async function dispatchLifecycleAction(
  db: Db,
  row: ChildRecoveryRow,
): Promise<WorkflowChildReconciliationResult[] | null> {
  if (row.recoveryKind === "cancel-dead-parent") {
    // DEAD 부모의 linked 자식 — 전체 신원 fence 하 취소(dag-engine 공유 취소 헬퍼).
    const { cancelWorkflowRunWithCleanup } = await import("./dag-engine.js");
    const cancelled = await cancelWorkflowRunWithCleanup(db, row.invocation.childRunId!, row.run.companyId, {
      childParentFence: {
        invocationId: row.invocation.id,
        generation: 1,
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
    // (AUTO OR DEAD) + U + 경과 마감 — 공유 만료 뮤테이터가 잠금 하 재검증한다.
    const expired = await expireWorkflowChildStart(db, identityOfRow(row));
    if (!expired?.settled) {
      return [{ stepRunId: row.stepRun.id, action: "skipped", reason: "start deadline expiry settled by another worker" }];
    }
    // 만료 정산 후 같은 호출에서 completion hook — 종말 자식의 pending 부모 스텝 정산.
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

/** 링크됐던 자식이 삭제된 tombstone — 자식 재생성 없이 tombstone 형 fenced 실패 정산 1회. */
export async function settleDeletedChildTombstone(
  db: Db,
  row: ChildRecoveryRow,
): Promise<WorkflowChildReconciliationResult[]> {
  const settled = await failChildStep(db, {
    companyId: row.run.companyId,
    workflowRunId: row.run.id,
    stepRunId: row.stepRun.id,
    stepId: row.stepRun.stepId,
    errorCode: "child_run_failed",
    detail: "linked child workflow run was deleted",
    tombstone: { invocationId: row.invocation.id, generation: 1 },
  });
  return [{
    stepRunId: row.stepRun.id,
    action: settled.outcome === "settled" ? "recovered" : "skipped",
    reason: settled.outcome === "settled" ? "deleted child tombstone settled child_run_failed" : "deleted child tombstone settlement yielded (no-op)",
  }];
}

/** 종말 자식 정산 — 입양은 정산 조건이 아니다(D5: 표시 프로젝션은 실행 권위가 없다). */
export async function settleTerminalChild(
  db: Db,
  row: ChildRecoveryRow,
  adopted: boolean,
  now: Date,
): Promise<WorkflowChildReconciliationResult[]> {
  if (!adopted) {
    // 표시 프로젝션 복구는 best-effort — 상실해도 정산은 진행한다.
    await repairAdoption(db, row, now);
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
 * same-child 초기화 — 미입양이면 먼저 adoption 표시 복구하고, 성공 후 1회 refresh 한다.
 * refresh 결과: null → skip. adopt-only → adoption 전용 복구. 라이프사이클 클래스 → 재분기.
 * start-unmaterialized 유지 → execute 진입(전체 신원 임대 소유자만 초기화). 그 외 → skip.
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
  const refreshed = await refreshWorkflowChildRecoveryRow(db, row.invocation.id);
  if (!refreshed) {
    return [{ stepRunId: row.stepRun.id, action: "skipped", reason: "start candidate is no longer actionable after adoption repair" }];
  }
  if (refreshed.recoveryKind === "adopt-only") {
    return await adoptOnlyRepair(db, refreshed, now);
  }
  const lifecycle = await dispatchLifecycleAction(db, refreshed);
  if (lifecycle) return lifecycle;
  if (refreshed.recoveryKind !== "start-unmaterialized") {
    return [{
      stepRunId: row.stepRun.id,
      action: "skipped",
      reason: `start candidate changed class after adoption repair (${refreshed.recoveryKind})`,
    }];
  }
  const outcome = await executeWorkflowRunWithStartOutcome(db, row.invocation.childRunId!);
  // recovered 는 이 호출이 시작/정산을 소유했을 때만 — settled(만료 정산 승리)도 소유 정산이다.
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

/** materialized 살아있는 자식의 adoption 전용 복구 — 실행 재진입/시작 시각 변경 없음. */
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
