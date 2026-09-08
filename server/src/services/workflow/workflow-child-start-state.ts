// server/src/services/workflow/workflow-child-start-state.ts
//
// [purpose] descope v1(설계 §2/§3) workflow→workflow 자식 초기화의 공유 잠금/신원 검증 모듈.
//   부모 run → invocation → 부모 step-run → 자식 run 순 행 잠금 하에서 회사/링크/스텝/세대 정합을
//   검증하고, 합법 시작 조건(부모 running + 스텝 pending + CURRENT)과 죽은 부모(DEAD) fence 취소를
//   제공한다. 수동 resume/수동 임대 의도와 fire-and-forget(wait:false) 팔은 삭제됐다(D1/D3) —
//   합법 시작은 자동 하나뿐이다.
// [authority] 내구 레코드만이 권위(규칙 7/8/9). 최종 변이는 잠금 하 최종 UPDATE 의 술어로 판정한다.
import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import {
  workflowRuns,
  workflowStepInvocations,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  WORKFLOW_CHILD_TERMINAL_RUN_STATUSES_SQL,
  deadPredicate,
  type WorkflowChildIdentity,
} from "./workflow-child-start-predicates.js";

/**
 * 자식 초기화 신원(설계 §3 B). 발견용 stepId 를 포함한 완전 신원이다. 호출자가 먼저 발견하더라도
 * 변경 전 잠금 하에 재적재/재검증해야 한다. generation 은 타입 수준에서 number — 모든 진입점이
 * ===1 임을 검증한 뒤 완전 바운드 B 로 쓴다(D2 — 세대는 신원 확인이지 재시도 능력이 아니다).
 */
export type ChildStartIdentity = {
  companyId: string;
  parentRunId: string;
  parentStepRunId: string;
  stepId: string;
  invocationId: string;
  generation: number;
  childRunId: string;
};

/** 자식 시작 fence — 소유 토큰과 완전 신원만 운반한다. 수동/자동 intent 는 삭제됐다(D3). */
export type ChildStartFence = {
  identity: ChildStartIdentity;
  token: string;
};

export type LockedChildStartContext = {
  parent: typeof workflowRuns.$inferSelect;
  invocation: typeof workflowStepInvocations.$inferSelect;
  parentStep: typeof workflowStepRuns.$inferSelect;
  child: typeof workflowRuns.$inferSelect;
};

/**
 * 공통 잠금 순서(부모 run → invocation → 부모 step-run → 자식 run)로 적재하고
 * 회사/링크/스텝 ID/세대/부모 정합(BASE_ID + stepId)을 검증한다. 하나라도 어긋나면 null(fail-closed).
 * 트랜잭션 시작 시 lock_timeout/statement_timeout을 설정한다(경합은 재시도 가능한 skip).
 */
export async function withLockedChildStartIdentity(
  tx: Db,
  identity: ChildStartIdentity,
): Promise<LockedChildStartContext | null> {
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
  const [parentStep] = await tx
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.id, identity.parentStepRunId))
    .for("update")
    .limit(1);
  if (!parentStep || parentStep.workflowRunId !== parent.id) return null;
  // [D5] 같은 회사의 다른 부모/스텝 치환도 회사 치환만큼 무효다 — 논리 스텝 ID 까지 검증한다.
  if (parentStep.stepId !== identity.stepId) return null;
  if (invocation.parentStepRunId !== parentStep.id) return null;
  const [child] = await tx
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, identity.childRunId))
    .for("update")
    .limit(1);
  if (!child || child.companyId !== identity.companyId) return null;
  if (invocation.childRunId !== child.id || invocation.state !== "linked") return null;
  if (invocation.generation !== identity.generation) return null;
  if (child.parentRunId !== parent.id || child.parentStepRunId !== parentStep.id) return null;
  return { parent, invocation, parentStep, child };
}

/**
 * [descope D1/D2/D3] 합법 자식 시작 조건 — 부모 running + 부모 스텝 pending + retryCount 0 +
 * workflowRetry 키 부재(null/불량 포함) + invocation 세대 1. fire-and-forget(wait:false) 팔과
 * retry 대기 검사는 설계 §4 에 따라 삭제됐다. 결과가 거짓이면 시작 변이가 없어야 한다.
 */
export function parentPermitsStart(
  parent: { status: string },
  parentStep: { status: string; retryCount: number; metadata: unknown },
  invocation: { generation: number },
): boolean {
  if (parent.status !== "running" || parentStep.status !== "pending") return false;
  if (parentStep.retryCount !== 0) return false;
  if (hasWorkflowRetryKey(parentStep.metadata)) return false;
  return invocation.generation === 1;
}

/** workflowRetry 키 존재 — 값이 null/불량이어도 "키가 있으면" 위반이다(D2.3, null-safe). */
function hasWorkflowRetryKey(metadata: unknown): boolean {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  return Object.prototype.hasOwnProperty.call(metadata, "workflowRetry");
}

/**
 * run id 로 연결된 자식 시작 신원을 발견한다(잠금 없는 읽기 전용 1차 발견 — 변경 전 재검증 필수).
 * 부모 스텝 행과 조인해 stepId 를 포함한 완전 신원을 반환한다. run 이 링크된 자식이 아니면
 * null(비자식 실행 경로). 수리(claimed→linked 복구)는 존재하지 않는다(D3).
 */
