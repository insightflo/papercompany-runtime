import { getWorkflowToolReferenceNames } from "./tool-references.js";
import type { WorkflowStep, WorkflowToolStepExecutor, WorkflowToolStepReadinessChecker } from "./dag-engine.js";

export let workflowToolStepExecutor: WorkflowToolStepExecutor | null = null;

let workflowToolStepReadinessChecker: WorkflowToolStepReadinessChecker | null = null;

export function setWorkflowToolStepExecutor(executor: WorkflowToolStepExecutor | null): void {
  workflowToolStepExecutor = executor;
}

export function setWorkflowToolStepReadinessChecker(checker: WorkflowToolStepReadinessChecker | null): void {
  workflowToolStepReadinessChecker = checker;
}

export async function assertWorkflowToolStepsReady(input: {
  companyId: string;
  steps: WorkflowStep[];
}): Promise<void> {
  const toolNames = getWorkflowToolReferenceNames(input.steps);
  if (toolNames.length === 0) return;

  const readiness = workflowToolStepReadinessChecker
    ? await workflowToolStepReadinessChecker({ companyId: input.companyId, toolNames })
    : { available: true };
  if (!readiness.available) {
    throw new Error(`Workflow tools are unavailable: ${readiness.reason ?? "tool execution is not available."}`);
  }

  if (!workflowToolStepExecutor) {
    throw new Error("Workflow tools are unavailable: Workflow tool step executor is not configured.");
  }
}
