// helpers/run-reopen-guard-fixture.ts
//
// [목적] run-reopen-guard v1 (PR-2a) 테스트 픽스처 — 플래그 토글, run 조회, 거부 감사 조회,
//   이슈 없는 재시도 내부 함수 호출기를 모은다. boundary 픽스처(seedBoundaryIntegrationRun/
//   cleanupTerminalBoundaryTables)를 재사용한다.
import { eq } from "drizzle-orm";
import {
  activityLog,
  instanceSettings,
  workflowRuns,
  workflowStepRuns,
  type Db,
} from "@paperclipai/db";
import { retryIssueLessToolWorkflowStepInternal } from "../../services/workflow/retry-issue-less-manual.js";
import type { WorkflowExecutionResult } from "../../services/workflow/types.js";

export type ReopenGuardWorld = Awaited<ReturnType<
  typeof import("./run-terminal-boundary-integration-fixtures.js").seedBoundaryIntegrationRun
>>;

/** reopen-guard 플래그만 토글한다(boundary 플래그는 항상 off — 가드 단독 동작 검증). */
export async function setRunReopenGuardFlag(db: Db, enabled: boolean): Promise<void> {
  await db.delete(instanceSettings);
  await db.insert(instanceSettings).values({
    singletonKey: "default",
    general: {},
    experimental: { enableRunReopenGuardV1: enabled },
  } as never);
}

/** [run-recovery-service v1] 두 플래그를 함께 제어한다 — 복구 서비스는 가드와 함께 켤 때만 의미가 있다. */
export async function setRunRecoveryFlags(
  db: Db,
  reopenGuard: boolean,
  recoveryService: boolean,
): Promise<void> {
  await db.delete(instanceSettings);
  await db.insert(instanceSettings).values({
    singletonKey: "default",
    general: {},
    experimental: { enableRunReopenGuardV1: reopenGuard, enableRunRecoveryServiceV1: recoveryService },
  } as never);
}

export const runOf = (db: Db, runId: string) =>
  db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).then((rows) => rows[0]);

export const refusalsOf = (db: Db, runId: string) =>
  db.select().from(activityLog).where(eq(activityLog.entityId, runId))
    .then((rows) => rows.filter((row) => row.action === "workflow_run.finalization_refused"));

/**
 * 이슈 없는 재시도 내부 함수 호출기 — 실패한 issue-less tool 스텝을 대상으로
 * retryIssueLessToolWorkflowStepInternal 을 최소 컨텍스트로 호출한다.
 */
export async function callIssueLessRetry(
  db: Db,
  world: ReopenGuardWorld,
  syncStatus: WorkflowExecutionResult["status"],
): Promise<{ stepRunId: string; result: WorkflowExecutionResult } | null> {
  return retryIssueLessToolWorkflowStepInternal({
    db,
    companyId: world.companyId,
    runId: world.runId,
    stepId: "tool-1",
    loadWorkflowExecutionContext: async (loadDb, runId) => {
      const [run] = await loadDb.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
      const stepRuns = await loadDb.select().from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, runId));
      return {
        run: { id: run!.id, companyId: run!.companyId, startedAt: run!.startedAt },
        steps: [{ id: "tool-1" }],
        stepRuns,
      };
    },
    isIssueLessToolStep: (step) => step.id === "tool-1",
    resetUnlaunchedTerminalStepRuns: async (_db, rows) => rows,
    syncWorkflowRunState: async () =>
      ({ runId: world.runId, workflowId: world.workflowId, missionId: null, status: syncStatus, completedAt: null, stepRuns: [] }) as WorkflowExecutionResult,
  });
}
