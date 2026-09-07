// server/src/services/workflow/workflow-run-execution.ts
//
// [purpose] 실행 진입 래퍼/타입 전용 모듈(cycle A §7/§12). dag-engine 의 줄 수 예산을 지키기 위해
//   executeWorkflowRunWithStartOutcome / executeWorkflowRun / WorkflowRunExecutionOutcome 을 이
//   곳으로 이관했다. dag-engine 은 공개 표면을 재노출(re-export)하므로 기존 import 경로는 유지된다.
//   sync 훅은 타입핑된 소유 결과(synced/not-owner/busy)를 전달한다 — 실행 스냅숏과 소유를 분리.
// [authority] 내구 레코드만이 권위(규칙 7/8) — outcome 은 스냅숏 status/텍스트에서 추론하지 않는다.
import type { Db } from "@paperclipai/db";
import {
  assertWorkflowToolStepsReady,
  getWorkflowExecutionResultSnapshot,
  loadWorkflowExecutionContext,
  syncWorkflowRunStateWithOutcome,
  type WorkflowStep,
} from "./dag-engine.js";
import type { WorkflowExecutionResult } from "./types.js";
import { activatePlanningMissionForWorkflowRun } from "../missions/mission-workflow-lifecycle.js";
import { validateStructuralGateReadinessForSteps } from "./control-flow/structural-gate-readiness.js";
import { getStructuralTopologyErrors } from "./control-flow/structural-topology.js";
import { runWorkflowChildCompletionHook } from "./workflow-child-execution.js";
import {
  executeWorkflowRunStart,
  type WorkflowExecutionResultLite,
  type WorkflowRunStartHooks,
  type WorkflowRunStartOutcome,
} from "./workflow-run-start.js";

/**
 * Executes a workflow run.
 *
 * @param db - Database instance.
 * @param runId - The workflow run ID to execute.
 * @param tx - Optional transaction for atomic execution.
 * @returns Execution result.
 */
export type WorkflowRunExecutionOutcome = {
  // [cycle A §7] 'settled' — 이 호출의 만료 정산 변이자가 이긴 경우(종말 스냅숏 포함).
  kind: "started" | "busy" | "ineligible" | "materialized" | "expired" | "settled";
  result: WorkflowExecutionResult;
};

/**
 * [fix4 §2.2/§4, cycle A §7] 실행 진입 오케스트레이션 — 링크된 자식은 임대 소유자만 readiness
 * 이후 초기화/fence sync 에 도달한다(creator race/duplicate steps 차단). 공개 API는 result 만
 * 반환하고, creator/recovery는 타입핑된 outcome 헬퍼를 사용한다.
 */
export async function executeWorkflowRunWithStartOutcome(
  db: Db,
  runId: string,
  options?: {
    intent?: "manual-resume" | "native-continuation";
    /** [cycle B F3] prepareManualChildResume 이 발급한 수동 fence — 토큰 연속성 보장. */
    preparedChildStartFence?: import("./workflow-child-start-state.js").ChildStartFence;
  },
): Promise<WorkflowRunExecutionOutcome> {
  const outcome: WorkflowRunStartOutcome = await executeWorkflowRunStart(db, runId, options, HOOKS);
  return { kind: outcome.kind, result: outcome.result as unknown as WorkflowExecutionResult };
}

export async function executeWorkflowRun(
  db: Db,
  runId: string,
  options?: {
    intent?: "manual-resume" | "native-continuation";
    preparedChildStartFence?: import("./workflow-child-start-state.js").ChildStartFence;
  },
): Promise<WorkflowExecutionResult> {
  return (await executeWorkflowRunWithStartOutcome(db, runId, options)).result;
}

const HOOKS: WorkflowRunStartHooks = {
  loadContext: async (loadDb, id) => await loadWorkflowExecutionContext(loadDb, id),
  assertToolsReady: async (input) => {
    await assertWorkflowToolStepsReady({
      companyId: input.companyId,
      steps: input.steps as WorkflowStep[],
    });
  },
  validateStructural: async (input) => {
    // [Hybrid QA] Persisted runtime execution: a structural gate must fail closed here too.
    return await validateStructuralGateReadinessForSteps({
      db: input.db,
      companyId: input.companyId,
      steps: input.steps as WorkflowStep[],
    });
  },
  structuralTopologyErrors: (steps) => getStructuralTopologyErrors(steps as WorkflowStep[]),
  activateMission: async (tx, input) => {
    await activatePlanningMissionForWorkflowRun(tx as unknown as Db, input);
  },
  // [cycle A §7] 타입핑된 소유 결과를 그대로 전달한다(공개 래퍼가 result 를 풀어 쓴다).
  sync: async (syncDb, id, _source, syncOptions) => {
    const outcome = await syncWorkflowRunStateWithOutcome(syncDb, id, "workflow_execution", syncOptions);
    return { kind: outcome.kind, result: outcome.result as unknown as WorkflowExecutionResultLite };
  },
  snapshot: async (snapDb, id) => {
    const snap = await getWorkflowExecutionResultSnapshot(snapDb, id);
    if (!snap) throw new Error(`Workflow run disappeared before execution start: ${id}`);
    return snap;
  },
  childCompletionHook: async (hookDb, input) => {
    return await runWorkflowChildCompletionHook(hookDb, input);
  },
};
