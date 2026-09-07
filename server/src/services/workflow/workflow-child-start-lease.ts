// server/src/services/workflow/workflow-child-start-lease.ts
//
// [purpose] workflow→workflow 자식 초기화 임대 전용 모듈(fix4 §2.2/§3, cycle A §2).
//   - acquireWorkflowChildStartLease: 공통 잠금 하 소유 토큰+60초 임대+5분 불변 마감 획득.
//     materialized 분류가 마감 분류보다 앞서고, 마감 경과는 시도 "전"에 fresh SQL boolean 으로
//     분류하며, 빈 RETURNING 시 잠금 하 마감을 재확인한다. JS Date 비교는 없다(cycle A §2).
//   - expireWorkflowChildStart: 마감 경과된 미 materialized 자식의 절대 마감 정산(죽은 부모 취소/
//     생존 부모 실패) — 자동 재시작 없음. 시간 판정/기록 모두 DB 시계.
//   - hasOwnedWorkflowChildStart: 현재 소유 임대가 살아있는지(stuck pass 조건부 면제용).
//   실행 권위는 내구 레코드(child_start_* 컬럼 + 스텝 행)만으로 판단한다(규칙 7/8).
import { randomUUID } from "node:crypto";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepInvocations, workflowStepRuns } from "@paperclipai/db";
import {
  autoPredicate,
  currentPredicate,
  identityPredicate,
  ownedAutoIsTruePredicate,
  type ChildStartIdentityBound,
  type ChildStartIntent,
  type ChildStartTables,
} from "./workflow-child-start-predicates.js";
import {
  type ChildStartIdentity,
  findChildStartIdentityForRun,
  withLockedChildStartIdentity,
} from "./workflow-child-start-state.js";
import { isChildStartContention } from "./workflow-child-start-contention.js";

export const CHILD_START_LEASE_MS = 60_000;
export const CHILD_START_DEADLINE_MS = 300_000;

export type ChildStartLeaseOutcome =
  | { kind: "owned"; identity: ChildStartIdentity; token: string }
  | { kind: "busy" | "materialized" | "ineligible" | "expired" };

const TERMINAL = ["completed", "cancelled", "aborted", "failed", "timed-out"];

/**
 * 실행 진입 임대 획득 — readiness 이전에 호출되는 유일한 사전 materialization 권위(cycle A §2).
 * 공통 잠금 하 신원/CURRENT와 의도별 자격(자동은 AUTO 술어, 수동은 CURRENT만 — 부모 상태/스텝
 * 상태/retry 대기 우회)을 검증하고, 취소·완료 자식을 거부하며, materialized 분류를 마감 분류보다
 * 먼저 한다. 이미 경과한 마감은 시도 전에 expired 로 분류한다. 자격 있는 미 materialized 자식에만
 * 활성 임대가 없을 때 새 UUID를 발급한다: deadline=coalesce(구값, now+5분, 불연장),
 * expiry=least(now+60초, deadline), status=running, startedAt=coalesce(구값, now). 빈 RETURNING
 * 은 잠금 하 마감 경과 재확인 후에만 busy 가 된다. 시간 권위는 전부 DB clock_timestamp().
 */
