// server/src/services/workflow/grace-waiting-control-node-reconciler.ts
//
// [purpose] 게이트 워크프로덕트 대기창 타이머 패스. pending-wait 중인 IF 컨트롤 노드
//   (metadata.controlNodeGraceWait, nextEvaluateAt 만료)를 찾아 해당 워크플로우 런을
//   다시 실행(executeWorkflowRun)해 게이트를 재평가한다. heartbeat/sync/resume 외에
//   발화 경로가 없는 이슈 없는 컨트롤 노드의 재평가 트리거다.
// [safety] completed 노드 미건드림(과거 verdict 보존). run 상태가 running 인 경우만
//   재실행하며, active rework iteration 이 있으면 건너뛴다(다른 reconciler 와 동일).
// [descope D3] 수동 resume/native-continuation 옵션은 존재하지 않는다 — 2-arg 실행 진입이고,
//   링크 자식 run 은 전체 신원 임대 소유자만 초기화한다. 보고는 "실제 커밋된 효과"만 한다:
//   started(이 호출의 실행/재평가 커밋)와 settled(이 호출의 만료 정산 커밋)만 recovered,
//   busy/ineligible/expired/materialized 는 소유자/상태 양보라 skipped 다. 경합
//   (55P03/40P01/40001)은 실패가 아니라 skipped 다(57014 는 진단 — 원본 전파).
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import { executeWorkflowRunWithStartOutcome } from "./dag-engine.js";
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

      // 타입핑 결과로만 보고한다 — outcome kind 는 커밋된 효과의 소유만 뜻한다.
      const startOutcome = await executeWorkflowRunWithStartOutcome(db, runId);
      if (startOutcome.kind === "started") {
        results.push({
          runId,
          action: "recovered" as const,
          reason: `Re-evaluated grace-waiting control node ${runRow.stepId} (execution committed by this call)`,
        });
        continue;
      }
      if (startOutcome.kind === "settled") {
        results.push({
          runId,
          action: "recovered" as const,
          reason: "Own start-deadline settlement committed during grace reevaluation",
        });
        continue;
      }
      // busy/ineligible/expired/materialized — 이 호출의 커밋 효과 없음(양보).
      results.push({
        runId,
        action: "skipped" as const,
        reason: `Grace reevaluation yielded without committed effect (${startOutcome.kind})`,
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
