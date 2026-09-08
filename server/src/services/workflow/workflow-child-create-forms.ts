// server/src/services/workflow/workflow-child-create-forms.ts
//
// [purpose] descope v1(설계 §4)의 CREATE 형 최종 변이 전용 모듈. invocation INSERT(클레임),
//   자식 run 행 INSERT(클레임 트랜잭션 내부), construction 링크 UPDATE가 각자 "단일 문장"에서
//   생성 ID + 존재하는 권위 행(부모 run/스텝/invocation/정의)을 전부 바인딩한다(D5 — INSERT
//   SELECT 의 WHERE 가 최종 변이의 신원 검증이다). 임의 exported insert(...).values(callerData)
//   탈출로는 남지 않는다. 0행 반환은 소실(fence lost) — 호출자가 전체 트랜잭션을 롤백한다.
// [authority] 내구 DB 레코드만이 권위(규칙 7/8). 모든 문장은 파라미터 바인딩 raw SQL 이다.
import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

/** CREATE 형 입력 — invocation/자식 행이 아직 없는 생성 지점의 완전 바인딩(설계 §3/§4). */
export type ChildCreateBinding = {
  companyId: string;
  parentRunId: string;
  parentStepRunId: string;
  stepId: string;
  invocationId: string;
  targetWorkflowId: string;
  /** descope v1 — 세대는 항상 1(D2). 타입으로 강제한다. */
  generation: 1;
};

/** CURRENT 절(잠긴 부모 스텝의 현재 시도) — generation=1/retryCount=0/workflowRetry 키 부재. */
const CURRENT_FRAGMENT = (stepAlias: SQL) => sql`${stepAlias}.status = 'pending'
    and ${stepAlias}.retry_count = 0
    and not (coalesce(${stepAlias}.metadata, '{}'::jsonb) ? 'workflowRetry')`;

/** 부모 정의 + 대상 정의가 같은 회사의 active 정의인지 — 클레임/생성 문장 안에서 재검증(D6 직렬화). */
const DEFINITIONS_ACTIVE_FRAGMENT = (parentRunId: SQL, targetWorkflowId: string, companyId: string) => sql`
    exists (select 1 from workflow_definitions pd
      where pd.id = (select p2.workflow_id from workflow_runs p2 where p2.id = ${parentRunId})
        and pd.company_id = ${companyId}::uuid and pd.status = 'active')
    and exists (select 1 from workflow_definitions td
      where td.id = ${targetWorkflowId}::uuid
        and td.company_id = ${companyId}::uuid and td.status = 'active')`;

/**
 * invocation 클레임 행 CREATE — 생성된 I.id 로 claimed/NULL 행을 삽입하되, 같은 문장에서
 * running 부모 + pending/retryCount0/무 retry 메타데이터 스텝 + 기존 I 부재 + generation 1 +
 * 양쪽 정의 active/동일 회사를 재검증한다(설계 §4 row "invocation-claim:208"). 0행 = 소실.
 */
export async function insertInvocationClaimRow(
  tx: Db,
  input: ChildCreateBinding,
): Promise<number> {
  const parentRunId = sql`${input.parentRunId}::uuid`;
  const result = await tx.execute(sql`
    insert into workflow_step_invocations (id, company_id, parent_step_run_id, child_run_id, state, target_workflow_id, generation)
    select ${input.invocationId}::uuid, ${input.companyId}::uuid, ${input.parentStepRunId}::uuid, null, 'claimed', ${input.targetWorkflowId}::uuid, ${input.generation}
    where exists (
        select 1
        from workflow_runs p
        join workflow_step_runs s on s.workflow_run_id = p.id and s.id = ${input.parentStepRunId}::uuid
        where p.id = ${parentRunId}
          and p.company_id = ${input.companyId}::uuid
          and p.status = 'running'
          and s.step_id = ${input.stepId}
          and ${CURRENT_FRAGMENT(sql`s`)})
      and not exists (
        select 1 from workflow_step_invocations i
        where i.parent_step_run_id = ${input.parentStepRunId}::uuid or i.id = ${input.invocationId}::uuid)
      and ${DEFINITIONS_ACTIVE_FRAGMENT(parentRunId, input.targetWorkflowId, input.companyId)}
    on conflict do nothing
    returning id`);
  return result.length;
}

