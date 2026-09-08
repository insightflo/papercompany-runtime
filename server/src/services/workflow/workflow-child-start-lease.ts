// server/src/services/workflow/workflow-child-start-lease.ts
//
// [purpose] descope v1(설계 §3) workflow→workflow 자식 초기화 임대 전용 모듈.
//   - acquireWorkflowChildStartLease: 공통 잠금 하 자동(AUTO) 자격 + 소유 토큰+60초 임대+5분 불변
//     마감 획득. materialized 분류가 마감 분류보다 앞서고, 마감 경과는 시도 "전"에 fresh SQL boolean
//     으로 분류하며, 빈 RETURNING 시 잠금 하 마감을 재확인한다. 수동 intent 는 삭제됐다(D3) —
//     자동 자격만 존재한다. JS Date 비교는 없다.
//   - expireWorkflowChildStart: 마감 경과된 미 materialized 자식의 절대 마감 정산. 최종 UPDATE 의
//     WHERE 가 (AUTO OR DEAD)+CURRENT+외부 C 바인딩+pending/running+U+마감 경과를 재평가하고,
//     다음 상태는 DB CASE(죽은 부모→cancelled, 생존 부모→failed)로 결정한다 — 선읽기 상태로
//     정하지 않는다(설계 §4). 자동 재시작 없음. 시간 판정/기록 모두 DB 시계.
// [authority] 내구 레코드(child_start_* 컬럼 + 스텝 행)만이 권위(규칙 7/8/9).
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepInvocations, workflowStepRuns } from "@paperclipai/db";
import {
  autoPredicate,
  deadPredicate,
  type ChildStartTables,
  type WorkflowChildIdentity,
} from "./workflow-child-start-predicates.js";
import {
  type ChildStartIdentity,
  withLockedChildStartIdentity,
} from "./workflow-child-start-state.js";
import { isChildStartContention } from "./workflow-child-start-contention.js";

export const CHILD_START_LEASE_MS = 60_000;
export const CHILD_START_DEADLINE_MS = 300_000;

export type ChildStartLeaseOutcome =
  | { kind: "owned"; identity: ChildStartIdentity; token: string }
  | { kind: "busy" | "materialized" | "ineligible" | "expired" };

const TERMINAL = ["completed", "cancelled", "aborted", "failed", "timed-out"];

const LEASE_TABLES: ChildStartTables = {
  parent: alias(workflowRuns, "csl_parent") as unknown as typeof workflowRuns,
  invocation: workflowStepInvocations,
  parentStep: workflowStepRuns,
  child: alias(workflowRuns, "csl_child") as unknown as typeof workflowRuns,
};

/**
 * 실행 진입 임대 획득 — readiness 이전에 호출되는 유일한 사전 materialization 권위(설계 §3).
 * 공통 잠금 하 완전 신원/CURRENT/AUTO 자격을 검증하고, 종말 자식을 거부하며, materialized 분류를
 * 마감 분류보다 먼저 한다. 이미 경과한 마감은 시도 전에 expired 로 분류한다. 자격 있는 미
 * materialized 자식에만 활성 임대가 없을 때 새 UUID를 발급한다: deadline=coalesce(구값, now+5분,
 * 불연장), expiry=least(now+60초, deadline), status=running, startedAt=coalesce(구값, now).
 * 빈 RETURNING 은 잠금 하 마감 경과 재확인 후에만 busy 가 된다. 시간 권위는 전부 DB clock_timestamp().
 */
