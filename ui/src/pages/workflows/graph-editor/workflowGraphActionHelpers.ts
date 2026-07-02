import { parseOptionalPositiveInteger, type StepDraft } from "../step-draft.js";
import {
  parseDependencies,
  type WorkflowGraphContainerType,
  type WorkflowGraphPaletteNodeKind,
  type WorkflowGraphSelectionMode,
} from "../workflow-graph.js";

type StepWithId = { id: string };

type GroupAssignment = {
  id: string;
  title: string;
  color: string;
};

type ContainerAssignment = {
  id: string;
  type: WorkflowGraphContainerType;
  title: string;
  description: string;
  mode: string;
  condition: string;
  iterator: string;
  skipFailure: boolean;
  runInParallel: boolean;
  parallelism: number | undefined;
};

export function getFirstNewStepId<TStep extends StepWithId>(previousSteps: TStep[], nextSteps: TStep[]): string | null {
  const previousIds = new Set(previousSteps.map((step) => step.id));
  return nextSteps.find((step) => !previousIds.has(step.id))?.id ?? null;
}

export function getSelectedStepIdAfterAdd<TStep extends StepWithId>(previousSteps: TStep[], nextSteps: TStep[], afterStepId: string | null): string | null {
  const insertedIndex = afterStepId ? previousSteps.findIndex((step) => step.id === afterStepId) + 1 : nextSteps.length - 1;
  return nextSteps[Math.max(0, insertedIndex)]?.id ?? null;
}

export function getSelectedStepIdAfterDuplicate<TStep extends StepWithId>(previousSteps: TStep[], nextSteps: TStep[], stepId: string): string {
  const insertedIndex = previousSteps.findIndex((step) => step.id === stepId) + 1;
  return nextSteps[Math.max(0, insertedIndex)]?.id ?? stepId;
}

export function getSelectedStepIdAfterDelete<TStep extends StepWithId>(previousSteps: TStep[], nextSteps: TStep[], stepId: string): string | null {
  const selectedIndex = previousSteps.findIndex((step) => step.id === stepId);
  return nextSteps[Math.min(Math.max(selectedIndex, 0), Math.max(nextSteps.length - 1, 0))]?.id ?? null;
}

export function isGraphPaletteNodeAction(actionId: string): actionId is WorkflowGraphPaletteNodeKind {
  return actionId === "agent"
    || actionId === "tool"
    || actionId === "branch"
    || actionId === "loop"
    || actionId === "approval"
    || actionId === "failure-handler";
}

export function isGraphPathSelectionAction(actionId: string): actionId is Exclude<WorkflowGraphSelectionMode, "self"> {
  return actionId === "upstream" || actionId === "downstream" || actionId === "connected";
}

export function isGraphCanvasViewAction(actionId: string): boolean {
  return actionId === "fit-canvas" || actionId === "actual-size" || actionId === "center-selected";
}

export function getNodeContextSelectionMode(actionId: string): WorkflowGraphSelectionMode | null {
  if (actionId === "select-upstream") return "upstream";
  if (actionId === "select-downstream") return "downstream";
  if (actionId === "select-connected") return "connected";
  return null;
}

export function buildDependencyGroupAssignment(selectedStep: StepDraft): GroupAssignment {
  return {
    id: selectedStep.graphGroupId.trim() || `${selectedStep.id}-group`,
    title: selectedStep.graphGroupTitle.trim() || "Workflow group",
    color: selectedStep.graphGroupColor.trim() || "#64748b",
  };
}

export function buildSelectionGroupAssignment(selectedStep: StepDraft): GroupAssignment {
  return {
    id: selectedStep.graphGroupId.trim() || `${selectedStep.id}-selection`,
    title: selectedStep.graphGroupTitle.trim() || "Selected path",
    color: selectedStep.graphGroupColor.trim() || "#22c55e",
  };
}

export function getUpstreamStepIds(selectedStep: StepDraft): string[] {
  return parseDependencies(selectedStep.dependsOn);
}

export function getDirectDownstreamStepIds(steps: StepDraft[], stepId: string): string[] {
  return steps
    .filter((step) => parseDependencies(step.dependsOn).includes(stepId))
    .map((step) => step.id);
}

export function buildDownstreamContainerAssignment(selectedStep: StepDraft): ContainerAssignment {
  return {
    id: selectedStep.graphContainerId.trim() || `${selectedStep.id}-${selectedStep.graphContainerType}`,
    type: selectedStep.graphContainerType,
    title: selectedStep.graphContainerTitle.trim() || (selectedStep.graphContainerType === "loop" ? "Loop container" : "Branch container"),
    description: selectedStep.graphContainerDescription.trim(),
    mode: selectedStep.graphContainerMode,
    condition: selectedStep.graphContainerCondition,
    iterator: selectedStep.graphContainerIterator,
    skipFailure: selectedStep.graphContainerSkipFailure,
    runInParallel: selectedStep.graphContainerRunInParallel,
    parallelism: parseOptionalPositiveInteger(String(selectedStep.graphContainerParallelism ?? "")),
  };
}

export function buildSelectionContainerAssignment(selectedStep: StepDraft, containerType: WorkflowGraphContainerType): ContainerAssignment {
  return {
    id: selectedStep.graphContainerId.trim() || `${selectedStep.id}-${containerType}`,
    type: containerType,
    title: selectedStep.graphContainerTitle.trim() || (containerType === "loop" ? "Loop selection" : "Branch selection"),
    description: selectedStep.graphContainerDescription.trim(),
    mode: containerType === "loop" ? "for-each" : "branch-one",
    condition: selectedStep.graphContainerCondition,
    iterator: selectedStep.graphContainerIterator,
    skipFailure: selectedStep.graphContainerSkipFailure,
    runInParallel: selectedStep.graphContainerRunInParallel,
    parallelism: parseOptionalPositiveInteger(String(selectedStep.graphContainerParallelism ?? "")),
  };
}
