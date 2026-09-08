// server/src/services/workflow/workflow-child-start-recovery-timeout.ts
//
// [purpose] descope v1(설계 §5) stuck 회복의 링크 자식 분기 전용 모듈. 자체 실패 변이는 없다 —
//   독립 부분 UPDATE/NOT EXISTS 강제 실패 CAS 는 삭제됐고, 마감 경과는 공유 만료 정산자
//   (expireWorkflowChildStart)로, 종말 부모+마감 미경과는 공유 DEAD fence 취소
//   (claimCancelledChildRunWithParentFence)로 위임한다. 커밋된 변이가 있을 때만 "settled" 를
//   보고한다. 무효 신원(구세대/비정합)은 강제 실패하지 않고 skipped 로 양보한다(fail-closed, D2/D3).
//   'native' = 영수증/스텝 행 존재 또는 일반 run → reconciler 의 기존 native liveness 검사로
//   fall through. 'skipped' = 유효 생존 소유자/경합/판단 불가. 모든 시간 판정은 DB clock_timestamp().
// [authority] 내구 레코드만이 권위(규칙 7/8/9). 발견은 읽기 전용이며 수리(claimed 복구)는 없다(D3).
import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepInvocations, workflowStepRuns } from "@paperclipai/db";
import {
  liveOwnerIsTruePredicate,
  type ChildStartTables,
  type WorkflowChildIdentity,
} from "./workflow-child-start-predicates.js";
import {
  type ChildStartIdentity,
  claimCancelledChildRunWithParentFence,
  findChildStartIdentityForRun,
  withLockedChildStartIdentity,
} from "./workflow-child-start-state.js";
import { expireWorkflowChildStart } from "./workflow-child-start-lease.js";
import { isChildStartContention } from "./workflow-child-start-contention.js";

export type ChildStartTimeoutClassification = "native" | "skipped" | "settled";

const TIMEOUT_TABLES: ChildStartTables = {
  parent: alias(workflowRuns, "wct_parent") as unknown as typeof workflowRuns,
  invocation: workflowStepInvocations,
  parentStep: workflowStepRuns,
  child: alias(workflowRuns, "wct_child") as unknown as typeof workflowRuns,
};

/** 잠금 하 분류 결과 — 자체 변이 없이 공유 변이자 위임 여부만 고른다. */
type LockVerdict = "native" | "skip" | "expire" | "dead-parent";

/**
 * stuck run 의 링크 자식 분류(설계 §5). 발견(읽기 전용, 수리 없음) → 공통 잠금 하 신선한
 * 상태/시간/materialization 재판정 → LIVE_OWNER 면제 또는 공유 변이자 위임. 신원이 잠금 사이에
 * 사라지면 오래된 ID 로 쓰지 않고 skipped 로 양보한다. 경합(55P03/40P01/40001)은 정산 근거가
 * 아니므로 skipped 다.
 */
export async function reconcileUnmaterializedChildStartTimeout(
  db: Db,
  input: { childRunId: string; companyId: string; nativeTimeoutCutoff?: Date },
): Promise<ChildStartTimeoutClassification> {
  // [D3] 수리 없는 읽기 전용 발견 — null(일반 run/링크 없음)은 native fall through.
  const detected = await findChildStartIdentityForRun(db, input.childRunId);
  if (!detected) return "native";
  // [D2] 세대 != 1 은 무효 신원 — 강제 실패하지 않고 양보한다.
  if (detected.identity.generation !== 1) return "skipped";
  try {
    const verdict = await classifyUnderLocks(db, detected.identity, input.companyId);
    if (verdict === "expire") {
      // 마감 경과 — 공유 만료 정산자((AUTO OR DEAD)+DB CASE)가 별도 트랜잭션에서 잠금 하
      // 재검증 후 정산한다. 0행(경합/상태 변경)은 settled 이 아니다.
      const expiry = await expireWorkflowChildStart(db, detected.identity);
      return expiry?.settled ? "settled" : "skipped";
    }
    if (verdict === "dead-parent") {
      // 종말 부모(완료 포함) + 마감 미경과 — 공유 DEAD fence 취소로 위임한다.
      const cancelled = await claimCancelledChildRunWithParentFence(db, {
        childRunId: detected.identity.childRunId,
        companyId: detected.identity.companyId,
        fence: {
          invocationId: detected.identity.invocationId,
          generation: detected.identity.generation,
          parentRunId: detected.identity.parentRunId,
          parentStepRunId: detected.identity.parentStepRunId,
        },
      });
      return cancelled.length > 0 ? "settled" : "skipped";
    }
    return verdict === "native" ? "native" : "skipped";
  } catch (error) {
    // [설계 §3] 경합은 정산/실패로 이어지지 않는다 — skipped(안전한 양보).
    if (isChildStartContention(error)) return "skipped";
    throw error;
  }
}

