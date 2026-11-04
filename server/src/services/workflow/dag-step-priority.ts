import type { WorkflowStep } from "./dag-engine.js";

function workflowPriorityRank(priority: string | undefined): number {
  switch (priority) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "normal":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

export function sortWorkflowStepsByPriority(steps: WorkflowStep[]): WorkflowStep[] {
  return [...steps].sort((left, right) =>
    workflowPriorityRank(right.executionControls?.priority) - workflowPriorityRank(left.executionControls?.priority)
  );
}
