import type { WorkflowStep } from "./dag-engine.js";
/** Preserve the DAG predicate; the mission ownership predicate intentionally differs. */
export function isIssueLessToolStep(step: WorkflowStep): boolean {
  const hasToolNames = Array.isArray(step.toolNames)
    && step.toolNames.some((toolName) => typeof toolName === "string" && toolName.trim().length > 0);
  const agentId = typeof step.agentId === "string" ? step.agentId.trim() : "";
  const persistedStep = step as WorkflowStep & { type?: string; agentName?: string };
  const stepType = typeof persistedStep.type === "string" ? persistedStep.type.trim().toLowerCase() : "";
  const agentName = typeof persistedStep.agentName === "string" ? persistedStep.agentName.trim() : "";
  if (stepType === "agent" || agentName.length > 0) return false;
  return hasToolNames && agentId.length === 0;
}
