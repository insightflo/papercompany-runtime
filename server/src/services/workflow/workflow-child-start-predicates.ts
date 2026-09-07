// server/src/services/workflow/workflow-child-start-predicates.ts
//
// [purpose] workflow→workflow 자식 시작의 재사용 가능 SQL 술어 전용 모듈(cycle A §1).
//   대문자명(IDENTITY/CURRENT/AUTO/UNMATERIALIZED/TIME_VALID/OWNER/OWNED_AUTO/DEAD)은 설계가
//   고정한 기계 술어다. 모든 시간 판정은 DB clock_timestamp() 기준이며, SQL NULL 은 거짓으로
//   취급해 부정형에는 IS TRUE 계열을 쓴다. 텍스트/JS 시간 권위는 금지(규칙 7/8).
// [usage] tables 에 drizzle 테이블 또는 alias() 별칭 테이블을 넣으면 된다. bound 값은 파라미터
//   바인딩된다. 술어는 잠금 하 최종 UPDATE/SELECT 에서 재평가된다(시간은 흐른다).
import { sql, type SQL } from "drizzle-orm";
import { workflowRuns, workflowStepInvocations, workflowStepRuns } from "@paperclipai/db";

export type ChildStartIntent = "automatic" | "manual-resume";

/** p=부모 run, i=invocation, s=부모 step-run, c=자식 run (drizzle 테이블/별칭 모두 허용). */
export type ChildStartTables = {
  parent: typeof workflowRuns;
  invocation: typeof workflowStepInvocations;
  parentStep: typeof workflowStepRuns;
  child: typeof workflowRuns;
};

export type ChildStartIdentityBound = {
  companyId: string;
  invocationId: string;
  generation: number;
};

/** IDENTITY — 회사/링크/부모 연결/세대/자식 ID 전체 정합. */
export function identityPredicate(t: ChildStartTables, b: ChildStartIdentityBound): SQL {
  return sql`${t.parent}.company_id = ${t.invocation}.company_id
    and ${t.child}.company_id = ${t.parent}.company_id
    and ${t.parentStep}.workflow_run_id = ${t.parent}.id
    and ${t.invocation}.parent_step_run_id = ${t.parentStep}.id
    and ${t.invocation}.id = ${b.invocationId}
    and ${t.invocation}.generation = ${b.generation}
    and ${t.invocation}.state = 'linked'
    and ${t.invocation}.child_run_id = ${t.child}.id
    and ${t.child}.parent_run_id = ${t.parent}.id
    and ${t.child}.parent_step_run_id = ${t.parentStep}.id
    and ${t.parent}.company_id = ${b.companyId}`;
}

/** CURRENT — 부모 스텝의 현재 시도(retryCount+1)가 invocation 세대와 일치. */
export function currentPredicate(t: ChildStartTables): SQL {
  return sql`${t.parentStep}.retry_count + 1 = ${t.invocation}.generation`;
}

/** AUTO — 자동 시작/정산 자격 (CURRENT 포함). */
export function autoPredicate(t: ChildStartTables): SQL {
  return sql`(${currentPredicate(t)}
    and coalesce(${t.parentStep}.metadata->'workflowRetry'->>'state', '') <> 'waiting'
    and (
      (${t.parent}.status = 'running' and ${t.parentStep}.status = 'pending')
      or (${t.parent}.status in ('running', 'completed') and ${t.invocation}.wait = false and ${t.parentStep}.status = 'completed')
    ))`;
}

/** UNMATERIALIZED — 영수증 없음 + 스텝 행 없음. */
export function unmaterializedPredicate(t: ChildStartTables): SQL {
  return sql`(${t.child}.child_start_materialized_at is null
    and not exists (select 1 from workflow_step_runs cs where cs.workflow_run_id = ${t.child}.id))`;
}

/** TIME_VALID — 호출자 토큰 일치 + 임대/마감 모두 미래 (DB 시계). SQL NULL 은 거짓. */
export function timeValidPredicate(t: ChildStartTables, token: string): SQL {
  return sql`(${t.child}.child_start_token = ${token}
    and ${t.child}.child_start_lease_expires_at > clock_timestamp()
    and ${t.child}.child_start_deadline_at > clock_timestamp())`;
}

/** OWNER(intent) — IDENTITY + CURRENT + running + UNMATERIALIZED + TIME_VALID + 의도별 자격. */
export function ownerPredicate(
  t: ChildStartTables,
  b: ChildStartIdentityBound,
  token: string,
  intent: ChildStartIntent,
): SQL {
  return sql`(${identityPredicate(t, b)}
    and ${currentPredicate(t)}
    and ${t.child}.status = 'running'
    and ${unmaterializedPredicate(t)}
    and ${timeValidPredicate(t, token)}
    and ${intent === "manual-resume" ? sql`true` : autoPredicate(t)})`;
}

/**
 * OWNED_AUTO — OWNER(automatic)에서 토큰 비교를 token IS NOT NULL 로 바꾼 형태.
 * stuck 면제 판정용. NOT UNKNOWN 이 무효 소유자를 남기지 않도록 IS TRUE 로 감싸 반환한다.
 */
export function ownedAutoIsTruePredicate(t: ChildStartTables, b: ChildStartIdentityBound): SQL {
  return sql`(${identityPredicate(t, b)}
    and ${currentPredicate(t)}
    and ${t.child}.status = 'running'
    and ${t.child}.child_start_token is not null
    and ${unmaterializedPredicate(t)}
    and ${t.child}.child_start_lease_expires_at > clock_timestamp()
    and ${t.child}.child_start_deadline_at > clock_timestamp()
    and ${autoPredicate(t)}) is true`;
}

/** DEAD — 죽은 부모(failed/cancelled/aborted/timed-out, 또는 완료+wait:true). */
export function deadParentPredicate(t: Pick<ChildStartTables, "parent" | "invocation">): SQL {
  return sql`(${t.parent}.status in ('failed', 'cancelled', 'aborted', 'timed-out')
    or (${t.parent}.status = 'completed' and ${t.invocation}.wait = true))`;
}

/**
 * 수동 의도가 OWNER 검증에서 우회하는 항목 문서화 상수(부모 상태/스텝 상태/retry-wait 만 우회;
 * IDENTITY/CURRENT/company/시간/비종말/미 materialized 는 유지).
 */
export const MANUAL_BYPASS_DESCRIPTION =
  "manual-resume bypasses parent status, parent step status and retry-wait restrictions only";
