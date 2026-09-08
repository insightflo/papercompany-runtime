// server/src/services/workflow/workflow-run-step-read.ts
//
// [purpose] [cycle B F8] run + step-run 일관 읽기 전용 모듈. workflow_runs LEFT JOIN
//   workflow_step_runs 를 "한 문장"으로 읽어 {run, stepRuns} 를 반환한다. 기존의 run 단독 SELECT +
//   step 단독 SELECT 2문장 구조는 찢어진 읽기(torn read) 표면이며, 두 번째 빈 step SELECT 는
//   r4 DuplicateSteps 프록시 배리어가 가로채는 대상이었다(무한 대기 원인).
// [contract]
//   - run 행이 없으면 null. 존재하지만 step 행이 0개면 step=null 조인 행 1개를 []로 사상한다.
//   - null 필터는 "자식 측이 null인 행만" — 실제 step 행은 모두 보존된다(LIMIT 금지).
//   - requireDefinition:true 는 기존 loadWorkflowExecutionContext 의 같은 run 정의 INNER JOIN 을
//     같은 문장에 추가한다. run 또는 정의가 없으면 0행 → null(기존 "not found" 오류 보존은
//     호출자 몫). requireDefinition:false 는 정의 없는 스냅숏 읽기다.
//   - LIMIT 1 금지 — WHERE run.id 는 이미 run 1행을 선택하고, 조인된 모든 step 을 사상해야 한다.
// [authority] 읽기 전용 — 잠금/상태 쓰기/외부 호출 없음(규칙 7/8).
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";

export type WorkflowRunStepRead = {
  run: typeof workflowRuns.$inferSelect;
  /** requireDefinition:false 인 경우 항상 null. */
  definition: typeof workflowDefinitions.$inferSelect | null;
  stepRuns: Array<typeof workflowStepRuns.$inferSelect>;
};

/**
 * run + (조인된) step-run 행을 한 문장으로 읽는다. 정의가 필요하면 같은 문장에 INNER JOIN 한다.
 * run 누락(또는 정의 요구 시 정의 누락)은 null — 호출자가 기존 오류/스냅숏 계약을 유지한다.
 */
export async function readWorkflowRunWithStepRuns(
  db: Db,
  runId: string,
  options: { requireDefinition: boolean },
): Promise<WorkflowRunStepRead | null> {
  if (options.requireDefinition) {
    const rows = await db
      .select({ run: workflowRuns, definition: workflowDefinitions, step: workflowStepRuns })
      .from(workflowRuns)
      .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
      .leftJoin(workflowStepRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
      .where(eq(workflowRuns.id, runId));
    const head = rows[0];
    if (!head) return null;
    return {
      run: head.run,
      definition: head.definition,
      stepRuns: rows.flatMap((row) => (row.step === null ? [] : [row.step])),
    };
  }
  const rows = await db
    .select({ run: workflowRuns, step: workflowStepRuns })
    .from(workflowRuns)
    .leftJoin(workflowStepRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .where(eq(workflowRuns.id, runId));
  const head = rows[0];
  if (!head) return null;
  return {
    run: head.run,
    definition: null,
    stepRuns: rows.flatMap((row) => (row.step === null ? [] : [row.step])),
  };
}
