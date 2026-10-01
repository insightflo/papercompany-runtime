import { hashStructuredValue } from "../issue-execution-cards/hash.js";
import type { WorkflowStep } from "./dag-engine.js";

export type RevisionStep = WorkflowStep & { sourceStepId?: string };
/** Compare in the immediate source run's coordinates: only the target maps its references. */
export function revisionStepHash(step: RevisionStep, steps: RevisionStep[] = [], purpose: "seed" | "failure" = "seed",
  coordinates: "source" | "current" = "source") {
  const ids = new Map(steps.map(s => [s.id, coordinates === "source" ? s.sourceStepId ?? s.id : s.id]));
  const { id: _id, sourceStepId: _source, name: _name, title: _title, description: _description,
    agentName: _agentName, ...config } = step;
  const remap = (id: string) => ids.get(id) ?? id;
  // Exact native machine tokens/typed step-reference fields only; never inspect prose.
  const normalize = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") {
      if (key === "inputStepId" || key === "producerStepId" || key === "stepId") return remap(value);
      return value.replace(/\{\$steps\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)\}/g,
        (_token, id: string, field: string) => `{$steps.${remap(id)}.${field}}`);
    }
    if (Array.isArray(value)) return value.map(v => normalize(v));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .map(([k, v]) => [key === "workProductSelectors" ? remap(k) : k, normalize(v, k)]));
    return value;
  };
  const failureKeys = new Set(["agentId", "assigneeAgentId", "type", "targetWorkflowId", "wait", "inputs", "qaType",
    "toolName", "toolArgs", "tools", "toolNames", "sessionMode", "onFailure", "escalateTo", "maxRetries", "timeoutSeconds",
    "knowledgeBaseIds", "triggerOn", "dynamicChildren", "ownerPlanBootstrapOnly", "bootstrapOnly", "executionMode", "workflowMode",
    "executionControls", "conditionGroup", "graphWorkProductRequired", "autoApproveTools", "graphRetryDelaySeconds",
    "graphRetryBackoff", "graphRetryJitter", "workProductSelectors", "toolArtifactContract"]);
  const execution = purpose === "failure" ? Object.fromEntries(Object.entries(config).filter(([k]) => failureKeys.has(k))) : config;
  // The native normalizer accepts aliases, but their raw spelling is not a configuration change.
  if (purpose === "failure") {
    delete (execution as Record<string, unknown>).tools;
    delete (execution as Record<string, unknown>).toolName;
    (execution as Record<string, unknown>).type = step.type ?? "agent";
  }
  return hashStructuredValue({ schemaVersion: "workflow.execution-config.v2", purpose, ...(normalize(execution) as Record<string, unknown>),
    dependencies: step.dependencies.map(remap).sort(),
    ...(purpose === "seed" && step.dependsOn ? { dependsOn: step.dependsOn.map(remap).sort() } : {}),
    // Rework routing is not the producer's execution configuration. Seed admission separately checks topology.
    conditionalDependencies: (step.conditionalDependencies ?? [])
      .filter(e => !e.isBackEdge).map(e => ({ ...e, stepId: remap(e.stepId) })), 
  });
}
