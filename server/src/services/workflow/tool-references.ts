import type { WorkflowStep } from "./dag-engine.js";
import { STEP_MACHINE_CHECKS_TOOL } from "./step-machine-checks.js";

export function getWorkflowToolReferenceNames(steps: WorkflowStep[]): string[] {
  return Array.from(new Set(
    steps.flatMap((step) => Array.isArray(step.toolNames)
      ? step.toolNames.map((toolName) => toolName.trim()).filter(Boolean)
      : []),
  ))
    .filter((toolName) => toolName !== "delegate_to_company" && toolName !== STEP_MACHINE_CHECKS_TOOL)
    .sort((a, b) => a.localeCompare(b));
}
