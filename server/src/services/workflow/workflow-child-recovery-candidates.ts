// server/src/services/workflow/workflow-child-recovery-candidates.ts
//
// [purpose] descope v1 — workflow→workflow 자식 회복의 후보 선출 전용 모듈. 후보 계열은
//   cancel-dead-parent / expire-start / terminal-settle / tombstone-settle /
//   start-unmaterialized / adopt-only 여섯뿐이다(wait/retry/legacy 팔은 삭제 — D1/D2/D5).
//   모든 계열은 LIMIT 이전에 유효 전체 신원(linked + 구조 정합) + CURRENT(generation=1,
//   retryCount=0, 무 workflowRetry 키) + 회사 일치 + actionable 상태/나이를 요구한다.
//   invalid-state 진단은 별도 질의 + bounded keyset pagination 으로 분리된다 — 하나의 비정합
//   행이 actionable 슬롯을 소모하지 못한다. 이 스캔은 수리/실행을 하지 않는다.
// [authority] 모든 판정은 구조화 DB 레코드만 읽는다(규칙 7/8, 텍스트→int 캐스트 금지).
import { and, asc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import {
  workflowDefinitions,
  workflowRuns,
  workflowStepInvocations,
  workflowStepRuns,
} from "@paperclipai/db";
import { TERMINAL_WORKFLOW_STATUSES } from "../missions/mission-runtime-manager.js";

export type ChildRecoveryKind =
  | "cancel-dead-parent"
  | "expire-start"
  | "terminal-settle"
  | "tombstone-settle"
  | "start-unmaterialized"
  | "adopt-only";

export type ChildRecoveryRow = {
  stepRun: typeof workflowStepRuns.$inferSelect;
  run: typeof workflowRuns.$inferSelect;
  /** nullable LEFT JOIN — 정의 삭제 후에도 죽은 부모/만료 라이프사이클 후보는 생존한다. */
  definition: typeof workflowDefinitions.$inferSelect | null;
  invocation: typeof workflowStepInvocations.$inferSelect;
  childStatus: string | null;
  childStartedAt: Date | null;
  childHasStepRuns: boolean;
  childMaterializedAt: Date | null;
  childStartToken: string | null;
  childStartLeaseExpiresAt: Date | null;
  childStartDeadlineAt: Date | null;
  recoveryKind: ChildRecoveryKind;
};

/** invalid-state 진단 행 — 실행 행을 바꾸지 않고 구조화 사유만 실는다(설계 §2 fail-closed). */
export type InvalidChildStartDiagnostic = {
  invocationId: string;
  parentStepRunId: string;
  runId: string | null;
  childRunId: string | null;
  reason: string;
};

const TERMINAL_STATUSES = Array.from(TERMINAL_WORKFLOW_STATUSES);

// 공통 구조 절 — LIMIT 전 필터(유효 신원 + CURRENT + 회사).
const invLinked = eq(workflowStepInvocations.state, "linked");
const invCurrent = sql`${workflowStepInvocations.generation} = 1`;
const stepCurrent = sql`${workflowStepRuns.retryCount} = 0
  and not (coalesce(${workflowStepRuns.metadata}, '{}'::jsonb) ? 'workflowRetry')`;
const sameCompany = sql`${workflowStepInvocations.companyId} = ${workflowRuns.companyId}`;
const childConsistent = sql`${workflowStepInvocations.childRunId} is not null
  and ${workflowStepInvocations.companyId} = ${workflowRuns.companyId}
  and ${workflowStepRuns.workflowRunId} = ${workflowRuns.id}`;
const parentRunning = eq(workflowRuns.status, "running");
const parentDead = sql`${workflowRuns.status} in ('failed', 'cancelled', 'aborted', 'timed-out', 'completed')`;
const stepPending = eq(workflowStepRuns.status, "pending");
const childTerminal = (childRuns: typeof workflowRuns) => inArray(childRuns.status, TERMINAL_STATUSES);
const childNonTerminal = (childRuns: typeof workflowRuns) => notInArray(childRuns.status, TERMINAL_STATUSES);
const childU = (childRuns: typeof workflowRuns) => sql`${childRuns.childStartMaterializedAt} is null
  and not exists (select 1 from workflow_step_runs csr where csr.workflow_run_id = ${childRuns.id})`;

/** 정확한 adoption 포함 비교(JSONB contains — wait 키 없음, 텍스트 캐스트 없음). */
const exactlyAdopted = sql`(${workflowStepRuns.metadata}->'workflowChild') @> jsonb_build_object(
  'invocationId', ${workflowStepInvocations.id},
  'childRunId', ${workflowStepInvocations.childRunId},
  'generation', ${workflowStepInvocations.generation})`;

/**
 * AUTO(B) 구조 형 — 파라미터 바인딩 ID 없는 스캔용: linked + CURRENT + 회사 일치 + running 부모
 * + pending 스텝 + child 링크 구조 정합. childRuns 는 alias 테이블의 SQL 렌더링만 필요하므로
 * 캐스트해 전달한다(execution 모듈과 동일 패턴).
 */
const AUTO = (childRuns: typeof workflowRuns) => and(
  invLinked, invCurrent, stepCurrent, sameCompany,
  parentRunning, stepPending,
  eq(workflowStepInvocations.childRunId, childRuns.id),
  eq(childRuns.companyId, workflowRuns.companyId),
  eq(childRuns.parentRunId, workflowRuns.id),
  eq(childRuns.parentStepRunId, workflowStepRuns.id),
);

const DEAD = (childRuns: typeof workflowRuns) => and(
  invLinked, invCurrent, stepCurrent, sameCompany,
  parentDead,
  eq(workflowStepInvocations.childRunId, childRuns.id),
  eq(childRuns.companyId, workflowRuns.companyId),
  eq(childRuns.parentRunId, workflowRuns.id),
  eq(childRuns.parentStepRunId, workflowStepRuns.id),
);

/**
 * ACTIONABLE 후보만 선출한다. 우선순위 CASE:
 *  0 cancel-dead-parent — 죽은 부모(모든 종말 run 상태)의 linked 비종말 자식. 취소가 먼저.
 *  1 expire-start — (AUTO OR DEAD) + U + 경과 마감(절대 시간은 DB 시계).
 *  2 tombstone-settle — linked+NULL + running 부모 + pending 스텝(CURRENT).
 *  2 terminal-settle — linked + 종말 자식 + running 부모 + pending 스텝(CURRENT).
 *  4 start-unmaterialized — AUTO + C pending/running + U + 임대 없음/만료 + 마감 없음/미래.
 *  5 adopt-only — AUTO + 비종말 자식 + NOT U + 미정확입양.
 */
export async function selectActionableCandidates(
  db: Db,
  limit: number,
  filterInvocationId?: string,
): Promise<ChildRecoveryRow[]> {
  const childRuns = alias(workflowRuns, "wcr_child");
  // alias 테이블은 SQL 렌더링만 필요 — 구조 술어 헬퍼에는 캐스트해 전달한다.
  const childT = childRuns as unknown as typeof workflowRuns;
  const kindCase = sql<ChildRecoveryKind>`(
    case
      when ${and(childConsistent, childNonTerminal(childT), DEAD(childT))} then 'cancel-dead-parent'
      when ${and(
        or(sql`${AUTO(childT)} is true`, sql`${DEAD(childT)} is true`),
        childU(childT),
        sql`${childRuns.childStartDeadlineAt} is not null and ${childRuns.childStartDeadlineAt} <= clock_timestamp()`,
      )} then 'expire-start'
      when ${and(
        parentRunning, stepPending, invLinked, invCurrent, stepCurrent, sameCompany,
        isNull(workflowStepInvocations.childRunId),
      )} then 'tombstone-settle'
      when ${and(childConsistent, parentRunning, stepPending, invCurrent, stepCurrent, childTerminal(childT))} then 'terminal-settle'
      when ${and(
        AUTO(childT),
        inArray(childRuns.status, ["pending", "running"]),
        childU(childT),
        // 임대는 null 이거나 만료, 마감은 null 이거나 미래 — live 임대는 소유자 존재.
        sql`(${childRuns.childStartLeaseExpiresAt} is null or ${childRuns.childStartLeaseExpiresAt} <= clock_timestamp())`,
        sql`(${childRuns.childStartDeadlineAt} is null or ${childRuns.childStartDeadlineAt} > clock_timestamp())`,
      )} then 'start-unmaterialized'
      when ${and(
        AUTO(childT),
        childNonTerminal(childT),
        sql`not (${childU(childT)})`,
        sql`coalesce((${exactlyAdopted}), false) = false`,
      )} then 'adopt-only'
      else null
    end
  )`;

  return await db
    .select({
      stepRun: workflowStepRuns,
      run: workflowRuns,
      definition: workflowDefinitions,
      invocation: workflowStepInvocations,
      childStatus: childRuns.status,
      childStartedAt: childRuns.startedAt,
      childHasStepRuns: sql<boolean>`exists (select 1 from workflow_step_runs csr where csr.workflow_run_id = ${childRuns.id})`,
      childMaterializedAt: childRuns.childStartMaterializedAt,
      childStartToken: childRuns.childStartToken,
      childStartLeaseExpiresAt: childRuns.childStartLeaseExpiresAt,
      childStartDeadlineAt: childRuns.childStartDeadlineAt,
      recoveryKind: kindCase,
    })
    .from(workflowStepInvocations)
    .innerJoin(workflowStepRuns, eq(workflowStepRuns.id, workflowStepInvocations.parentStepRunId))
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
    .leftJoin(workflowDefinitions, and(
      eq(workflowRuns.workflowId, workflowDefinitions.id),
      eq(workflowDefinitions.companyId, workflowRuns.companyId),
    ))
    .leftJoin(childRuns, eq(childRuns.id, workflowStepInvocations.childRunId))
    .where(and(
      sql`${kindCase} is not null`,
      sameCompany,
      ...(filterInvocationId ? [eq(workflowStepInvocations.id, filterInvocationId)] : []),
    ))
    .orderBy(
      sql`case ${kindCase}
        when 'cancel-dead-parent' then 0
        when 'expire-start' then 1
        when 'tombstone-settle' then 2
        when 'terminal-settle' then 2
        when 'start-unmaterialized' then 4
        else 5 end`,
      asc(workflowStepInvocations.createdAt),
      asc(workflowStepInvocations.id),
    )
    .limit(limit);
}

/**
 * invalid-state 진단 — actionable 슬롯과 "별도" 질의로 bounded keyset pagination(invocation.id
 * 커서)을 적용한다. 하나의 비정합 행이 반복 선출을 독점하지 않고, 실행 행은 절대 바뀌지 않는다.
 */
export async function selectInvalidChildStartDiagnostics(
  db: Db,
  input: { limit: number; afterInvocationId?: string },
): Promise<InvalidChildStartDiagnostic[]> {
  const childRuns = alias(workflowRuns, "wci_child");
  const reasonCase = sql<string>`(
    case
      when ${workflowStepRuns.id} is null then 'parent_step_missing'
      when ${workflowRuns.id} is null or ${workflowRuns.companyId} <> ${workflowStepInvocations.companyId} then 'parent_run_missing_or_company_mismatch'
      when ${workflowStepInvocations.state} = 'claimed' then 'committed_claimed_state'
      when ${workflowStepInvocations.state} <> 'linked' then 'unknown_invocation_state'
      when ${workflowStepInvocations.generation} <> 1 then 'generation_not_one'
      when ${workflowStepRuns.retryCount} <> 0
        or coalesce(${workflowStepRuns.metadata}, '{}'::jsonb) ? 'workflowRetry' then 'parent_step_retry_state_present'
      when ${workflowStepInvocations.state} = 'linked' and ${workflowStepInvocations.childRunId} is not null
        and ${childRuns.id} is null then 'child_row_missing'
      when ${workflowStepInvocations.state} = 'linked' and ${workflowStepInvocations.childRunId} is not null
        and (${childRuns.companyId} <> ${workflowStepInvocations.companyId}
          or ${childRuns.parentRunId} <> ${workflowRuns.id}
          or ${childRuns.parentStepRunId} <> ${workflowStepRuns.id}) then 'child_link_incoherent'
      else null
    end
  )`;
  const rows = await db
    .select({
      invocationId: workflowStepInvocations.id,
      parentStepRunId: workflowStepInvocations.parentStepRunId,
      runId: workflowRuns.id,
      childRunId: workflowStepInvocations.childRunId,
      reason: reasonCase,
    })
    .from(workflowStepInvocations)
    .leftJoin(workflowStepRuns, eq(workflowStepRuns.id, workflowStepInvocations.parentStepRunId))
    .leftJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
    .leftJoin(childRuns, eq(childRuns.id, workflowStepInvocations.childRunId))
    .where(and(
      sql`${reasonCase} is not null`,
      ...(input.afterInvocationId ? [sql`${workflowStepInvocations.id} > ${input.afterInvocationId}::uuid`] : []),
    ))
    .orderBy(asc(workflowStepInvocations.id))
    .limit(Math.max(1, input.limit));
  return rows.flatMap((row) => row.reason === null ? [] : [{ ...row, reason: row.reason }]);
}

/** adoption 메타데이터가 현재 invocation 과 정확히 일치하는지(ID/자식/세대, 타입 엄격). */
export function isAdopted(stepRun: typeof workflowStepRuns.$inferSelect, invocation: typeof workflowStepInvocations.$inferSelect): boolean {
  const metadata = stepRun.metadata && typeof stepRun.metadata === "object" && !Array.isArray(stepRun.metadata)
    ? stepRun.metadata as Record<string, unknown>
    : {};
  const workflowChild = metadata.workflowChild;
  if (!workflowChild || typeof workflowChild !== "object") return false;
  const record = workflowChild as Record<string, unknown>;
  return record.invocationId === invocation.id
    && record.childRunId === invocation.childRunId
    && record.generation === invocation.generation;
}

/** 액션 경계에서 후보 사실을 LIMIT 없이 재적재한다(클래스 변경 시 1회 재분기). */
export async function refreshWorkflowChildRecoveryRow(db: Db, invocationId: string): Promise<ChildRecoveryRow | null> {
  const rows = await selectActionableCandidates(db, 1, invocationId);
  return rows[0] ?? null;
}