export async function acquireWorkflowChildStartLease(
  db: Db,
  identity: ChildStartIdentity,
): Promise<ChildStartLeaseOutcome> {
  // [D2] 세대 1 만 현재 시도다 — 진입점에서 먼저 거부한다.
  if (identity.generation !== 1) return { kind: "ineligible" };
  try {
    return await db.transaction(async (tx): Promise<ChildStartLeaseOutcome> => {
      const txDb = tx as unknown as Db;
      const ctx = await withLockedChildStartIdentity(txDb, identity);
      if (!ctx) return { kind: "ineligible" };
      const { child } = ctx;
      // 종말 자식 거부 — 완료 부활/취소·실패 고정 해제 금지(자동 전용, D3).
      if (TERMINAL.includes(child.status)) return { kind: "ineligible" };
      // [D5] 자동 자격(AUTO = BASE_ID+CURRENT+running 부모+pending 스텝)을 잠금 하 fresh SQL 로
      // 재평가한다. CURRENT 위반(구세대/retryCount/workflowRetry)은 모두 ineligible 이다.
      if (!(await autoEligibleFresh(txDb, identity))) return { kind: "ineligible" };
      // [설계 §3] materialized 분류가 마감 분류보다 먼저 — materialized 자식의 과거 초기화
      // 마감은 native 실행을 지배하지 않는다.
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, child.id));
      if (child.childStartMaterializedAt !== null || count > 0) return { kind: "materialized" };
      // [설계 §3] 마감 경과 분류를 시도 전에 fresh SQL boolean 으로 수행한다.
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
          sql`${workflowRuns.status} in ('pending', 'running')`,
          sql`${workflowRuns.childStartMaterializedAt} is null`,
          sql`not exists (select 1 from workflow_step_runs csr where csr.workflow_run_id = ${child.id})`,
          // 활성 임대가 있으면 발급하지 않고, 마감이 경과했으면 발급하지 않는다(그룹화된 OR).
          sql`(${workflowRuns.childStartToken} is null or ${workflowRuns.childStartLeaseExpiresAt} <= clock_timestamp())`,
          sql`(${workflowRuns.childStartDeadlineAt} is null or ${workflowRuns.childStartDeadlineAt} > clock_timestamp())`,
          // [D5] 최종 변이의 WHERE 가 AUTO(완전 신원)를 잠금 하 재평가한다.
          sql`exists (select 1
            from workflow_runs ${LEASE_TABLES.parent}, workflow_step_invocations ${LEASE_TABLES.invocation}, workflow_step_runs ${LEASE_TABLES.parentStep}, workflow_runs ${LEASE_TABLES.child}
            where ${autoPredicate(LEASE_TABLES, identityBound(identity))}
              and ${LEASE_TABLES.child}.id = workflow_runs.id)`,
        ))
        .returning({
          id: workflowRuns.id,
          childStartToken: workflowRuns.childStartToken,
        });
      const row = claimed[0];
      if (!row?.childStartToken) {
        // [설계 §3] 빈 RETURNING — 잠금 하 마감 경과를 재확인한다(시간은 시도 중에도 흐른다).
        if (await deadlineElapsedFresh(txDb, child.id)) return { kind: "expired" };
        return { kind: "busy" };
      }
      return { kind: "owned", identity, token: row.childStartToken };
    });
  } catch (error) {
    // [설계 §3] 경합(lock_timeout/deadlock/serialization)은 롤백 후 busy — 실패 정산 아님.
    if (isChildStartContention(error)) return { kind: "busy" };
    throw error;
  }
}

/**
 * [descope §4] 절대 마감 정산 — 마감이 경과된 링크된 비종말 미 materialized 자식을 정산한다.
 * 최종 UPDATE 한 문장에서 (AUTO OR DEAD)+CURRENT+완전 신원+외부 C 바인딩+pending/running+U+
 * 마감 경과를 재평가하고, 다음 상태는 DB CASE 로 결정한다: 죽은 부모(모든 종말, 완료 포함)의
 * 자식은 cancelled, 생존 부모의 자식은 failed(child_start_timeout 구조화 메타데이터). 토큰/임대를
 * 정리하고 마감은 보존한다. 성공 시 커밋 후 호출자가 자식 completion hook 을 발화한다.
 */
