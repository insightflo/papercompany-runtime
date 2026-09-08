// server/src/services/workflow/workflow-child-start-predicates.ts
//
// [purpose] descope v1(설계 §3)의 공유 SQL 술어 전용 모듈. 대문자명(BASE_ID/CURRENT/AUTO/
//   DEAD/OWNER/TOMBSTONE)은 설계가 고정한 기계 술어다. 모든 최종 변이의 WHERE/INSERT SELECT 는
//   이 술어로 완전 신원(company, parentRun, parentStep, stepId, invocation, generation=1,
//   child)을 바인딩해야 한다(D5) — 선행 read 의 부분 술어는 권위가 없다.
// [usage] tables 에 drizzle 테이블 또는 alias() 별칭 테이블을 넣는다. bound 값은 파라미터
//   바인딩된다. 술어는 잠금 하 최종 UPDATE/INSERT SELECT 에서 재평가된다(시간은 흐른다).
//   메타데이터 판정은 null-safe(COALESCE)이며, 시간 판정은 DB clock_timestamp() 기준이다.
import { sql, type SQL } from "drizzle-orm";
import { workflowRuns, workflowStepInvocations, workflowStepRuns } from "@paperclipai/db";

/** p=부모 run, i=invocation, s=부모 step-run, c=자식 run (drizzle 테이블/별칭 모두 허용). */
export type ChildStartTables = {
  parent: typeof workflowRuns;
  invocation: typeof workflowStepInvocations;
  parentStep: typeof workflowStepRuns;
  child: typeof workflowRuns;
};

/** 설계 §3의 B — 모든 최종 변이가 바인딩해야 하는 완전 신원. generation 은 항상 1(D2). */
export type WorkflowChildIdentity = {
  companyId: string;
  parentRunId: string;
  parentStepRunId: string;
  stepId: string;
  invocationId: string;
  childRunId: string;
  generation: 1;
};

/** TOMBSTONE 형 — child_run_id IS NULL 인 linked invocation 에 바인딩(C 절 없음). */
export type WorkflowChildTombstoneIdentity = Omit<WorkflowChildIdentity, "childRunId">;

/** 워크플로 run 의 기존 종말 상태 전체(DEAD 판정에 그대로 사용 — 설계 §3). */
export const WORKFLOW_CHILD_TERMINAL_RUN_STATUSES_SQL = sql`('completed', 'cancelled', 'aborted', 'failed', 'timed-out')`;

/** BASE_ID(B) — 회사/부모 run/부모 스텝/스텝 ID/invocation/세대/자식 링크 전체 정합. */
export function baseIdPredicate(t: ChildStartTables, b: WorkflowChildIdentity): SQL {
  return sql`${t.parent}.id = ${b.parentRunId}::uuid
    and ${t.parent}.company_id = ${b.companyId}::uuid
    and ${t.parentStep}.id = ${b.parentStepRunId}::uuid
    and ${t.parentStep}.workflow_run_id = ${t.parent}.id
    and ${t.parentStep}.step_id = ${b.stepId}
    and ${t.invocation}.id = ${b.invocationId}::uuid
    and ${t.invocation}.parent_step_run_id = ${t.parentStep}.id
    and ${t.invocation}.company_id = ${b.companyId}::uuid
    and ${t.invocation}.state = 'linked'
    and ${t.invocation}.generation = ${b.generation}
    and ${t.child}.id = ${b.childRunId}::uuid
    and ${t.invocation}.child_run_id = ${t.child}.id
    and ${t.child}.company_id = ${b.companyId}::uuid
    and ${t.child}.parent_run_id = ${t.parent}.id
    and ${t.child}.parent_step_run_id = ${t.parentStep}.id`;
}

/** CURRENT — 세대 1 + retryCount 0 + workflowRetry 키 부재(null 포함, null-safe). */
export function currentPredicate(
  t: Pick<ChildStartTables, "invocation" | "parentStep">,
): SQL {
  return sql`(${t.invocation}.generation = 1
    and ${t.parentStep}.retry_count = 0
    and not (coalesce(${t.parentStep}.metadata, '{}'::jsonb) ? 'workflowRetry'))`;
}