export async function acquireWorkflowChildStartLease(
  db: Db,
  identity: ChildStartIdentity,
  options?: { intent?: "automatic" | "manual-resume" },
): Promise<ChildStartLeaseOutcome> {
  const intent: ChildStartIntent = options?.intent ?? "automatic";
  try {
    return await db.transaction(async (tx): Promise<ChildStartLeaseOutcome> => {
    const txDb = tx as unknown as Db;
    const ctx = await withLockedChildStartIdentity(txDb, identity);
    if (!ctx) return { kind: "ineligible" };
    const { child } = ctx;
    // 취소/완료 자식 거부(양 의도 공통 — 완료 부활 금지, 취소 고정). 자동은 failed 등 나머지
    // 종말 상태도 거부하고, 수동은 운영자 복구 대상(failed/running/pending)만 허용한다.
    if (child.status === "cancelled" || child.status === "completed") return { kind: "ineligible" };
    if (intent === "automatic" && TERMINAL.includes(child.status)) return { kind: "ineligible" };
    // [cycle B F1] IDENTITY/CURRENT 는 materialized/deadline 분류와 획득 "이전에" 양 의도 모두
    // 검증한다(수동도 구세대 부활 금지 — AUTO 아닌 CURRENT 만 요구).
    if (!(await intentEligibleFresh(txDb, identity, intent))) return { kind: "ineligible" };
    // [cycle A §2] materialized 분류가 마감 분류보다 먼저 — materialized 자식의 과거 초기화
    // 마감은 native 실행을 지배하지 않는다.
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, child.id));
    if (child.childStartMaterializedAt !== null || count > 0) return { kind: "materialized" };
    // [cycle A §2] 마감 경과 분류를 시도 전에 fresh SQL boolean 으로 수행한다.
    if (await deadlineElapsedFresh(txDb, child.id)) return { kind: "expired" };
    const deadlineInterval = sql`${`${CHILD_START_DEADLINE_MS} milliseconds`}::interval`;
    const claimed = await tx
      .update(workflowRuns)
      .set({
        childStartToken: sql`${randomUUID()}::uuid`,
        childStartDeadlineAt: sql`coalesce(${workflowRuns.childStartDeadlineAt}, clock_timestamp() + ${deadlineInterval})`,
        childStartLeaseExpiresAt: sql`least(clock_timestamp() + ${`${CHILD_START_LEASE_MS} milliseconds`}::interval, coalesce(${workflowRuns.childStartDeadlineAt}, clock_timestamp() + ${deadlineInterval}))`,
        status: "running",
        startedAt: sql`coalesce(${workflowRuns.startedAt}, clock_timestamp())`,
        completedAt: null,
      })
      .where(and(
        eq(workflowRuns.id, child.id),
        eq(workflowRuns.companyId, identity.companyId),
        sql`${workflowRuns.status} ${intent === "automatic" ? sql`in ('pending', 'running')` : sql`not in ('cancelled', 'completed')`}`,
        sql`${workflowRuns.childStartMaterializedAt} is null`,
        sql`not exists (select 1 from workflow_step_runs csr where csr.workflow_run_id = ${child.id})`,
        // 활성 임대가 있으면 발급하지 않는다(소유자 존중).
        sql`(${workflowRuns.childStartToken} is null or ${workflowRuns.childStartLeaseExpiresAt} <= clock_timestamp())`,
        sql`(${workflowRuns.childStartDeadlineAt} is null or ${workflowRuns.childStartDeadlineAt} > clock_timestamp())`,
        sql`exists (select 1
          from workflow_runs ${LEASE_TABLES.parent}, workflow_step_invocations ${LEASE_TABLES.invocation}, workflow_step_runs ${LEASE_TABLES.parentStep}, workflow_runs ${LEASE_TABLES.child}
          where ${intentEligiblePredicate(LEASE_TABLES, boundOf(identity), intent)}
            and ${LEASE_TABLES.child}.id = workflow_runs.id)`,
      ))
      .returning({
        id: workflowRuns.id,
        childStartToken: workflowRuns.childStartToken,
      });
    const row = claimed[0];
    if (!row?.childStartToken) {
      // [cycle A §2] 빈 RETURNING — 잠금 하 마감 경과를 재확인한다(시간은 시도 중에도 흐른다).
      if (await deadlineElapsedFresh(txDb, child.id)) return { kind: "expired" };
      return { kind: "busy" };
    }
    return { kind: "owned", identity, token: row.childStartToken };
    });
  } catch (error) {
    // [cycle A §8] 경합(lock_timeout/deadlock/serialization)은 롤백 후 busy — 실패 정산 아님.
    if (isChildStartContention(error)) return { kind: "busy" };
    throw error;
  }
}

/**
 * [fix4 §3] 절대 마감 정산 — 마감이 경과된 링크된 비종말 미 materialized 자식을 정산한다.
 * 죽은 부모(failed/cancelled/aborted/timed-out)의 자식은 취소, 생존 부모의 자식은 실패
 * (child_start_timeout 구조화 메타데이터). 토큰/임대를 정리하고 마감은 보존한다.
 * 성공 시 커밋 후 호출자가 자식 completion hook 을 발화한다(부모 정산 fence 는 훅 내부).
 * 마감 경과 판정/완료 시각 모두 DB 시계(cycle A §2 — JS Date 비교/기록 금지).
 */
export async function expireWorkflowChildStart(
  db: Db,
  identity: ChildStartIdentity,
): Promise<{ settled: boolean; childStatus: "cancelled" | "failed" } | null> {
  return await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const ctx = await withLockedChildStartIdentity(txDb, identity);
    if (!ctx) return null;
    const { child, parent } = ctx;
    if (TERMINAL.includes(child.status)) return null;
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, child.id));
    if (child.childStartMaterializedAt !== null || count > 0) return null;
    // [cycle A §2] 마감 경과 판정은 잠금 하 fresh SQL boolean 이다.
    if (!(await deadlineElapsedFresh(txDb, child.id))) return null;
    const parentDead = TERMINAL.includes(parent.status) && parent.status !== "completed";
    const nextStatus = parentDead ? "cancelled" : "failed";
    const updated = await tx
      .update(workflowRuns)
      .set({
        status: nextStatus,
        completedAt: sql`clock_timestamp()`,
        childStartToken: null,
        childStartLeaseExpiresAt: null,
        metadata: mergeChildStartFailure(child.metadata, "child_start_timeout"),
      })
      .where(and(
        eq(workflowRuns.id, child.id),
        sql`${workflowRuns.childStartDeadlineAt} is not null and ${workflowRuns.childStartDeadlineAt} <= clock_timestamp()`,
        sql`${workflowRuns.childStartMaterializedAt} is null`,
      ))
      .returning({ id: workflowRuns.id });
    if (updated.length === 0) return null;
    return { settled: true, childStatus: nextStatus };
  });
}

