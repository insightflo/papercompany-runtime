// server/src/services/workflow/grace-waiting-control-node-reconciler.ts
//
// [purpose] 게이트 워크프로덕트 대기창 타이머 패스. pending-wait 중인 IF 컨트롤 노드
//   (metadata.controlNodeGraceWait, nextEvaluateAt 만료)를 찾아 해당 워크플로우 런을
//   기존 sync 경로로 게이트를 재평가한다(최초 시작 선점은 요청하지 않는다). heartbeat/sync/resume 외에
//   발화 경로가 없는 이슈 없는 컨트롤 노드의 재평가 트리거다.
// [safety] completed 노드 미건드림(과거 verdict 보존). run 상태가 running 인 경우만
//   재실행하며, active rework iteration 이 있으면 건너뛴다(다른 reconciler 와 동일).
// [descope D3] 링크 자식의 신원/초기화 소유권과 취소 검사는 기존 sync 경계가 보존한다.
//   synced 만 recovered, not-owner/busy 는 skipped 로 실제 sync 결과를 보고한다. 경합
//   (55P03/40P01/40001)은 실패가 아니라 skipped 다(57014 는 진단 — 원본 전파).
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import { syncWorkflowRunStateWithOutcome } from "./dag-engine.js";
import { readControlNodeGraceWait } from "./control-flow/gate-work-product-grace.js";
import { hasActiveWorkflowReworkIteration } from "./rework-liveness.js";
import { isChildStartContention } from "./workflow-child-start-contention.js";
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

      // 이미 running인 후보는 최초 시작이 아니라 소유권을 검사하는 기존 sync로 재평가한다.
      const syncOutcome = await syncWorkflowRunStateWithOutcome(db, runId, "workflow_reconciler", { requireRunning: true });
      if (syncOutcome.kind === "synced") {
        results.push({
          runId,
          action: "recovered" as const,
          reason: `Re-evaluated grace-waiting control node ${runRow.stepId} (execution committed by this call)`,
        });
        continue;
      }
      // not-owner/busy — 이 호출의 커밋 효과 없음(양보).
      results.push({
        runId,
        action: "skipped" as const,
        reason: `Grace reevaluation yielded without committed effect (${syncOutcome.kind})`,
      });
    } catch (error) {
      // [설계 §3] 경합은 실패가 아니다 — bounded busy/skipped, 실행 행 무변경.
      if (isChildStartContention(error)) {
        results.push({
          runId,
          action: "skipped",
          reason: "Grace reevaluation lost a lock race; execution rows unchanged",
        });
        continue;
      }
      results.push({
        runId,
        action: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
