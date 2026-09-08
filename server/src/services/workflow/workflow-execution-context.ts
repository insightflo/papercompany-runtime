import { eq } from "drizzle-orm";
import { workflowDefinitions, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { loadExecutionDefinition } from "./execution-definition.js";
import { projectExecutionDefinition } from "./execution-definition-view.js";
import type { WorkflowExecutionContext } from "./dag-engine.js";

/**
 * [파일 목적] Task5a2a: dag-engine 의 loadWorkflowExecutionContext 1:1 추출.
 *   기존 run/definition join 과 step-runs 쿼리/에러 동작을 그대로 유지하고, steps 만
 *   실행정의 로더 결과(캡처 snapshot 또는 legacy_current fallback)로 대체한다.
 *   steps 는 생성 시 1회 정규화된 값이므로 절대 다시 buildWorkflowExecutionSteps/
 *   normalizeWorkflowStepsForExecution 에 넣지 않는다.
 * [순환 방지] dag-engine 타입은 import type 으로만 참조한다(런타임 cycle 없음).
 *   로더가 ensureStepRunRecords/control/revive/status mutation 보다 먼저 실행된다는
 *   상위 계약은 dag-engine 의 syncWorkflowRunState 호출 순서가 보장한다.
 */
export async function loadWorkflowExecutionContext(db: Db, runId: string): Promise<WorkflowExecutionContext> {
  const runResult = await db
    .select({
      run: workflowRuns,
      definition: workflowDefinitions,
    })
    .from(workflowRuns)
    .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
    .where(eq(workflowRuns.id, runId))
    .limit(1);

  if (!runResult[0]) {
    throw new Error(`Workflow run ${runId} not found`);
  }

  const { run, definition } = runResult[0] as {
    run: typeof workflowRuns.$inferSelect;
    definition: typeof workflowDefinitions.$inferSelect;
  };
  const execution = await loadExecutionDefinition(db, runId, { requireHistorical: false });
  const steps = execution.steps;
  const stepRuns = await db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, runId));

  return { run, definition: projectExecutionDefinition(definition, execution), steps, stepRuns };
}
