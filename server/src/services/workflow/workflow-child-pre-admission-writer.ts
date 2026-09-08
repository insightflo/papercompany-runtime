// server/src/services/workflow/workflow-child-pre-admission-writer.ts
//
// [purpose] r8 — pre-admission 형 정산 전용 모듈(파일 크기 한도 분리). invocation 이 아직 없는
// 클레임 이전 실패의 최종 변이다: 부모 전용 바인딩(P/S/step 신원 + CURRENT + P running/cancelled)
// + invocation 부재 조건. 갱신 대상 S 를 직접 name 하는 술어만 사용한다(r8 §2 — 별칭 self-join
// 스테일 판정 금지). 0행은 typed no-op, 승자 커밋 후 전이/동기화는 커밋된 handle 로 실행한다.
// [authority] 내구 DB 레코드만이 권위(규칙 7/8).
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  recordSettlementWin,
  type SettlementWinner,
} from "./workflow-child-settlement-support.js";

export async function failPreAdmissionChildStep(
  db: Db,
  input: {
    companyId: string;
    parentRunId: string;
    parentStepRunId: string;
    stepId: string;
    errorCode: string;
    detail: string;
  },
): Promise<{ outcome: "settled" | "no-op" }> {
  const nowIso = new Date().toISOString();
  const result = await db.execute(sql`
    update workflow_step_runs
    set status = 'failed',
      started_at = coalesce(workflow_step_runs.started_at, ${nowIso}::timestamptz),
      completed_at = ${nowIso}::timestamptz,
      last_dispatch_error_at = ${nowIso}::timestamptz,
      last_dispatch_error_summary = ${input.errorCode}::text,
      metadata = coalesce(workflow_step_runs.metadata, '{}'::jsonb) || jsonb_build_object('toolResult', jsonb_build_object(
        'toolName', 'workflow', 'success', false, 'stdout', null,
        'data', jsonb_build_object('ok', false, 'errorCode', ${input.errorCode}::text, 'detail', ${input.detail}::text),
        'stderr', ${input.errorCode}::text, 'exitCode', 1, 'error', ${input.errorCode}::text, 'completedAt', ${nowIso}::text))
    from workflow_runs p
    where workflow_step_runs.id = ${input.parentStepRunId}::uuid
      and workflow_step_runs.workflow_run_id = p.id
      and workflow_step_runs.step_id = ${input.stepId}
      and workflow_step_runs.status = 'pending'
      and workflow_step_runs.retry_count = 0
      and not (coalesce(workflow_step_runs.metadata, '{}'::jsonb) ? 'workflowRetry')
      and p.id = ${input.parentRunId}::uuid
      and p.company_id = ${input.companyId}::uuid
      and p.status in ('running', 'cancelled')
      and not exists (
        select 1 from workflow_step_invocations i where i.parent_step_run_id = workflow_step_runs.id)
    returning workflow_step_runs.id as "stepRunId", workflow_step_runs.status as "toStatus", workflow_step_runs.status_transition_version as "transitionVersion", workflow_step_runs.issue_id as "issueId", p.id as "runId", p.company_id as "companyId", p.mission_id as "missionId"`);
  const winner = result[0] as unknown as SettlementWinner | undefined;
  if (!winner) return { outcome: "no-op" };
  try {
    await recordSettlementWin(db, winner);
  } catch {
    // 2차 기록 실패 — 소유 정산은 커밋됐다.
  }
  return { outcome: "settled" };
}
