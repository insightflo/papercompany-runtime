// server/src/services/workflow/workflow-child-settlement-support.ts
//
// [purpose] r8 finding 2+4 — 정산 writer 의 공유 지원 계층. (1) tombstone 잠금 헬퍼(P→I→S,
// child NULL 재검증), (2) 법정 종말 자식 판정/designated 불량 분류(영수증·임대 규칙, 유한 사유
// 3종, 우선순위 고정), (3) 구조화 거부 감사 기록. 정산은 admission/정의 변경을 만들지 않으므로
// 정의 잠금이 없다 — P/I/S/C 행 잠금이 권위 직렬화 전부다(설계 r8 §2). writers 트랜잭션은
// 이 모듈의 헬퍼로 구성해 파일 크기 한도를 지킨다.
// [authority] 내구 레코드만이 권위(규칙 7/8). 분류는 잠금 하 최신 행으로, 최종 UPDATE 가 같은
// 법정 술어를 재평가한다(분류 후 상태 변경 방어).
import { and, eq, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import {
  workflowRuns,
  workflowStepInvocations,
  workflowStepRuns,
} from "@paperclipai/db";
import { logActivity } from "../activity-log.js";
import { syncWorkflowRunState } from "./dag-engine.js";
import { recordWorkflowStepStatusTransition } from "./workflow-sync-source.js";
import type {
  WorkflowChildIdentity,
  WorkflowChildTombstoneIdentity,
} from "./workflow-child-start-predicates.js";
import {
  baseIdPredicate,
  currentPredicate,
} from "./workflow-child-start-predicates.js";
import { withLockedChildStartIdentity } from "./workflow-child-start-state.js";

export type { LockedChildStartContext } from "./workflow-child-start-state.js";

/** [r8 §4] 불법 종말 초기화 상태의 유한 사유 — 우선순위 고정(설계 지정 순서). */
export type WorkflowChildInvalidTerminalReason =
  | "completed_without_materialization_receipt"
  | "terminal_child_has_start_lease"
  | "child_steps_without_materialization_receipt";

/** [r8 §4] invalid-state 결과 — code/version 고정, reason 은 유한 집합이다. */
export type InvalidSettlementState = {
  outcome: "invalid-state";
  code: "workflow_child_invalid_state";
  version: 1;
  reason: WorkflowChildInvalidTerminalReason;
};

/**
 * [r8 §4] 법정 종말 자식 SQL 조각 — 완료는 영수증 필요(빈 정의 포함), 실패/취소/aborted/
 * timed-out 은 스텝 행 0일 때만 무영수증 허용. 잔여 토큰/임대 쌍이 있는 종말은 불법이고
 * 스텝 행+무영수증도 불법이다. 수리(영수증 합성/임대 정리)는 하지 않는다.
 */
export function legalTerminalChildPredicate(t: { child: typeof workflowRuns }): SQL {
  return sql`(${t.child}.child_start_token is null
    and ${t.child}.child_start_lease_expires_at is null
    and (${t.child}.child_start_materialized_at is not null
      or (${t.child}.status <> 'completed'
        and not exists (
          select 1 from workflow_step_runs cs where cs.workflow_run_id = ${t.child}.id))))`;
}

/**
 * [r8 §4] 잠금 하 최신 종말 자식의 불법 초기화 상태 분류 — 결정적 우선순위(completed 무영수증
 * → 임대 쌍 존재 → 스텝 행+무영수증). 법정이면 null. 비종말 자식은 이 분류 대상이 아니다
 * (호출자가 no-op 로 처리). 실패 초기화(무영수증+행 0)는 불법이 아니다(법정 종말).
 */
export function classifyIllegalTerminalChild(child: {
  status: string;
  childStartToken: string | null;
  childStartLeaseExpiresAt: Date | null;
  childStartMaterializedAt: Date | null;
}, childStepRowCount: number): WorkflowChildInvalidTerminalReason | null {
  const terminal = ["completed", "failed", "cancelled", "aborted", "timed-out"]
    .includes(child.status);
  if (!terminal) return null;
  if (child.status === "completed" && child.childStartMaterializedAt === null) {
    return "completed_without_materialization_receipt";
  }
  if (child.childStartToken !== null || child.childStartLeaseExpiresAt !== null) {
    return "terminal_child_has_start_lease";
  }
  if (child.childStartMaterializedAt === null && childStepRowCount > 0) {
    return "child_steps_without_materialization_receipt";
  }
  return null;
}

/** 잠금 하 자식 스텝 행 수 — 분류 입력(DB count, 파라미터 바인딩). */
export async function countChildStepRows(db: Db, childRunId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, childRunId));
  return row?.count ?? 0;
}

/**
 * [r8 §2] 구조화 거부 감사 — 검증된 잠금 신원에서 company/child 를 유래시킨다(호출자 입력
 * 무권위). 1회 호출당 1건이면 충분하다(dedupe/복구 기계 없음). 실패해도 거부 결과를 대체하지
 * 못하게 호출부가 best-effort 로 감싼다.
 */