/** AUTO(B) — BASE_ID + CURRENT + running 부모 + pending 부모 스텝. */
export function autoPredicate(t: ChildStartTables, b: WorkflowChildIdentity): SQL {
  return sql`(${baseIdPredicate(t, b)}
    and ${currentPredicate(t)}
    and ${t.parent}.status = 'running'
    and ${t.parentStep}.status = 'pending')`;
}

/** DEAD(B) — BASE_ID + CURRENT + 종말 부모(모든 기존 종말 run 상태). */
export function deadPredicate(t: ChildStartTables, b: WorkflowChildIdentity): SQL {
  return sql`(${baseIdPredicate(t, b)}
    and ${currentPredicate(t)}
    and ${t.parent}.status in ${WORKFLOW_CHILD_TERMINAL_RUN_STATUSES_SQL})`;
}

/** TOMBSTONE(B') — BASE_ID 의 C 절 제거 + linked+NULL + pending S + running/cancelled P. */
export function tombstonePredicate(
  t: Pick<ChildStartTables, "parent" | "invocation" | "parentStep">,
  b: WorkflowChildTombstoneIdentity,
): SQL {
  return sql`(${t.parent}.id = ${b.parentRunId}::uuid
    and ${t.parent}.company_id = ${b.companyId}::uuid
    and ${t.parentStep}.id = ${b.parentStepRunId}::uuid
    and ${t.parentStep}.workflow_run_id = ${t.parent}.id
    and ${t.parentStep}.step_id = ${b.stepId}
    and ${t.invocation}.id = ${b.invocationId}::uuid
    and ${t.invocation}.parent_step_run_id = ${t.parentStep}.id
    and ${t.invocation}.company_id = ${b.companyId}::uuid
    and ${t.invocation}.state = 'linked'
    and ${t.invocation}.generation = ${b.generation}
    and ${t.invocation}.child_run_id is null
    and ${currentPredicate(t)}
    and ${t.parentStep}.status = 'pending'
    and ${t.parent}.status in ('running', 'cancelled'))`;
}

/** U — 영수증 없음 + 자식 스텝 행 0. */
export function unmaterializedPredicate(t: Pick<ChildStartTables, "child">): SQL {
  return sql`(${t.child}.child_start_materialized_at is null
    and not exists (select 1 from workflow_step_runs cs where cs.workflow_run_id = ${t.child}.id))`;
}

/** TIME_VALID — 호출자 토큰 일치 + 임대/마감 모두 미래(DB 시계). SQL NULL 은 거짓. */
export function timeValidPredicate(t: Pick<ChildStartTables, "child">, token: string): SQL {
  return sql`(${t.child}.child_start_token = ${token}
    and ${t.child}.child_start_lease_expires_at > clock_timestamp()
    and ${t.child}.child_start_deadline_at > clock_timestamp())`;
}

/** OWNER(B, token) — AUTO + running 자식 + U + 정확한 토큰 + 생존 임대/마감. */
export function ownerPredicate(
  t: ChildStartTables,
  b: WorkflowChildIdentity,
  token: string,
): SQL {
  return sql`(${autoPredicate(t, b)}
    and ${t.child}.status = 'running'
    and ${unmaterializedPredicate(t)}
    and ${timeValidPredicate(t, token)})`;
}

/**
 * LIVE_OWNER(B) — OWNER 에서 토큰 비교를 token IS NOT NULL 로 바꾼 형태(stuck 면제 판정용).
 * NOT UNKNOWN 이 무효 소유자를 남기지 않도록 IS TRUE 로 감싸 반환한다.
 */
export function liveOwnerIsTruePredicate(
  t: ChildStartTables,
  b: WorkflowChildIdentity,
): SQL {
  return sql`(${autoPredicate(t, b)}
    and ${t.child}.status = 'running'
    and ${t.child}.child_start_token is not null
    and ${unmaterializedPredicate(t)}
    and ${t.child}.child_start_lease_expires_at > clock_timestamp()
    and ${t.child}.child_start_deadline_at > clock_timestamp()) is true`;
}
