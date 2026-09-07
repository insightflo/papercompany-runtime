// server/src/services/workflow/workflow-child-recovery-candidates.ts
//
// [purpose] workflow→workflow 자식 회복의 ACTIONABLE 후보 선출 전용 모듈(fix4 §4).
//   SQL CASE 로 우선순위 클래스(recoveryKind)를 부여하고 materialization/임대 사실을 함께
//   반환한다. 건강한(정확히 입양된) 실행 중 자식은 후보가 아니며, 정산 불가능 영수증(미래
//   retry/구세대)은 tombstone/terminal 모두에서 배제된다. LIMIT 은 우선순위 정렬 후 적용.
// [authority] 모든 판정은 구조화 DB 레코드만 읽는다(규칙 7/8, 텍스트→int 캐스트 금지).
import { and, asc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
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
  | "settle-deleted"
  | "settle-terminal"
  | "create-claimed"
  | "start-or-resume"
  | "adopt-only";

export type ChildRecoveryRow = {
  stepRun: typeof workflowStepRuns.$inferSelect;
  run: typeof workflowRuns.$inferSelect;
  // [cycle A §5] nullable LEFT JOIN — 정의 삭제 후에도 죽은 부모/만료 라이프사이클 후보는 생존한다.
  //   정의 해석은 라이프사이클 액션 이후 필요한 분기에서만 이뤄진다.
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

const TERMINAL_STATUSES = Array.from(TERMINAL_WORKFLOW_STATUSES);

/**
 * ACTIONABLE 후보만 선출한다(fix3 P1-4 + fix4 §4). 우선순위 CASE:
 *  0 cancel-dead-parent — 죽은 부모(failed/cancelled/aborted/timed-out) 또는 완료 부모+wait:true
 *    의 링크된 비종말 자식. 부모 스텝/입양/정의 상태로 게이트하지 않는다(취소가 먼저).
 *  1 expire-start — 마감이 경과한 링크된 비종말 미 materialized 자식.
 *  2 settle-deleted / settle-terminal — pending 스텝 + 현재 세대 + retry 미대기 정산 가능 영수증.
 *  3 create-claimed — pending 스텝 + claimed NULL + 현재 세대 + retry 미대기.
 *  4 start-or-resume — 링크된 pending/running 미 materialized 자식(시작 허용 또는 수리 가능).
 *  5 adopt-only — pending 스텝 + 비종말 + materialized + 미정확입양 + 현재 세대 + retry 미대기.
 */
export async function selectActionableCandidates(
  db: Db,
  limit: number,
  filterInvocationId?: string,
): Promise<ChildRecoveryRow[]> {
  const childRuns = alias(workflowRuns, "wcr_child");
  const terminalC = inArray(childRuns.status, TERMINAL_STATUSES);
  const nonTerminalC = notInArray(childRuns.status, TERMINAL_STATUSES);
  const retryEligible = and(
    sql`coalesce(${workflowStepRuns.metadata}->'workflowRetry'->>'state', '') <> 'waiting'`,
    sql`${workflowStepRuns.retryCount} + 1 = ${workflowStepInvocations.generation}`,
  );
  // 정확한 adoption 포함 비교(JSONB contains — 텍스트 캐스트 없음).
  const exactlyAdopted = sql`(${workflowStepRuns.metadata}->'workflowChild') @> jsonb_build_object(
    'invocationId', ${workflowStepInvocations.id},
    'childRunId', ${workflowStepInvocations.childRunId},
    'generation', ${workflowStepInvocations.generation},
    'wait', ${workflowStepInvocations.wait})`;
  const zeroSteps = sql`not exists (select 1 from workflow_step_runs csr where csr.workflow_run_id = ${childRuns.id})`;
  const unmaterialized = and(
    isNull(childRuns.childStartMaterializedAt),
    zeroSteps,
  );
  const deadParent = sql`${workflowRuns.status} in ('failed', 'cancelled', 'aborted', 'timed-out')`;
  // [cycle A §11] non-null 자식 팔에 명시하는 구조 정합 — 자식 FK 가 다른 부모/회사/스텝을 가리키는
  //   비-coherent 영수증은 후보에서 배제한다.
  const childConsistent = and(
    sql`${childRuns.companyId} = ${workflowRuns.companyId}`,
    sql`${childRuns.parentRunId} = ${workflowRuns.id}`,
    sql`${childRuns.parentStepRunId} = ${workflowStepRuns.id}`,
  );
  // [cycle A §10] coherent linked 또는 수리 가능한 claimed+nonnull 판별자. 링크 NULL/claimed NULL 은
  //   제외된다(tombstone/생성 의미론 유지).
  const childLinkable = or(
    eq(workflowStepInvocations.state, "linked"),
    and(eq(workflowStepInvocations.state, "claimed"), isNotNull(workflowStepInvocations.childRunId)),
  );
  // [cycle B F4] claimed 영수증의 수리 자격(AUTO OR DEAD) — 수리 불가능 claimed+nonnull 행이 LIMIT 을
  //   점유하지 못하게 모든 claimed 팔에 요구한다. cancel-dead-parent(DEAD)와 settle-terminal/
  //   start-or-resume/adopt-only(AUTO: running 부모+pending 스텝+CURRENT+NOT_WAITING) 팔은 구조적으로
  //   이미 자격을 함의하지만, expire-start 는 부모/스텝 조건이 없어 명시 가드가 필요하다.
  const claimedRepairEligible = sql`(
    (${workflowStepRuns.retryCount} + 1 = ${workflowStepInvocations.generation}
      and coalesce(${workflowStepRuns.metadata}->'workflowRetry'->>'state', '') <> 'waiting'
      and ((${workflowRuns.status} = 'running' and ${workflowStepRuns.status} = 'pending')
        or (${workflowRuns.status} in ('running', 'completed') and ${workflowStepInvocations.wait} = false and ${workflowStepRuns.status} = 'completed')))
    or ${workflowRuns.status} in ('failed', 'cancelled', 'aborted', 'timed-out')
    or (${workflowRuns.status} = 'completed' and ${workflowStepInvocations.wait} = true))`;
  const claimedLinkableRepairable = and(
    eq(workflowStepInvocations.state, "claimed"),
    isNotNull(workflowStepInvocations.childRunId),
    claimedRepairEligible,
  );

  const kindCase = sql<ChildRecoveryKind>`(
    case
      when ${and(
        isNotNull(workflowStepInvocations.childRunId),
        nonTerminalC,
        childConsistent,
        or(deadParent, and(eq(workflowRuns.status, "completed"), eq(workflowStepInvocations.wait, true))),
      )} then 'cancel-dead-parent'
      when ${and(
        isNotNull(workflowStepInvocations.childRunId),
        nonTerminalC,
        childConsistent,
        unmaterialized,
        isNotNull(childRuns.childStartDeadlineAt),
        sql`${childRuns.childStartDeadlineAt} <= clock_timestamp()`,
        or(
          eq(workflowStepInvocations.state, "linked"),
          claimedLinkableRepairable,
        ),
      )} then 'expire-start'
      when ${and(
        eq(workflowRuns.status, "running"),
        eq(workflowStepRuns.status, "pending"),
        eq(workflowStepInvocations.state, "linked"),
        isNull(workflowStepInvocations.childRunId),
        retryEligible,
      )} then 'settle-deleted'
      when ${and(
        eq(workflowRuns.status, "running"),
        eq(workflowStepRuns.status, "pending"),
        childLinkable,
        // [cycle B F4] non-null 자식 팔에도 구조 정합을 요구한다(회사/부모/스텝 불일치 배제).
        childConsistent,
        terminalC,
        retryEligible,
      )} then 'settle-terminal'
      when ${and(
        eq(workflowRuns.status, "running"),
        eq(workflowStepRuns.status, "pending"),
        eq(workflowStepInvocations.state, "claimed"),
        isNull(workflowStepInvocations.childRunId),
        retryEligible,
      )} then 'create-claimed'
      when ${and(
        isNotNull(workflowStepInvocations.childRunId),
        inArray(childRuns.status, ["pending", "running"]),
        childConsistent,
        unmaterialized,
        // 임대는 null 이거나 만료, 마감은 null 이거나 미래(fix4 §4 표 — live 임대는 소유자 존재).
        sql`(${childRuns.childStartLeaseExpiresAt} is null or ${childRuns.childStartLeaseExpiresAt} <= clock_timestamp())`,
        sql`(${childRuns.childStartDeadlineAt} is null or ${childRuns.childStartDeadlineAt} > clock_timestamp())`,
        or(
          // 부모/스텝 시작 허용(running+pending, 현재 세대) — 입양 여부 무관(creator 크래시 포함).
          and(
            eq(workflowRuns.status, "running"),
            eq(workflowStepRuns.status, "pending"),
            retryEligible,
          ),
          // fire-and-forget: 채택이 부모 스텝을 완료한 뒤 크래시한 경우(요청 wait=false 내구 값).
          and(
            inArray(workflowRuns.status, ["running", "completed"]),
            eq(workflowStepInvocations.wait, false),
            eq(workflowStepRuns.status, "completed"),
            sql`coalesce(${workflowStepRuns.metadata}->'workflowRetry'->>'state', '') <> 'waiting'`,
            sql`${workflowStepRuns.retryCount} + 1 = ${workflowStepInvocations.generation}`,
          ),
        ),
      )} then 'start-or-resume'
      when ${and(
        eq(workflowRuns.status, "running"),
        eq(workflowStepRuns.status, "pending"),
        isNotNull(workflowStepInvocations.childRunId),
        childConsistent,
        childLinkable,
        nonTerminalC,
        sql`not ${unmaterialized}`,
        sql`coalesce((${workflowStepRuns.metadata}->'workflowChild') @> jsonb_build_object('invocationId', ${workflowStepInvocations.id}, 'childRunId', ${workflowStepInvocations.childRunId}, 'generation', ${workflowStepInvocations.generation}, 'wait', ${workflowStepInvocations.wait}), false) = false`,
        retryEligible,
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
    // [cycle A §5] 정의는 nullable LEFT JOIN(같은 회사 조건) — 정의 삭제가 라이프사이클 정산을
    //   가로막지 않는다. head-of-line 점유도 없다(정의 없는 후보는 라이프사이클만 수행).
    .leftJoin(workflowDefinitions, and(
      eq(workflowRuns.workflowId, workflowDefinitions.id),
      eq(workflowDefinitions.companyId, workflowRuns.companyId),
    ))
    .leftJoin(childRuns, eq(childRuns.id, workflowStepInvocations.childRunId))
    .where(and(
      sql`${kindCase} is not null`,
      // [cycle B F4] 전역 회사 스코프 — invocation 과 부모 run 의 회사 일치를 LIMIT 전에 강제한다.
      eq(workflowStepInvocations.companyId, workflowRuns.companyId),
      ...(filterInvocationId ? [eq(workflowStepInvocations.id, filterInvocationId)] : []),
    ))
    .orderBy(
      sql`case ${kindCase}
        when 'cancel-dead-parent' then 0
        when 'expire-start' then 1
        when 'settle-deleted' then 2
        when 'settle-terminal' then 2
        when 'create-claimed' then 3
        when 'start-or-resume' then 4
        else 5 end`,
      asc(workflowStepInvocations.createdAt),
      asc(workflowStepInvocations.id),
    )
    .limit(limit);
}

/** adoption 메타데이터가 현재 invocation 과 정확히 일치하는지(ID/자식/세대/wait, 타입 엄격). */
export function isAdopted(stepRun: typeof workflowStepRuns.$inferSelect, invocation: typeof workflowStepInvocations.$inferSelect): boolean {
  const metadata = stepRun.metadata && typeof stepRun.metadata === "object" && !Array.isArray(stepRun.metadata)
    ? stepRun.metadata as Record<string, unknown>
    : {};
  const workflowChild = metadata.workflowChild;
  if (!workflowChild || typeof workflowChild !== "object") return false;
  const record = workflowChild as Record<string, unknown>;
  return record.invocationId === invocation.id
    && record.childRunId === invocation.childRunId
    && record.generation === invocation.generation
    && record.wait === invocation.wait;
}

/** 액션 경계에서 후보 사실을 LIMIT 없이 재적재한다(클래스 변경 시 1회 재분기). */
export async function refreshWorkflowChildRecoveryRow(db: Db, invocationId: string): Promise<ChildRecoveryRow | null> {
  const rows = await selectActionableCandidates(db, 1, invocationId);
  return rows[0] ?? null;
}
