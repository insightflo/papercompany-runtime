// [파일 목적] 워크플로우 분류/필터 헬퍼 (루트+list 공유).
// [외부 연결] ./workflow-page-types.js.
// [주의] 동작 변경 없이. 루트 Workflows.tsx 역참조 금지.
import type { WorkflowRunSummary, WorkflowSummary } from "./workflow-page-types.js";

export function hasRecurringWorkflowTrigger(workflow: WorkflowSummary): boolean {
  return Boolean(
    (typeof workflow.schedule === "string" && workflow.schedule.trim())
    || (workflow.triggerLabels ?? []).length > 0,
  );
}


export function isManualMissionPlanWorkflow(workflow: WorkflowSummary): boolean {
  const record = workflow as Record<string, unknown>;
  const sourceKind = typeof record.sourceKind === "string" ? record.sourceKind : "";
  const source = typeof record.source === "string" ? record.source : "";
  if (sourceKind === "manual_mission" || source === "manual_mission") return true;

  const name = workflow.name.trim();
  if (name.startsWith("PAQO WBS:")) return true;

  if (hasRecurringWorkflowTrigger(workflow)) return false;

  if (workflow.executionMode === "dynamic_owner_plan" || workflow.dynamicPlanBootstrapOnly === true) {
    return true;
  }

  return workflow.steps.some((step) => {
    const title = step.title.trim();
    return (
      /^action-\d+-/i.test(step.id)
      || /^qa-\d*-/i.test(step.id)
      || title.startsWith("[ACTION]")
      || title.startsWith("[QA]")
      || title === "Verify mission result"
      || step.executionMode === "dynamic_owner_plan"
      || step.ownerPlanBootstrapOnly === true
      || step.dynamicChildren === true
    );
  });
}


export function filterRunsForWorkflows(
  runs: WorkflowRunSummary[],
  workflows: WorkflowSummary[],
): WorkflowRunSummary[] {
  const workflowIds = new Set(workflows.map((workflow) => workflow.id));
  const workflowNames = new Set(workflows.map((workflow) => workflow.name));
  return runs.filter((run) => {
    if (run.workflowId && workflowIds.has(run.workflowId)) return true;
    return workflowNames.has(run.workflowName);
  });
}
