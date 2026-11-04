import type { WorkflowStep } from "./dag-engine.js";

export function getSingleToolStepName(step: WorkflowStep): string {
  const toolNames = Array.isArray(step.toolNames)
    ? step.toolNames.map((toolName) => toolName.trim()).filter(Boolean)
    : [];
  if (toolNames.length !== 1) {
    throw new Error(`Workflow tool step "${step.id}" requires exactly one toolName; received ${toolNames.length}.`);
  }
  const toolName = toolNames[0];
  if (!toolName) {
    throw new Error(`Workflow tool step "${step.id}" requires exactly one toolName; received 0.`);
  }
  return toolName;
}
