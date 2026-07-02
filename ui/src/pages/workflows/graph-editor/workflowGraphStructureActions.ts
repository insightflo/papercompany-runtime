import type { Dispatch, SetStateAction } from "react";
import { withStepDraftDefaults, type StepDraft } from "../step-draft.js";
import {
  applyWorkflowGraphFailureRoute,
  assignStepsToContainer,
  assignStepsToGroup,
  clearStepsGroup,
  clearWorkflowContainer,
  setGraphGroupCollapsed,
  type WorkflowGraphContainerSummary,
  type WorkflowGraphContainerType,
  type WorkflowGraphFailureRouteSummary,
  type WorkflowGraphSelectionSummary,
} from "../workflow-graph.js";
import {
  buildDependencyGroupAssignment,
  buildDownstreamContainerAssignment,
  buildSelectionContainerAssignment,
  buildSelectionGroupAssignment,
  getDirectDownstreamStepIds,
  getUpstreamStepIds,
} from "./workflowGraphActionHelpers.js";

type SetState<T> = Dispatch<SetStateAction<T>>;

export function createWorkflowGraphStructureActions({
  steps,
  onChange,
  selectedStep,
  selectedContainerSummary,
  selectedPathSummary,
  selectedPathFailureRouteSummary,
  setSelectedStepId,
  setGraphError,
}: {
  steps: StepDraft[];
  onChange: (steps: StepDraft[]) => void;
  selectedStep: StepDraft | null;
  selectedContainerSummary: WorkflowGraphContainerSummary | null;
  selectedPathSummary: WorkflowGraphSelectionSummary;
  selectedPathFailureRouteSummary: WorkflowGraphFailureRouteSummary;
  setSelectedStepId: SetState<string | null>;
  setGraphError: SetState<string>;
}) {
  function groupSelectedWithDependencies(): void {
    if (!selectedStep) return;
    const upstreamIds = getUpstreamStepIds(selectedStep);
    const stepIds = Array.from(new Set([...upstreamIds, selectedStep.id]));
    onChange(assignStepsToGroup(steps, stepIds, buildDependencyGroupAssignment(selectedStep)));
  }

  function clearSelectedGroup(): void {
    if (!selectedStep) return;
    onChange(clearStepsGroup(steps, [selectedStep.id]));
  }

  function setSelectedGroupCollapsed(collapsed: boolean): void {
    if (!selectedStep || !selectedStep.graphGroupId.trim()) return;
    onChange(setGraphGroupCollapsed(steps, selectedStep.graphGroupId, collapsed));
  }

  function wrapSelectedPathInContainer(): void {
    if (!selectedStep) return;
    const downstreamIds = getDirectDownstreamStepIds(steps, selectedStep.id);
    const stepIds = Array.from(new Set([selectedStep.id, ...downstreamIds]));
    onChange(assignStepsToContainer(steps, stepIds, buildDownstreamContainerAssignment(selectedStep)));
  }

  function wrapSelectedGraphSelection(containerType: WorkflowGraphContainerType): void {
    if (!selectedStep || selectedPathSummary.blocked || selectedPathSummary.stepIds.length === 0) return;
    onChange(assignStepsToContainer(steps, selectedPathSummary.stepIds, buildSelectionContainerAssignment(selectedStep, containerType)));
  }

  function groupSelectedGraphSelection(): void {
    if (!selectedStep || selectedPathSummary.blocked || selectedPathSummary.stepIds.length === 0) return;
    onChange(assignStepsToGroup(steps, selectedPathSummary.stepIds, buildSelectionGroupAssignment(selectedStep)));
  }

  function routeSelectedPathFailures(): void {
    if (selectedPathFailureRouteSummary.blocked) return;
    try {
      setGraphError("");
      onChange(applyWorkflowGraphFailureRoute(steps, selectedPathSummary.stepIds, selectedPathFailureRouteSummary.handlerStepId, {
        label: selectedPathFailureRouteSummary.label,
        condition: selectedPathFailureRouteSummary.condition,
        handlerScope: "selected-path",
        handlerInput: "{{ error }}",
      }));
      setSelectedStepId(selectedPathFailureRouteSummary.handlerStepId);
    } catch (error) {
      setGraphError(error instanceof Error ? error.message : String(error));
    }
  }

  function clearSelectedContainer(): void {
    const containerId = selectedContainerSummary?.id ?? selectedStep?.graphContainerId.trim() ?? "";
    if (!containerId) return;
    onChange(withStepDraftDefaults(clearWorkflowContainer(steps, containerId)));
  }

  return {
    groupSelectedWithDependencies,
    clearSelectedGroup,
    setSelectedGroupCollapsed,
    wrapSelectedPathInContainer,
    wrapSelectedGraphSelection,
    groupSelectedGraphSelection,
    routeSelectedPathFailures,
    clearSelectedContainer,
  };
}