export async function findChildStartIdentityForRun(
  db: Db,
  runId: string,
): Promise<{ identity: ChildStartIdentity; childStatus: string; materializedAt: Date | null } | null> {
  const [child] = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .limit(1);
  if (!child) return null;
  const [invocation] = await db
    .select()
    .from(workflowStepInvocations)
    .where(and(
      eq(workflowStepInvocations.childRunId, child.id),
      eq(workflowStepInvocations.state, "linked"),
    ))
    .limit(1);
  if (!invocation) return null;
  if (!child.parentRunId || !child.parentStepRunId) return null;
  const [parentStep] = await db
    .select({ stepId: workflowStepRuns.stepId })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.id, child.parentStepRunId))
    .limit(1);
  if (!parentStep) return null;
  return {
    identity: {
      companyId: child.companyId,
      parentRunId: child.parentRunId,
      parentStepRunId: child.parentStepRunId,
      stepId: parentStep.stepId,
      invocationId: invocation.id,
      generation: invocation.generation,
      childRunId: child.id,
    },
    childStatus: child.status,
    materializedAt: child.childStartMaterializedAt,
  };
}

/**
 * [fix4 §3, descope §4] 죽은 부모(DEAD) fence 하 취소 — 전파 정산(propagated cleanup) 소관.
 * 공통 잠금 순서로 신원을 재적재하고, 최종 UPDATE 의 WHERE 에서 BASE_ID+CURRENT+DEAD(완료 부모
 * 포함)+비종말 자식을 재평가한다. 완료된 부모도 죽은 부모다(wait 분기는 삭제됐다, D1). 0행이면
 * 호출자가 cleanup 없이 false 를 반환한다. 반환 shape 은 cancelWorkflowRunWithCleanup 의 기존 계약.
 */
export async function claimCancelledChildRunWithParentFence(
  db: Db,
  input: {
    childRunId: string;
    companyId: string;
    fence: { invocationId: string; generation: number; parentRunId: string; parentStepRunId: string };
  },
): Promise<Array<{ id: string; companyId: string; missionId: string | null }>> {
  // step_id 는 불변 컬럼 — 잠금 전 선읽기로 완전 신원(B)을 구성해도 시효(staleness)가 없다.
  const [stepRef] = await db
    .select({ stepId: workflowStepRuns.stepId })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.id, input.fence.parentStepRunId))
    .limit(1);
  if (!stepRef) return [];
  const identity: ChildStartIdentity = {
    companyId: input.companyId,
    parentRunId: input.fence.parentRunId,
    parentStepRunId: input.fence.parentStepRunId,
    stepId: stepRef.stepId,
    invocationId: input.fence.invocationId,
    generation: input.fence.generation,
    childRunId: input.childRunId,
  };
  // [D2] 구세대 신원은 CURRENT/DEAD 술어가 거부한다 — 진입점에서 먼저 거부한다(fail-closed).
  if (identity.generation !== 1) return [];
  return await db.transaction(async (tx) => {
    const ctx = await withLockedChildStartIdentity(tx as unknown as Db, identity);
    if (!ctx) return [];
    if (TERMINAL_CHILD_STATUSES.includes(ctx.child.status)) return [];
    const bound = identityBound(identity);
    return await tx
      .update(workflowRuns)
      .set({
        status: "cancelled",
        completedAt: sql`clock_timestamp()`,
        childStartToken: null,
        childStartLeaseExpiresAt: null,
      })
      .where(and(
        eq(workflowRuns.id, ctx.child.id),
        eq(workflowRuns.companyId, identity.companyId),
        // [D5] 최종 변이의 WHERE 가 완전 신원 + DEAD + 비종말 자식을 잠금 하 재평가한다.
        sql`exists (select 1
          from workflow_runs ${CANCEL_TABLES.parent}, workflow_step_invocations ${CANCEL_TABLES.invocation}, workflow_step_runs ${CANCEL_TABLES.parentStep}, workflow_runs ${CANCEL_TABLES.child}
          where ${deadPredicate(CANCEL_TABLES, bound)}
            and ${CANCEL_TABLES.child}.id = workflow_runs.id
            and workflow_runs.status not in ${WORKFLOW_CHILD_TERMINAL_RUN_STATUSES_SQL})`,
      ))
      .returning({ id: workflowRuns.id, companyId: workflowRuns.companyId, missionId: workflowRuns.missionId });
  });
}

const CANCEL_TABLES = {
  parent: alias(workflowRuns, "wcs_parent") as unknown as typeof workflowRuns,
  invocation: workflowStepInvocations,
  parentStep: workflowStepRuns,
  child: alias(workflowRuns, "wcs_child") as unknown as typeof workflowRuns,
} as const;

const TERMINAL_CHILD_STATUSES = ["completed", "cancelled", "aborted", "failed", "timed-out"];

/** ChildStartIdentity(number 세대)를 검증된 완전 바운드 B 로 변환한다(진입점이 ===1 을 보장). */
function identityBound(identity: ChildStartIdentity): WorkflowChildIdentity {
  return { ...identity, generation: 1 };
}
