// server/src/services/workflow/grace-waiting-control-node-reconciler.ts
//
// [purpose] 게이트 워크프로덕트 대기창 타이머 패스. pending-wait 중인 IF 컨트롤 노드
//   (metadata.controlNodeGraceWait, nextEvaluateAt 만료)를 찾아 해당 워크플로우 런을
//   다시 실행(executeWorkflowRun)해 게이트를 재평가한다. heartbeat/sync/resume 외에
//   발화 경로가 없는 이슈 없는 컨트롤 노드의 재평가 트리거다.
// [safety] completed 노드 미건드림(과거 verdict 보존). run 상태가 running 인 경우만
//   재실행하며, active rework iteration 이 있으면 건너뛴다(다른 reconciler 와 동일).
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import { executeWorkflowRun } from "./dag-engine.js";
import { readControlNodeGraceWait } from "./control-flow/gate-work-product-grace.js";
import { hasActiveWorkflowReworkIteration } from "./rework-liveness.js";
import type { ReconciliationResult } from "./reconciler.js";

export async function reconcileGraceWaitingControlNodes(
  db: Db,
  now: Date = new Date(),
): Promise<ReconciliationResult[]> {
  const waitingRuns = await db
    .select({
      id: workflowStepRuns.id,
      workflowRunId: workflowStepRuns.workflowRunId,
      stepId: workflowStepRuns.stepId,
      metadata: workflowStepRuns.metadata,
      runStatus: workflowRuns.status,
      companyId: workflowRuns.companyId,
    })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
    .where(and(
      eq(workflowStepRuns.status, "pending"),
      isNull(workflowStepRuns.issueId),
      eq(workflowRuns.status, "running"),
    ));

  const dueRunIds = new Set<string>();
  for (const row of waitingRuns) {
    const wait = readControlNodeGraceWait(row.metadata);
    if (!wait) continue;
    const nextMs = Date.parse(wait.nextEvaluateAt);
    if (!Number.isFinite(nextMs) || now.getTime() < nextMs) continue;
    dueRunIds.add(row.workflowRunId);
  }

  const results: ReconciliationResult[] = [];
  const rowByRunId = new Map(waitingRuns.map((row) => [row.workflowRunId, row]));
  for (const runId of dueRunIds) {
    const runRow = rowByRunId.get(runId);
    if (!runRow) continue;
    try {
      if (await hasActiveWorkflowReworkIteration(db, {
        companyId: runRow.companyId,
        workflowRunId: runId,
      })) continue;

      await executeWorkflowRun(db, runId);
      results.push({
        runId,
        action: "recovered",
        reason: `Re-evaluated grace-waiting control node ${runRow.stepId}`,
      });
    } catch (error) {
      results.push({
        runId,
        action: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
