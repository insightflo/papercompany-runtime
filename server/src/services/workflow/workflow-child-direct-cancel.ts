// server/src/services/workflow/workflow-child-direct-cancel.ts
//
// [purpose] r8 finding 3 — 운영자의 "직접" 링크 자식 취소 전용 writer. 기존
//   claimCancelledChildRunWithParentFence 는 DEAD 부모만 취소하는 전파 정산(propagated
//   cleanup) 전용으로 그대로 유지되며, 이 writer 는 살아있는 부모 아래의 유효 비종말 자식도
//   취소한다(운영자 취소의 인가 기준 — 부모 상태를 강제로 바꾸지는 않는다). 자신의 트랜잭션에서
//   generation===1 검증 후 P→I→S→C 전체 신원 잠금을 획득하고, C 를 갱신 대상으로 하는 단일
//   UPDATE(r8 §3 — C self-join 없음)에서 모든 바인딩을 재평가한다. 토큰/임대는 함께 정리하고,
//   startedAt/영수증/불변 마감은 보존한다. 부모/부모 스텝은 이 writer 가 변경하지 않는다 — 취소
//   이후의 completion hook(child_run_cancelled 부모 스텝 실패 → native 동기화)는 기존 경로다.
//   불법 링크(스텝 행+무영수증 등)는 수리하지 않고 거부한다(0행).
// [authority] 내구 레코드만이 권위(규칙 7/8). 경합은 busy, 알 수 없는 오류는 전파한다.
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { withLockedChildStartIdentity } from "./workflow-child-start-state.js";
import { isChildStartContention } from "./workflow-child-start-contention.js";
import type { ChildStartIdentity } from "./workflow-child-start-state.js";

export type DirectCancelResult =
  | { outcome: "cancelled"; rows: Array<{ id: string; companyId: string; missionId: string | null }> }
  | { outcome: "busy" };

/**
 * 직접 취소 — DEAD 요구 없음(운영자 인가), AUTO 요구 없음. UPDATE 대상은 C 자신이고 모든
 * P/I/S 신원 + linked invocation + 대상 정의 일치(i.target_workflow_id=c.workflow_id) + 비종말
 * 상태를 같은 문장에서 재평가한다. 0행이면 취소 불성립(종말/신원 불일치) — 호출자가 false 로
 * 보고하는 기존 bridge 계약이다.
 */
export async function claimDirectlyCancelledLinkedChildRun(
  db: Db,
  identity: ChildStartIdentity,
): Promise<DirectCancelResult> {
  // [D2] 구세대 신원은 잠금 전에 거부한다(fail-closed — 세대는 신원 확인이지 능력이 아니다).
  if (identity.generation !== 1) return { outcome: "cancelled", rows: [] };
  try {
    const rows = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const ctx = await withLockedChildStartIdentity(txDb, identity);
      if (!ctx) return [];
      // 불법 초기화 상태(스텝 행 + 무영수증)는 취소로 수리하지 않는다(fail-closed).
      if (ctx.child.childStartMaterializedAt === null) {
        const [{ count }] = await txDb
          .select({ count: sql<number>`count(*)::int` })
          .from(workflowStepRuns)
          .where(eq(workflowStepRuns.workflowRunId, ctx.child.id));
        if (count > 0) return [];
      }
      return await txDb
        .update(workflowRuns)
        .set({
          status: "cancelled",
          completedAt: sql`clock_timestamp()`,
          childStartToken: null,
          childStartLeaseExpiresAt: null,
        })
        .where(and(
          eq(workflowRuns.id, identity.childRunId),
          eq(workflowRuns.companyId, identity.companyId),
          // [r8 §3] 최종 문장이 전체 바인딩을 재평가한다(잠금 대기 중 상태 변경 방어).
          sql`exists (select 1
            from workflow_runs wdc_p, workflow_step_invocations wdc_i, workflow_step_runs wdc_s
            where wdc_p.id = ${identity.parentRunId}::uuid
              and wdc_p.company_id = ${identity.companyId}::uuid
              and wdc_s.id = ${identity.parentStepRunId}::uuid
              and wdc_s.workflow_run_id = wdc_p.id
              and wdc_s.step_id = ${identity.stepId}
              and wdc_s.retry_count = 0
              and not (coalesce(wdc_s.metadata, '{}'::jsonb) ? 'workflowRetry')
              and wdc_i.id = ${identity.invocationId}::uuid
              and wdc_i.parent_step_run_id = wdc_s.id
              and wdc_i.company_id = ${identity.companyId}::uuid
              and wdc_i.state = 'linked'
              and wdc_i.generation = ${identity.generation}
              and wdc_i.generation = 1
              and wdc_i.child_run_id = workflow_runs.id
              and wdc_i.target_workflow_id = workflow_runs.workflow_id
              and workflow_runs.parent_run_id = wdc_p.id
              and workflow_runs.parent_step_run_id = wdc_s.id
              and workflow_runs.status in ('pending', 'running'))`,
        ))
        .returning({ id: workflowRuns.id, companyId: workflowRuns.companyId, missionId: workflowRuns.missionId });
    });
    return { outcome: "cancelled", rows };
  } catch (error) {
    // [설계 §3] 구조화 경합만 busy — 성공 보고 없이 기존 호출 계약을 유지한다.
    if (isChildStartContention(error)) return { outcome: "busy" };
    throw error;
  }
}
