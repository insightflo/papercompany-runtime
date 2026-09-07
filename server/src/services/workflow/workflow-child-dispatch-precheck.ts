// server/src/services/workflow/workflow-child-dispatch-precheck.ts
//
// [purpose] workflow→workflow 자식 스텝 dispatch 사전검사 모듈(0101, fix round).
//   대상 정의 존재/회사 일치 → CYCLE guard(정의 그래프 DFS) → DEPTH guard(root_run_id 체인,
//   회사 불일치 조상 fail-closed) → strict inputs 토큰 렌더(fail-closed). 하나라도 위반하면
//   기계 errorCode 로 즉시 실패 응답 — 클레임 트랜잭션 진입 전에 모든 정적 검증을 끝낸다.
// [authority] 모든 판정은 구조화 DB 레코드만 읽는다(규칙 7/8, 파싱 권위 없음).
import type { Db } from "@paperclipai/db";
import {
  workflowDefinitions,
  workflowRuns,
} from "@paperclipai/db";
import { normalizeWorkflowStepsForExecution } from "./dag-engine.js";
import type { WorkflowStep } from "./dag-engine.js";
import { resolveWorkflowToolStepArgs } from "./tool-step-args.js";
import { getWorkflowDefinitionById } from "./workflow-store.js";
import {
  ANY_UNRESOLVED_TOKEN_RE,
  WORKFLOW_CHILD_MAX_DEPTH,
  assertNoWorkflowChildDefinitionCycles,
  loadCompanyWorkflowStepGraph,
  runDepthOfParentRun,
  type NormalizedWorkflowStep,
} from "./workflow-child-guards.js";

export type WorkflowChildDispatchPrecheckInput = {
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  step: WorkflowStep;
};

export type WorkflowChildDispatchPrecheck =
  | {
    ok: true;
    target: NonNullable<Awaited<ReturnType<typeof getWorkflowDefinitionById>>>;
    renderedInputs: Record<string, string>;
    definitionSteps: ReturnType<typeof normalizeWorkflowStepsForExecution>;
  }
  | { ok: false; errorCode: string; detail: string };

/**
 * dispatch 사전검사. ok:false 면 호출자가 failChildStep(errorCode, detail) 로 스텝을 마감한다.
 */
export async function precheckWorkflowChildDispatch(
  db: Db,
  input: WorkflowChildDispatchPrecheckInput,
): Promise<WorkflowChildDispatchPrecheck> {
  const { run, definition, step } = input;
  const persisted = step as NormalizedWorkflowStep;
  const companyId = run.companyId;

  const targetWorkflowIdRaw = typeof persisted.targetWorkflowId === "string" ? persisted.targetWorkflowId.trim() : "";
  if (!targetWorkflowIdRaw) {
    return { ok: false, errorCode: "child_workflow_not_found", detail: "workflow step is missing targetWorkflowId" };
  }
  const target = await getWorkflowDefinitionById(db, targetWorkflowIdRaw);
  if (!target || target.companyId !== companyId) {
    return {
      ok: false,
      errorCode: "child_workflow_not_found",
      detail: `target workflow ${targetWorkflowIdRaw} not found in company ${companyId}`,
    };
  }

  // CYCLE guard: 대상 정의 체인이 부모 정의로 되돌아오면 거부(자기참조 포함, diamond 허용).
  const companyGraph = await loadCompanyWorkflowStepGraph(db, companyId);
  const cycleErrors = assertNoWorkflowChildDefinitionCycles(
    run.workflowId,
    companyGraph.get(run.workflowId) ?? [],
    companyGraph,
  );
  if (cycleErrors.length > 0) {
    return { ok: false, errorCode: "child_cycle_detected", detail: cycleErrors.join("; ") };
  }

  // DEPTH guard: root_run_id 체인 길이 + 1 > 3 이면 거부. 회사 불일치 조상은 fail-closed.
  const parentDepth = await runDepthOfParentRun(db, {
    parentRunId: run.parentRunId,
    rootRunId: run.rootRunId,
    companyId,
  });
  if (parentDepth + 1 > WORKFLOW_CHILD_MAX_DEPTH) {
    return {
      ok: false,
      errorCode: "child_depth_exceeded",
      detail: `child depth ${parentDepth + 1} exceeds cap ${WORKFLOW_CHILD_MAX_DEPTH}`,
    };
  }

  // STRICT inputs 렌더 — 미해결/미지 토큰이 남으면 fail-closed(child_inputs_unresolved).
  const rawInputs = persisted.inputs && typeof persisted.inputs === "object" && !Array.isArray(persisted.inputs)
    ? persisted.inputs as Record<string, unknown>
    : {};
  const definitionSteps = normalizeWorkflowStepsForExecution(definition.stepsJson);
  let rendered: unknown;
  try {
    rendered = await resolveWorkflowToolStepArgs({
      db: db,
      run: { id: run.id, companyId, runDate: run.runDate, metadata: run.metadata },
      step: { id: step.id, toolArgs: rawInputs },
      workflowSteps: definitionSteps,
    });
  } catch (error) {
    return {
      ok: false,
      errorCode: "child_inputs_unresolved",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const serialized = JSON.stringify(rendered ?? {});
  if (serialized && ANY_UNRESOLVED_TOKEN_RE.test(serialized)) {
    return {
      ok: false,
      errorCode: "child_inputs_unresolved",
      detail: `unresolved workflow token in inputs: ${ANY_UNRESOLVED_TOKEN_RE.exec(serialized)?.[0] ?? ""}`,
    };
  }
  const renderedInputs = rendered && typeof rendered === "object" && !Array.isArray(rendered)
    ? Object.fromEntries(
      Object.entries(rendered as Record<string, unknown>)
        .filter(([, value]) => typeof value === "string")
        .map(([key, value]) => [key, value as string]),
    )
    : {};

  return { ok: true, target, renderedInputs, definitionSteps };
}