/**
 * 자식 run 행 CREATE — 클레임 트랜잭션 내부에서 생성된 C.id 로 pending 자식 run 을 삽입하되,
 * 같은 문장에서 트랜잭션 로컬 claimed/NULL invocation + P/S 연관 + CURRENT + 대상 정의
 * active/동일 회사를 바인딩한다(설계 §4 row "workflow-child-execution:181"). missionId 는
 * 의도적으로 NULL — 자식 종말이 부모/형제 미션 런타임을 중단시키지 않는다.
 */
export async function insertChildWorkflowRunRow(
  tx: Db,
  input: ChildCreateBinding & { childRunId: string; renderedInputs: Record<string, string>; now: Date },
): Promise<number> {
  const parentRunId = sql`${input.parentRunId}::uuid`;
  const result = await tx.execute(sql`
    insert into workflow_runs
      (id, workflow_id, company_id, mission_id, status, triggered_by, trigger_source,
       parent_run_id, parent_step_run_id, root_run_id, metadata, created_at)
    select ${input.childRunId}::uuid, ${input.targetWorkflowId}::uuid, ${input.companyId}::uuid,
           null, 'pending', 'workflow-step', 'workflow',
           p.id, s.id, coalesce(p.root_run_id, p.id),
           jsonb_build_object('workflowChildInputs', ${JSON.stringify(input.renderedInputs)}::jsonb),
           ${input.now.toISOString()}::timestamptz
    from workflow_runs p
    join workflow_step_runs s on s.workflow_run_id = p.id and s.id = ${input.parentStepRunId}::uuid
    join workflow_step_invocations i on i.id = ${input.invocationId}::uuid and i.parent_step_run_id = s.id
    where p.id = ${parentRunId}
      and p.company_id = ${input.companyId}::uuid
      and p.status = 'running'
      and s.step_id = ${input.stepId}
      and ${CURRENT_FRAGMENT(sql`s`)}
      and i.company_id = ${input.companyId}::uuid
      and i.state = 'claimed'
      and i.child_run_id is null
      and i.generation = ${input.generation}
      -- [r8 finding 1] 보존된 대상 신원 — 클레임이 기록한 target 이 자식 run 의 정의와 일치해야 한다.
      and i.target_workflow_id = ${input.targetWorkflowId}::uuid
      and ${DEFINITIONS_ACTIVE_FRAGMENT(parentRunId, input.targetWorkflowId, input.companyId)}
    returning id`);
  return result.length;
}

/**
 * construction 링크 UPDATE — claimed/NULL invocation 을 같은 트랜잭션에서 생성한 자식 행에
 * 링크한다. BASE_ID 구성 변형: 정확한 I/P/S/C/company/generation/step 바인딩 + C 가 bound 부모를
 * 가리키는지 재검증 + child_run_id/state 만 설정(설계 §4 row "invocation-claim:255"). 0행 =
 * 전체 클레임 롤백.
 */
export async function linkInvocationToCreatedChildRow(
  tx: Db,
  input: Omit<ChildCreateBinding, "targetWorkflowId"> & { childRunId: string },
): Promise<number> {
  const result = await tx.execute(sql`
    update workflow_step_invocations i
    set child_run_id = ${input.childRunId}::uuid, state = 'linked'
    from workflow_runs p, workflow_step_runs s
    where i.id = ${input.invocationId}::uuid
      and i.parent_step_run_id = s.id
      and i.company_id = ${input.companyId}::uuid
      and i.state = 'claimed'
      and i.child_run_id is null
      and i.generation = ${input.generation}
      and s.id = ${input.parentStepRunId}::uuid
      and s.workflow_run_id = p.id
      and s.step_id = ${input.stepId}
      and p.id = ${input.parentRunId}::uuid
      and p.company_id = ${input.companyId}::uuid
      and exists (
        select 1 from workflow_runs c
        where c.id = ${input.childRunId}::uuid
          and c.company_id = ${input.companyId}::uuid
          and c.parent_run_id = p.id
          and c.parent_step_run_id = s.id
          and c.workflow_id = i.target_workflow_id)
    returning i.id`);
  return result.length;
}
