import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, workflowRuns } from "@paperclipai/db";
import { syncCancelledWorkflowRunState } from "./workflow-cancelled-state.js";
import { runWorkflowChildCompletionHook } from "./workflow-child-execution.js";
import { stopMissionRuntimesForMission } from "../missions/mission-runtime-manager.js";
import { logActivity } from "../activity-log.js";
import { cancelDescendantWorkflowRunWithChildFence, cancelWorkflowRunWithChildFence, logWorkflowRunCancellationRefused, type CancelledRunRef } from "./workflow-cancel-bridge.js";
import { syncStepRunsFromIssueState } from "./workflow-issue-state-sync.js";

export async function cancelOutstandingWorkflowIssues(
  db: Db,
  runId: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(issues)
    .set({
      status: "cancelled",
      cancelledAt: now,
      updatedAt: now,
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    })
    .where(and(
      eq(issues.originKind, "workflow_execution"),
      eq(issues.originRunId, runId),
      sql`${issues.status} not in ('done', 'cancelled')`,
    ));
}

const WORKFLOW_RUN_TERMINAL_STATUSES = new Set(["completed", "cancelled", "aborted", "failed", "timed-out"]);

export async function cancelWorkflowRunWithCleanup(
  db: Db,
  runId: string,
  companyId: string,
  options?: {
    childParentFence: {
      invocationId: string;
      generation: number;
      parentRunId: string;
      parentStepRunId: string;
    };
  },
): Promise<boolean> {
  // [descope D5 — DAG:3604/3607] 회사는 항상 호출자가 명시한다(parentRunId 유추 금지). 링크 자식은
  //   공유 전체 신원(BASE_ID/CURRENT) fence 취소 헬퍼로만 취소되고, 무효 표지 run 은 무변환 거부,
  //   plain run 은 명시적 no-child 가드가 있는 기존 조건부 취소 UPDATE 다. 상세 분류는
  //   workflow-cancel-bridge 가 담당한다(oversized 파일 밖 — 설계 §5).
  const disposition = await cancelWorkflowRunWithChildFence(db, {
    runId,
    companyId,
    suppliedFence: options?.childParentFence,
  });
  if (disposition.refusedInvalidReason) {
    await logWorkflowRunCancellationRefused(db, companyId, runId, disposition.refusedInvalidReason);
    return false;
  }
  const updatedRows: CancelledRunRef[] = disposition.rows;

  const updatedRun = updatedRows[0];
  if (!updatedRun) {
    return false;
  }

  // [workflow child fix2 P1-6] 자손 run 취소 전파 — parent_run_id 링크 BFS(회사 범위).
  //   종말 중간 run(완료된 fire-and-forget 자식 등)도 frontier 확장은 통과시키고, 취소는
  //   비종말 노드에만 적용한다 — 단일 반복 순회라 visited/깊이 상한이 전역으로 유효하다.
  //   자손을 먼저 취소해 자손 종말 hook 이 부모 waiting 스텝을 child_run_cancelled 로 마감하게 한다.
  await cancelDescendantWorkflowRuns(db, {
    rootRunId: updatedRun.id,
    companyId: updatedRun.companyId,
  });

  await cleanupCancelledWorkflowRun(db, updatedRun);
  return true;
}

/** 취소 확정된 run 1개의 정리: 이슈 취소 + 스텝 동기화 + 상위 훅 + 미션 런타임 중단. */
async function cleanupCancelledWorkflowRun(
  db: Db,
  run: { id: string; companyId: string; missionId: string | null },
): Promise<void> {
  await cancelOutstandingWorkflowIssues(db, run.id);
  await syncCancelledWorkflowRunState({
    db,
    run,
    syncStepRunsFromIssueState,
  });
  // [workflow child step] 자식 run 취소 → 부모 waiting 스텝 child_run_cancelled 마감.
  //   취소 경로의 run 상태는 항상 cancelled 이므로 리터럴로 훅을 발화한다.
  try {
    await runWorkflowChildCompletionHook(db, {
      id: run.id,
      companyId: run.companyId,
      status: "cancelled",
    });
  } catch {
    // swallowed: reconciler 가 회복한다.
  }
  if (run.missionId) {
    await stopMissionRuntimesForMission(db, {
      companyId: run.companyId,
      missionId: run.missionId,
      reason: `workflow ${run.id} cancelled`,
    });
  }
}

/**
 * [workflow child fix2 P1-6] parent_run_id 링크 전체를 순회하는 경계 취소 전파(회사 범위).
 * - 종말 중간 run 도 frontier 확장에 포함한다(그 아래 살아있는 손자 도달).
 * - 방문 집합과 깊이 상한이 순회 전체에서 공유된다(재귀 재진입으로 초기화되지 않는다).
 * - [descope D5 — DAG:3700] 링크 자식은 공유 전체 신원 fence 취소 헬퍼로만 변이하고, 무효 링크는
 *   감사 후 건너뛴다(mutate only valid links). plain 자손은 기존 조건부 UPDATE 를 유지한다.
 *   자손 1개 변이의 상세는 workflow-cancel-bridge 가 담당한다(oversized 파일 밖 — 설계 §5).
 * - 개별 자손 취소 실패는 조용히 삼키지 않고 구조화 activity 로 남긴다.
 */
async function cancelDescendantWorkflowRuns(
  db: Db,
  input: { rootRunId: string; companyId: string },
): Promise<void> {
  const visited = new Set<string>([input.rootRunId]);
  let frontier = [input.rootRunId];
  // 전역 깊이 상한: 비정상 링크 데이터(사이클/무한 체인)에서도 선형 종료를 보장한다.
  for (let depth = 0; depth < 8 && frontier.length > 0; depth++) {
    const children = await db
      .select({
        id: workflowRuns.id,
        companyId: workflowRuns.companyId,
        missionId: workflowRuns.missionId,
        status: workflowRuns.status,
        parentRunId: workflowRuns.parentRunId,
        parentStepRunId: workflowRuns.parentStepRunId,
        triggeredBy: workflowRuns.triggeredBy,
      })
      .from(workflowRuns)
      .where(and(
        eq(workflowRuns.companyId, input.companyId),
        inArray(workflowRuns.parentRunId, frontier),
      ));
    frontier = [];
    for (const child of children) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      frontier.push(child.id);
      if (WORKFLOW_RUN_TERMINAL_STATUSES.has(child.status)) continue;
      try {
        const propagated = await cancelDescendantWorkflowRunWithChildFence(db, child);
        if (!propagated) continue;
        await cleanupCancelledWorkflowRun(db, child);
        // 취소 전파 관측 기록(.activity) — 루트 취소가 자손 run 을 함께 종료시켰음을 남긴다.
        await logActivity(db, {
          companyId: input.companyId,
          actorType: "system",
          actorId: "workflow-cancel",
          action: "workflow_run.cancelled",
          entityType: "workflow_run",
          entityId: child.id,
          details: {
            propagatedFrom: input.rootRunId,
            reason: "parent workflow run cancelled",
          },
        });
      } catch (error) {
        // [fix2 P1-6] 개별 자손 취소 실패를 조용히 삼키지 않는다 — 구조화 activity 로 남기고
        // 남은 자손 전파는 계속한다(미정산 자손은 reconciler 강제 종결 경로로 회수).
        await logActivity(db, {
          companyId: input.companyId,
          actorType: "system",
          actorId: "workflow-cancel",
          action: "workflow_run.cancellation_propagation_failed",
          entityType: "workflow_run",
          entityId: child.id,
          details: {
            propagatedFrom: input.rootRunId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }
}
