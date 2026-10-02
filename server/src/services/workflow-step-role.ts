import { resolveWorkflowQaContract } from "./workflow/workflow-qa-type.js";

export type WorkflowStepRole = "action" | "qa" | "oversight" | "unknown";

export type WorkflowStepRoleInput = {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly title?: unknown;
  readonly type?: unknown;
  readonly qaType?: unknown;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function classifyWorkflowStepRole(input: WorkflowStepRoleInput): WorkflowStepRole {
  if (resolveWorkflowQaContract(input.qaType)) return "qa";

  const type = text(input.type).toLowerCase();
  if (["qa", "validation", "validator"].includes(type)) return "qa";
  if (["approval", "oversight"].includes(type)) return "oversight";
  if (["action", "producer", "research"].includes(type)) return "action";

  // Titles, tags and IDs are display/identity fields, not role declarations.
  return "unknown";
}

export function isQaLikeStep(input: WorkflowStepRoleInput): boolean {
  return classifyWorkflowStepRole(input) === "qa";
}
