import type { PluginEntityRecord } from "@paperclipai/plugin-sdk";

import { STEP_STATUSES } from "./constants.js";
import type { WorkflowStep } from "./dag-engine.js";
import type {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStepRun,
} from "./workflow-store.js";

export type WorkflowRunRecord = PluginEntityRecord & { data: WorkflowRun };
export type WorkflowStepRunRecord = PluginEntityRecord & { data: WorkflowStepRun };
export type WorkflowDefinitionRecord = PluginEntityRecord & { data: WorkflowDefinition };
type StepAgentMetadata = WorkflowStep & {
  agent?: string;
  agentName?: string;
  assigneeAgentName?: string;
};

export const TERMINAL_STEP_STATUSES = new Set<string>([
  STEP_STATUSES.done,
  STEP_STATUSES.failed,
  STEP_STATUSES.skipped,
  STEP_STATUSES.escalated,
]);

export function toWorkflowRunRecord(record: PluginEntityRecord): WorkflowRunRecord {
  return record as WorkflowRunRecord;
}

export function toWorkflowStepRunRecord(record: PluginEntityRecord): WorkflowStepRunRecord {
  return record as WorkflowStepRunRecord;
}

export function toWorkflowDefinitionRecord(record: PluginEntityRecord): WorkflowDefinitionRecord {
  return record as WorkflowDefinitionRecord;
}

export function findStepDefinition(definition: WorkflowDefinitionRecord, stepId: string): WorkflowStep | null {
  return definition.data.steps.find((step: WorkflowStep) => step.id === stepId) ?? null;
}

export function getStepAgentNameHint(stepDef: WorkflowStep): string | null {
  const stepMeta = stepDef as StepAgentMetadata;
  const candidates = [stepMeta.agentName, stepMeta.agent, stepMeta.assigneeAgentName];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

export function getStepAgentName(stepRun: WorkflowStepRunRecord, stepDef: WorkflowStep): string | null {
  if (typeof stepRun.data.agentName === "string" && stepRun.data.agentName.trim()) {
    return stepRun.data.agentName.trim();
  }

  return getStepAgentNameHint(stepDef);
}