/**
 * [fix4 §3, cycle A §4] 현재 소유 임대가 살아있는지 — stuck 면제 판정. 공통 잠금 + SQL OWNED_AUTO
 * (ownedAutoIsTruePredicate: IDENTITY+CURRENT+running+토큰 존재+미 materialized+임대/마감 미래+AUTO)
 * 로 재작성했다. 부모/회사/링크 불일치, retry 대기, 오래된 세대, 종말 상태, 기존 행/영수증, 경과
 * 시간은 모두 false. [cycle A §4] 별도 잠금 경합 결과가 "소유 아님(false)"으로 위장해 실패 정산을
 * 유발하지 않게 한다 — 경합 시 true(소유 취급 → skipped)를 반환한다. 문서화된 안전 편향이다.
 */
export async function hasOwnedWorkflowChildStart(
  db: Db,
  input: { childRunId: string; companyId: string },
): Promise<boolean> {
  const detected = await findChildStartIdentityForRun(db, input.childRunId);
  if (!detected) return false;
  try {
    return await db.transaction(async (tx): Promise<boolean> => {
      const txDb = tx as unknown as Db;
      const ctx = await withLockedChildStartIdentity(txDb, detected.identity);
      if (!ctx) return false;
      const t = OWNED_TABLES;
      const b = {
        companyId: detected.identity.companyId,
        invocationId: detected.identity.invocationId,
        generation: detected.identity.generation,
      };
      const [row] = await txDb
        .select({ owned: ownedAutoIsTruePredicate(t, b) })
        .from(t.child)
        .innerJoin(t.parent, eq(t.parent.id, t.child.parentRunId))
        .innerJoin(t.invocation, eq(t.invocation.childRunId, t.child.id))
        .innerJoin(t.parentStep, eq(t.parentStep.id, t.invocation.parentStepRunId))
        .where(and(eq(t.child.id, detected.identity.childRunId), eq(t.invocation.id, detected.identity.invocationId)))
        .limit(1);
      return row?.owned === true;
    });
  } catch (error) {
    // [cycle A §4] 경합(55P03/40P01/40001)은 false 소유 아님 — 소유(true)로 취급해 skipped 가
    // 되게 한다. 실패 CAS 가 경합을 근거로 쓰지 않는다(오류 텍스트/스냅숏 권위 금지, 규칙 7/8).
    if (isChildStartContention(error)) return true;
    throw error;
  }
}

/** 잠금 하 마감 경과 fresh SQL boolean — 분류/재확인 공용(cycle A §2). */
async function deadlineElapsedFresh(db: Db, childRunId: string): Promise<boolean> {
  const [row] = await db
    .select({
      elapsed: sql<boolean>`${workflowRuns.childStartDeadlineAt} is not null
        and ${workflowRuns.childStartDeadlineAt} <= clock_timestamp()`,
    })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, childRunId));
  return row?.elapsed === true;
}

/** 의도 자격 fresh 평가 — 자동은 AUTO 술어, 수동은 IDENTITY+CURRENT(부모 상태 우회). */
async function intentEligibleFresh(
  db: Db,
  identity: ChildStartIdentity,
  intent: ChildStartIntent,
): Promise<boolean> {
  const t = LEASE_TABLES;
  const [row] = await db
    .select({ eligible: intentEligiblePredicate(t, boundOf(identity), intent) })
    .from(t.child)
    .innerJoin(t.parent, eq(t.parent.id, t.child.parentRunId))
    .innerJoin(t.invocation, eq(t.invocation.childRunId, t.child.id))
    .innerJoin(t.parentStep, eq(t.parentStep.id, t.invocation.parentStepRunId))
    .where(and(eq(t.child.id, identity.childRunId), eq(t.invocation.id, identity.invocationId)))
    .limit(1);
  return row?.eligible === true;
}

function intentEligiblePredicate(
  t: ChildStartTables,
  b: ChildStartIdentityBound,
  intent: ChildStartIntent,
): SQL {
  return sql`(${identityPredicate(t, b)} and ${intent === "automatic" ? autoPredicate(t) : currentPredicate(t)})`;
}

function boundOf(identity: { companyId: string; invocationId: string; generation: number }): ChildStartIdentityBound {
  return { companyId: identity.companyId, invocationId: identity.invocationId, generation: identity.generation };
}

const LEASE_TABLES: ChildStartTables = {
  parent: alias(workflowRuns, "csl_parent") as unknown as typeof workflowRuns,
  invocation: workflowStepInvocations,
  parentStep: workflowStepRuns,
  child: alias(workflowRuns, "csl_child") as unknown as typeof workflowRuns,
};

const OWNED_TABLES: ChildStartTables = {
  parent: alias(workflowRuns, "cso_parent") as unknown as typeof workflowRuns,
  invocation: workflowStepInvocations,
  parentStep: workflowStepRuns,
  child: alias(workflowRuns, "cso_child") as unknown as typeof workflowRuns,
};

function mergeChildStartFailure(metadata: unknown, errorCode: string): Record<string, unknown> {
  const base = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  return { ...base, workflowChildStartFailure: { version: 1, errorCode } };
}
