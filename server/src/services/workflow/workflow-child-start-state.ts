// server/src/services/workflow/workflow-child-start-state.ts
//
// [purpose] workflow→workflow 자식 초기화의 공유 잠금/신원 검증 모듈(fix4 §2.1).
//   부모 run → invocation → 부모 step-run → 자식 run 순 행 잠금 하에서 회사/링크/세대 정합을
//   검증하고, 시작 허용 조건(parentPermitsStart)을 제공한다. 모든 신규 자식 초기화/보호 취소/
//   소유자 실패 트랜잭션이 이 순서와 술어를 공유한다(규칙 7/8 — 내구 레코드만이 권위).
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  workflowRuns,
  workflowStepInvocations,
  workflowStepRuns,
} from "@paperclipai/db";

/** 자식 초기화 신원 — 호출자가 먼저 발견하더라도 변경 전 잠금 하에 재적재/재검증해야 한다. */
export type ChildStartIdentity = {
  companyId: string;
  parentRunId: string;
  parentStepRunId: string;
  invocationId: string;
  generation: number;
  childRunId: string;
};

/** fix4 §2.2 — 자식 시작 fence (자동/수동 의도 포함). */
export type ChildStartFence = {
  identity: ChildStartIdentity;
  token: string;
  intent: "automatic" | "manual-resume";
};

export type LockedChildStartContext = {
  parent: typeof workflowRuns.$inferSelect;
  invocation: typeof workflowStepInvocations.$inferSelect;
  parentStep: typeof workflowStepRuns.$inferSelect;
  child: typeof workflowRuns.$inferSelect;
};

/**
 * 공통 잠금 순서(부모 run → invocation → 부모 step-run → 자식 run)로 적재하고
 * 회사/링크/세대/부모 ID 정합을 검증한다. 하나라어도 어긋나면 null(fail-closed).
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
 * [fix4 §2.1] 자식 시작 허용 조건.
 *  arm1: 부모 running + 부모 스텝 pending.
 *  arm2: 부모 running/completed + 요청 wait=false + 부모 스텝 completed(fire-and-forget 채택이
 *        시작 클레임 전에 스텝을 완료하는 정상 경로).
 *  양쪽 모두 현재 시도 정합(retryCount+1=generation)과 retry 미대기를 요구한다.
 */
export function parentPermitsStart(
  parent: { status: string },
  parentStep: { status: string; retryCount: number; metadata: unknown },
  invocation: { generation: number; wait: boolean },
): boolean {
  const retryState = readRetryState(parentStep.metadata);
  const attemptCurrent = parentStep.retryCount + 1 === invocation.generation;
  if (!attemptCurrent || retryState === "waiting") return false;
  if (parent.status === "running" && parentStep.status === "pending") return true;
  if (
    (parent.status === "running" || parent.status === "completed")
    && invocation.wait === false
    && parentStep.status === "completed"
  ) {
    return true;
  }
  return false;
}

function readRetryState(metadata: unknown): string {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return "";
  const retry = (metadata as Record<string, unknown>).workflowRetry;
  if (!retry || typeof retry !== "object" || Array.isArray(retry)) return "";
  const state = (retry as Record<string, unknown>).state;
  return typeof state === "string" ? state : "";
}

/** 자식 run 이 materialized 되었는가 — 영수증 또는 기존 스텝 행(레거시) 중 하나라도 있으면 참. */
export function isChildMaterialized(
  child: { childStartMaterializedAt: Date | null },
  childStepRowCount: number,
): boolean {
  return child.childStartMaterializedAt !== null || childStepRowCount > 0;
}

/** 공통 잠금 하 현재 시도/부모 허용을 모두 만족하는 시작 가능 상태인지(lease/acquire 공용). */
export function lockedContextPermitsStart(ctx: LockedChildStartContext): boolean {
  return parentPermitsStart(ctx.parent, ctx.parentStep, ctx.invocation);
}

/** 잠금 검증 실패 여부 표준 표시. */
export function describeLockContext(ctx: LockedChildStartContext | null): string {
  return ctx === null ? "locked child identity verification failed" : "verified";
}

/**
 * run id 로 연결된 자식 시작 신원을 발견한다(잠금 없는 1차 발견 — 변경 전 재검증 필수).
 * run 이 링크된 자식이 아니면 null(비자식 실행 경로).
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
  return {
    identity: {
      companyId: child.companyId,
      parentRunId: child.parentRunId,
      parentStepRunId: child.parentStepRunId,
      invocationId: invocation.id,
      generation: invocation.generation,
      childRunId: child.id,
    },
    childStatus: child.status,
    materializedAt: child.childStartMaterializedAt,
  };
}

/**
 * [fix4 §3] 죽은 부모 fence 하 취소 행 점유 — 공통 잠금 순서로 죽은 부모 술어와 링크/회사
 * 정합을 재검증하고 자식을 cancelled 로 전환한다(토큰/임대 정리 포함). 0행이면 호출자가
 * cleanup 없이 false 를 반환한다. 반환 shape 은 cancelWorkflowRunWithCleanup 의 기존 계약.
 */
export async function claimCancelledChildRunWithParentFence(
  db: Db,
  input: {
    childRunId: string;
    companyId: string;
    fence: { invocationId: string; generation: number; parentRunId: string; parentStepRunId: string };
  },
): Promise<Array<{ id: string; companyId: string; missionId: string | null }>> {
  return await db.transaction(async (tx) => {
    const ctx = await withLockedChildStartIdentity(tx as unknown as Db, {
      companyId: input.companyId,
      parentRunId: input.fence.parentRunId,
      parentStepRunId: input.fence.parentStepRunId,
      invocationId: input.fence.invocationId,
      generation: input.fence.generation,
      childRunId: input.childRunId,
    });
    if (!ctx) return [];
    const parentDead = ["failed", "cancelled", "aborted", "timed-out"].includes(ctx.parent.status)
      || (ctx.parent.status === "completed" && ctx.invocation.wait === true);
    if (!parentDead) return [];
    if (TERMINAL_CHILD_STATUSES.includes(ctx.child.status)) return [];
    return await tx
      .update(workflowRuns)
      .set({
        status: "cancelled",
        completedAt: new Date(),
        childStartToken: null,
        childStartLeaseExpiresAt: null,
      })
      .where(and(
        eq(workflowRuns.id, ctx.child.id),
        sql`${workflowRuns.status} not in ('completed', 'cancelled', 'aborted', 'failed', 'timed-out')`,
      ))
      .returning({ id: workflowRuns.id, companyId: workflowRuns.companyId, missionId: workflowRuns.missionId });
  });
}

const TERMINAL_CHILD_STATUSES = ["completed", "cancelled", "aborted", "failed", "timed-out"];