export async function expireWorkflowChildStart(
  db: Db,
  identity: ChildStartIdentity,
): Promise<{ settled: boolean; childStatus: "cancelled" | "failed" } | null> {
  // [D2] 구세대 신원은 정산하지 않는다(fail-closed).
  if (identity.generation !== 1) return null;
  return await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const ctx = await withLockedChildStartIdentity(txDb, identity);
    if (!ctx) return null;
    const { child } = ctx;
    if (TERMINAL.includes(child.status)) return null;
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, child.id));
    if (child.childStartMaterializedAt !== null || count > 0) return null;
    const t = EXPIRE_TABLES;
    const updated = await tx
      .update(workflowRuns)
      .set({
        // [설계 §4] 다음 상태를 DB CASE 로 결정 — 죽은 부모면 cancelled, 생존 부모면 failed.
        // 선읽기(parent.status)로 상태를 정하지 않는다; UPDATE 가 재평가한 DEAD 술어가 권위다.
        status: sql`case when exists (select 1
            from workflow_runs ${t.parent}, workflow_step_invocations ${t.invocation}, workflow_step_runs ${t.parentStep}, workflow_runs ${t.child}
            where ${deadPredicate(t, identityBound(identity))}
              and ${t.child}.id = workflow_runs.id)
          then 'cancelled' else 'failed' end`,
        completedAt: sql`clock_timestamp()`,
        childStartToken: null,
        childStartLeaseExpiresAt: null,
        metadata: mergeChildStartFailure(child.metadata, "child_start_timeout"),
      })
      .where(and(
        eq(workflowRuns.id, ctx.child.id),
        eq(workflowRuns.companyId, identity.companyId),
        sql`${workflowRuns.status} in ('pending', 'running')`,
        sql`${workflowRuns.childStartMaterializedAt} is null`,
        sql`not exists (select 1 from workflow_step_runs csr where csr.workflow_run_id = ${ctx.child.id})`,
        sql`${workflowRuns.childStartDeadlineAt} is not null and ${workflowRuns.childStartDeadlineAt} <= clock_timestamp()`,
        // [D5] (AUTO OR DEAD) — 부모가 running(생존)이거나 종말일 때만 정산한다. 그 외 부모
        // 상태는 술어 실패 = no-op(fail-closed).
        sql`exists (select 1
          from workflow_runs ${t.parent}, workflow_step_invocations ${t.invocation}, workflow_step_runs ${t.parentStep}, workflow_runs ${t.child}
          where (${autoPredicate(t, identityBound(identity))} or ${deadPredicate(t, identityBound(identity))})
            and ${t.child}.id = workflow_runs.id)`,
      ))
      .returning({ id: workflowRuns.id, status: workflowRuns.status });
    const row = updated[0];
    if (!row) return null;
    return { settled: true, childStatus: row.status === "cancelled" ? "cancelled" : "failed" };
  });
}

const EXPIRE_TABLES: ChildStartTables = {
  parent: alias(workflowRuns, "cse_parent") as unknown as typeof workflowRuns,
  invocation: workflowStepInvocations,
  parentStep: workflowStepRuns,
  child: alias(workflowRuns, "cse_child") as unknown as typeof workflowRuns,
};

/** 잠금 하 마감 경과 fresh SQL boolean — 분류/재확인 공용(설계 §3). */
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

/** 자동 자격 fresh 평가 — AUTO 술어(완전 신원)를 잠금 하 조인으로 재평가한다. */
async function autoEligibleFresh(db: Db, identity: ChildStartIdentity): Promise<boolean> {
  const t = LEASE_TABLES;
  const [row] = await db
    .select({ eligible: autoPredicate(t, identityBound(identity)) })
    .from(t.child)
    .innerJoin(t.parent, eq(t.parent.id, t.child.parentRunId))
    .innerJoin(t.invocation, eq(t.invocation.childRunId, t.child.id))
    .innerJoin(t.parentStep, eq(t.parentStep.id, t.invocation.parentStepRunId))
    .where(and(eq(t.child.id, identity.childRunId), eq(t.invocation.id, identity.invocationId)))
    .limit(1);
  return row?.eligible === true;
}

/** ChildStartIdentity(number 세대)를 검증된 완전 바운드 B 로 변환한다(진입점이 ===1 을 보장). */
function identityBound(identity: ChildStartIdentity): WorkflowChildIdentity {
  return { ...identity, generation: 1 };
}

function mergeChildStartFailure(metadata: unknown, errorCode: string): Record<string, unknown> {
  const base = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  return { ...base, workflowChildStartFailure: { version: 1, errorCode } };
}
