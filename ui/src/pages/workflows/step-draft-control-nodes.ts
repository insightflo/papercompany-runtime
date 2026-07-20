import type { StepDraft } from "./step-draft-types.js";
import { emptyStep } from "./step-draft-defaults.js";
import {
  cloneWorkflowConditionGroup,
  defaultIfConditionGroup,
  type WorkflowControlNodeType,
} from "./workflow-control-nodes.js";

export { defaultIfConditionGroup };

export function createControlNodeStepDraft(
  type: WorkflowControlNodeType,
  id: string,
  dependsOn = "",
): StepDraft {
  return {
    ...emptyStep(),
    id: id.trim(),
    title: type === "if" ? "IF" : "Complete",
    type,
    dependsOn: type === "if" ? dependsOn.trim() : "",
    conditionGroup: cloneWorkflowConditionGroup(defaultIfConditionGroup),
    completionReason: "",
  };
}
