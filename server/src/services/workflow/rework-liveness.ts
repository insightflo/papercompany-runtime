import { and, eq, gt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issues,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  lifecycleActiveClause,
  lifecycleInFlightClause,
} from "../heartbeat-finalization/lifecycle-active.js";

export async function hasActiveWorkflowReworkIteration(
  db: Db,
  input: { readonly companyId: string; readonly workflowRunId: string },
): Promise<boolean> {
  // [predicate-unify 2026-11-09] step 행 status='running' 은 생존 신호가 아니다 — executor
  //   사망·heartbeat 정산 후에도 stale running step 이 남아 rework 게이트가 stuck/deadlock 수렴을
  //   영구 차단했다(orphan-run-fix-report §4-②, reconciler.ts:107·deadlock-reconciler.ts:39 보다
  //   먼저 실행되는 우선 게이트). #683 두 게이트와 같은 계약으로 좁힌다:
  //   step 행 running 은 연결된(이슈 또는 workflow_step_run_id) heartbeat run 이 lifecycle-active
  //   일 때만 활동으로 인정한다. 살아 있는 실행·레거시 이슈/heartbeat·wakeup 채널은 그대로 보호.
  //   heartbeat 채널 생존은 lifecycleInFlightClause(queued/running + v1 미정산 terminal)를 쓴다 —
  //   플래그 OFF 에서는 기존 IN ('queued','running') 과 바이트 동일하다.
  const stepExecutionLiveness = await lifecycleActiveClause(db);
  const heartbeatChannelLiveness = await lifecycleInFlightClause(db);
  const active = await db
    .select({ id: workflowStepRuns.id })
    .from(workflowStepRuns)
    .where(and(
      eq(workflowStepRuns.workflowRunId, input.workflowRunId),
      gt(workflowStepRuns.iterationIndex, 0),
      sql`(
        (
          ${workflowStepRuns.status} = 'running'
          AND EXISTS (
            SELECT 1 FROM ${heartbeatRuns}
            WHERE (
              ${heartbeatRuns.issueId} = ${workflowStepRuns.issueId}
              OR ${heartbeatRuns.workflowStepRunId} = ${workflowStepRuns.id}
            )
            AND (${stepExecutionLiveness})
          )
        )
        OR EXISTS (
          SELECT 1 FROM ${issues}
          WHERE ${issues.id} = ${workflowStepRuns.issueId}
            AND ${issues.status} IN ('in_progress', 'in_review')
        )
        OR EXISTS (
          SELECT 1 FROM ${heartbeatRuns}
          WHERE ${heartbeatRuns.issueId} = ${workflowStepRuns.issueId}
            AND (${heartbeatChannelLiveness})
        )
        OR EXISTS (
          SELECT 1 FROM ${agentWakeupRequests}
          WHERE ${agentWakeupRequests.companyId} = ${input.companyId}
            AND ${agentWakeupRequests.issueId} = ${workflowStepRuns.issueId}
            AND ${agentWakeupRequests.workflowRunId} = ${input.workflowRunId}
            AND ${agentWakeupRequests.status} IN ('queued', 'claimed', 'deferred_issue_execution')
        )
      )`,
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  return active !== null;
}