export async function recordCompletionRefusalActivity(
  db: Db,
  identity: WorkflowChildIdentity,
  reason: WorkflowChildInvalidTerminalReason,
): Promise<void> {
  await logActivity(db, {
    companyId: identity.companyId,
    actorType: "system",
    actorId: "workflow-step",
    action: "workflow_child.completion_refused_invalid_state",
    entityType: "workflow_run",
    entityId: identity.childRunId,
    details: {
      version: 1,
      code: "workflow_child_invalid_state",
      reason,
      parentRunId: identity.parentRunId,
      parentStepRunId: identity.parentStepRunId,
      invocationId: identity.invocationId,
    },
  });
}

/**
 * [r8 §2] tombstone 잠금 헬퍼 — P→I→S 순 행 잠금 후 기대 신원/linked/child NULL 을 재검증한다.
 * linked 정산과 달리 C 가 없으므로 C 잠금은 없다. 하나라도 어긋나면 null(fail-closed, no-op).
 */
export async function withLockedTombstoneIdentity(
  tx: Db,
  identity: WorkflowChildTombstoneIdentity,
): Promise<{
  parent: typeof workflowRuns.$inferSelect;
  invocation: typeof workflowStepInvocations.$inferSelect;
  parentStep: typeof workflowStepRuns.$inferSelect;
} | null> {
  await tx.execute(sql`select set_config('lock_timeout', '500ms', true), set_config('statement_timeout', '5s', true)`);
  const [parent] = await tx
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, identity.parentRunId))
    .for("update")
    .limit(1);
  if (!parent || parent.companyId !== identity.companyId) return null;
  const [invocation] = await tx
    .select()
    .from(workflowStepInvocations)
    .where(eq(workflowStepInvocations.id, identity.invocationId))
    .for("update")
    .limit(1);
  if (!invocation || invocation.companyId !== identity.companyId) return null;
  if (invocation.state !== "linked" || invocation.childRunId !== null) return null;
  if (invocation.generation !== identity.generation || identity.generation !== 1) return null;
  const [parentStep] = await tx
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.id, identity.parentStepRunId))
    .for("update")
    .limit(1);
  if (!parentStep || parentStep.workflowRunId !== parent.id) return null;
  if (parentStep.stepId !== identity.stepId) return null;
  if (invocation.parentStepRunId !== parentStep.id) return null;
  return { parent, invocation, parentStep };
}

/**
 * linked 정산의 P→I→S→C 잠금 + 잠금 하 완전 자격 검증(세대 런타임 재검증 포함, D2).
 * [r9 §2] BASE_ID/CURRENT + S.pending + P running/cancelled + retained target 일치를 모든
 * 잠금 보유 중 한 SELECT 로 검증한다 — 자격 상실은 분류 "이전"에 null(구조화 no-op)이다.
 * 영수증/임대 법정성은 의도적으로 제외한다: 자격 있는 오염을 no-op 으로 숨기지 않기 위해 —
 * 그것은 invalid-state 분류의 소관이다. 공유 시작/직접취소 잠금 헬퍼는 허용 P/S 상태가
 * 다르므로 절대 변경하지 않는다.
 */
export async function lockLinkedSettlementIdentity(
  tx: Db,
  identity: WorkflowChildIdentity,
): Promise<Awaited<ReturnType<typeof withLockedChildStartIdentity>>> {
  if (identity.generation !== 1) return null;
  const ctx = await withLockedChildStartIdentity(tx, identity);
  if (!ctx) return null;
  const t = {
    parent: alias(workflowRuns, "wse_parent") as unknown as typeof workflowRuns,
    invocation: workflowStepInvocations,
    parentStep: workflowStepRuns,
    child: alias(workflowRuns, "wse_child") as unknown as typeof workflowRuns,
  };
  const rows = await tx.execute(sql`
    select 1
    from workflow_runs ${t.parent}, workflow_step_invocations ${t.invocation},
         workflow_step_runs ${t.parentStep}, workflow_runs ${t.child}
    where ${baseIdPredicate(t, identity)}
      and ${currentPredicate(t)}
      and ${t.parentStep}.status = 'pending'
      and ${t.parent}.status in ('running', 'cancelled')
      and ${t.child}.workflow_id = ${t.invocation}.target_workflow_id
    limit 1`);
  if (rows.length === 0) return null;
  return ctx;
}

export type SettlementWinner = {
  stepRunId: string;
  toStatus: string;
  transitionVersion: number | null;
  issueId: string | null;
  runId: string;
  companyId: string;
  missionId: string | null;
};

/** 트랜잭션 결과 — winner 는 커밋 "이후" 기록된다(잠금 보유 중 외부 콜백 금지, r8 §2). */
export type SettlementTxResult =
  | { outcome: "no-op" }
  | { refusal: WorkflowChildInvalidTerminalReason }
  | { winner: SettlementWinner };

/** 승자 RETURNING → 전이 기록 + run 동기화(company/transition 은 RETURNING 에서 유래). */
export async function recordSettlementWin(db: Db, winner: SettlementWinner): Promise<void> {
  await recordWorkflowStepStatusTransition(db, {
    companyId: winner.companyId,
    missionId: winner.missionId,
    workflowRunId: winner.runId,
    workflowStepRunId: winner.stepRunId,
    issueId: winner.issueId,
    fromStatus: "pending",
    toStatus: winner.toStatus,
    source: "workflow_tool_result",
    transitionVersion: winner.transitionVersion,
  });
  await syncWorkflowRunState(db, winner.runId, "workflow_tool_result");
}
