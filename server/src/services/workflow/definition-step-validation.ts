import { unprocessable } from "../../errors.js";
import { validateWorkflowQaConfigs } from "./artifact-config-validation.js";
import { findWorkflowToolReferenceErrors, type WorkflowArtifactReferenceStep } from "./step-artifact-references.js";

/** Definition writes only. Never run this against workflow_run_definitions snapshots. */
export function assertWorkflowToolStepReferences(steps: readonly WorkflowArtifactReferenceStep[]): void {
  const errors = findWorkflowToolReferenceErrors(steps);
  if (!errors.length) return;
  const summary = errors.map(error => `step "${error.stepId}" references "${error.referencedStepId}" (${error.reason})`).join("; ");
  throw unprocessable(`Invalid workflow toolArgs references: ${summary}. Only known forward ancestor steps may be referenced.`, {
    code: "workflow_tool_reference_invalid", errors,
  });
}

/** Shared native/plugin/direct-store write boundary; omitted steps leave existing definitions unchanged. */
export function validateWorkflowDefinitionSteps(steps: readonly WorkflowArtifactReferenceStep[] | undefined): void {
  validateWorkflowQaConfigs(steps);
  if (steps) assertWorkflowToolStepReferences(steps);
}