/** 공통 잠금 하 신선한 분류 — 읽기 전용(변이는 공유 변이자가 별도 트랜잭션에서 재검증한다). */
async function classifyUnderLocks(
  db: Db,
  identity: ChildStartIdentity,
  companyId: string,
): Promise<LockVerdict> {
  return await db.transaction(async (tx): Promise<LockVerdict> => {
    const txDb = tx as unknown as Db;
    const ctx = await withLockedChildStartIdentity(txDb, identity);
    if (!ctx) return "skip"; // 발견 후 신원 변경/소실 — 오래된 ID 로 쓰지 않는다.
    if (identity.companyId !== companyId) return "skip"; // 발견과 회사 불일치 — 양보.
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, ctx.child.id));
    // [설계 §5] 영수증/스텝 행 존재 = materialized — native liveness 검사의 소관이다.
    if (ctx.child.childStartMaterializedAt !== null || count > 0) return "native";
    // [설계 §5] 유효한 생존 초기화 소유자(LIVE_OWNER)만 면제한다.
    const t = TIMEOUT_TABLES;
    const [owned] = await txDb
      .select({ owned: liveOwnerIsTruePredicate(t, identityBound(identity)) })
      .from(t.child)
      .innerJoin(t.parent, eq(t.parent.id, t.child.parentRunId))
      .innerJoin(t.invocation, eq(t.invocation.childRunId, t.child.id))
      .innerJoin(t.parentStep, eq(t.parentStep.id, t.invocation.parentStepRunId))
      .where(and(eq(t.child.id, identity.childRunId), eq(t.invocation.id, identity.invocationId)))
      .limit(1);
    if (owned?.owned === true) return "skip";
    // 마감 경과(DB 시계) — 공유 만료 정산자로 위임한다(죽은 부모는 CASE 가 cancelled 로 정산).
    const [deadlineRow] = await txDb
      .select({
        elapsed: sql<boolean>`${workflowRuns.childStartDeadlineAt} is not null
          and ${workflowRuns.childStartDeadlineAt} <= clock_timestamp()`,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, ctx.child.id));
    if (deadlineRow?.elapsed === true) return "expire";
    // 종말 부모(완료 포함) + 마감 미경과 — 공유 DEAD 취소로 위임한다. 생존 부모+마감 미경과는
    // 아직 초기화 창(progress window) 안이다 — 아무 것도 하지 않고 양보한다.
    if (TERMINAL_PARENT_STATUSES.includes(ctx.parent.status)) return "dead-parent";
    return "skip";
  });
}

const TERMINAL_PARENT_STATUSES = ["completed", "cancelled", "aborted", "failed", "timed-out"];

/** ChildStartIdentity(number 세대)를 검증된 완전 바운드 B 로 변환한다(진입점이 ===1 을 보장). */
function identityBound(identity: ChildStartIdentity): WorkflowChildIdentity {
  return { ...identity, generation: 1 };
}
