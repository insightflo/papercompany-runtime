import type { Db } from "@paperclipai/db";
import { readWorkflowRunWithStepRuns } from "./workflow-run-step-read.js";
import { loadExecutionDefinition } from "./execution-definition.js";
import { projectExecutionDefinition } from "./execution-definition-view.js";
import type { WorkflowExecutionContext } from "./dag-engine.js";

/**
 * [파일 목적] Task5a2a: dag-engine 의 loadWorkflowExecutionContext 1:1 추출.
 *   run/definition/step-runs 는 child-start 일관 읽기 헬퍼로 함께 읽고, steps 는
 *   실행정의 로더 결과(캡처 snapshot 또는 legacy_current fallback)로 유지한다.
 *   steps 는 생성 시 1회 정규화된 값이므로 절대 다시 buildWorkflowExecutionSteps/
 *   normalizeWorkflowStepsForExecution 에 넣지 않는다.
 * [순환 방지] dag-engine 타입은 import type 으로만 참조한다(런타임 cycle 없음).
 *   로더가 ensureStepRunRecords/control/revive/status mutation 보다 먼저 실행된다는
 *   상위 계약은 dag-engine 의 syncWorkflowRunState 호출 순서가 보장한다.
 */
export async function loadWorkflowExecutionContext(db: Db, runId: string): Promise<WorkflowExecutionContext> {
  const read = await readWorkflowRunWithStepRuns(db, runId, { requireDefinition: true });
  if (!read || !read.definition) {
    throw new Error(`Workflow run ${runId} not found`);
  }
  const { run, definition, stepRuns } = read;
  const execution = await loadExecutionDefinition(db, runId, { requireHistorical: false });
  const steps = execution.steps;
  return { run, definition: projectExecutionDefinition(definition, execution), steps, stepRuns };
}
