import * as React from "react";
import { useEffect } from "react";
import type { StepDraft } from "../step-draft.js";
import {
  appendStepAfter,
  connectSteps,
  disconnectSteps,
  duplicateWorkflowContainer,
  duplicateWorkflowStep,
  expandWorkflowGraphSelection,
  insertWorkflowStepFromPalette,
  removeWorkflowStep,
  renameWorkflowStep,
  type WorkflowGraphContainerSummary,
  type WorkflowGraphEdge,
  type WorkflowGraphFailureRouteSummary,
  type WorkflowGraphInspectorMode,
  type WorkflowGraphModel,
  type WorkflowGraphPaletteNodeKind,
  type WorkflowGraphSelectionMode,
  type WorkflowGraphSelectionSummary,
} from "../workflow-graph.js";
import type { GraphContextMenuState, GraphEdgeActionAnchor } from "./graphUiUtils.js";
import {
  getFirstNewStepId,
  getNodeContextSelectionMode,
  getSelectedStepIdAfterAdd,
  getSelectedStepIdAfterDelete,
  getSelectedStepIdAfterDuplicate,
  isGraphCanvasViewAction,
  isGraphPaletteNodeAction,
  isGraphPathSelectionAction,
} from "./workflowGraphActionHelpers.js";
import { createWorkflowGraphStructureActions } from "./workflowGraphStructureActions.js";
import { isEditableKeyboardTarget } from "./WorkflowGraphEditorHelpers.js";

type SetState<T> = React.Dispatch<React.SetStateAction<T>>;

export function useWorkflowGraphActions({
  steps,
  onChange,
  graph,
  selectedStep,
  selectedGraphNode,
  selectedContainerSummary,
  selectedPathSummary,
  selectedPathFailureRouteSummary,
  selectedStepIdForKeyboard,
  selectedEdgeId,
  selectedEdgeActionAnchor,
  connectingFromStepId,
  setSelectedStepId,
  setSelectedPathStepIds,
  setFailureHandlerStepId,
  setGraphError,
  setGraphInspectorMode,
  setShowGraphDetails,
  setSelectedEdgeId,
  setConnectingFromStepId,
  setGraphContextMenu,
  setCanvasScaleFromPoint,
  centerCanvasOnGraphPoint,
  closeGraphContextMenu,
}: {
  steps: StepDraft[];
  onChange: (steps: StepDraft[]) => void;
  graph: WorkflowGraphModel<StepDraft>;
  selectedStep: StepDraft | null;
  selectedGraphNode: WorkflowGraphModel<StepDraft>["nodes"][number] | null;
  selectedContainerSummary: WorkflowGraphContainerSummary | null;
  selectedPathSummary: WorkflowGraphSelectionSummary;
  selectedPathFailureRouteSummary: WorkflowGraphFailureRouteSummary;
  selectedStepIdForKeyboard: string;
  selectedEdgeId: string | null;
  selectedEdgeActionAnchor: GraphEdgeActionAnchor | null;
  connectingFromStepId: string | null;
  setSelectedStepId: SetState<string | null>;
  setSelectedPathStepIds: SetState<string[]>;
  setFailureHandlerStepId: SetState<string>;
  setGraphError: SetState<string>;
  setGraphInspectorMode: SetState<WorkflowGraphInspectorMode>;
  setShowGraphDetails: SetState<boolean>;
  setSelectedEdgeId: SetState<string | null>;
  setConnectingFromStepId: SetState<string | null>;
  setGraphContextMenu: SetState<GraphContextMenuState | null>;
  setCanvasScaleFromPoint: (nextScale: number, clientX?: number, clientY?: number) => void;
  centerCanvasOnGraphPoint: (graphX: number, graphY: number) => void;
  closeGraphContextMenu: () => void;
}) {
  function updateStepGraphPosition(stepId: string, x: number, y: number): void {
    onChange(steps.map((step) => (step.id === stepId ? {
      ...step,
      graphPositionX: Math.round(x),
      graphPositionY: Math.round(y),
    } : step)));
  }

  function renameSelectedStep(nextStepId: string): void {
    if (!selectedStep) return;
    try {
      setGraphError("");
      const next = renameWorkflowStep(steps, selectedStep.id, nextStepId);
      onChange(next);
      const trimmed = nextStepId.trim();
      if (trimmed) setSelectedStepId(trimmed);
    } catch (error) {
      setGraphError(error instanceof Error ? error.message : String(error));
    }
  }

  function selectStep(stepId: string): void {
    setSelectedStepId(stepId);
    setSelectedEdgeId(null);
    setSelectedPathStepIds(stepId.trim() ? [stepId] : []);
    setFailureHandlerStepId("");
    setGraphError("");
  }

  function expandSelectedPath(mode: WorkflowGraphSelectionMode): void {
    if (!selectedStep) return;
    setSelectedPathStepIds(expandWorkflowGraphSelection(steps, [selectedStep.id], mode));
    setGraphError("");
  }

  function clearSelectedPath(): void {
    setSelectedPathStepIds(selectedStep?.id ? [selectedStep.id] : []);
    setFailureHandlerStepId("");
    setGraphError("");
  }

  function connect(sourceId: string, targetId: string): void {
    try {
      setGraphError("");
      setSelectedEdgeId(null);
      onChange(connectSteps(steps, sourceId, targetId));
    } catch (error) {
      setGraphError(error instanceof Error ? error.message : String(error));
    }
  }

  function disconnect(sourceId: string, targetId: string): void {
    setGraphError("");
    setSelectedEdgeId((edgeId) => edgeId === `${sourceId}->${targetId}` ? null : edgeId);
    onChange(disconnectSteps(steps, sourceId, targetId));
  }

  function addAfter(stepId: string | null): void {
    const next = appendStepAfter(steps, stepId);
    onChange(next);
    setSelectedStepId(getSelectedStepIdAfterAdd(steps, next, stepId));
  }

  function insertPaletteNode(kind: WorkflowGraphPaletteNodeKind): void {
    const next = insertWorkflowStepFromPalette(steps, selectedStep?.id ?? null, kind);
    onChange(next);
    setSelectedStepId(getFirstNewStepId(steps, next) ?? selectedStep?.id ?? next[0]?.id ?? null);
    setGraphError("");
  }

  function centerSelectedGraphStep(): void {
    if (!selectedGraphNode) return;
    centerCanvasOnGraphPoint(selectedGraphNode.x + 86, selectedGraphNode.y + 38);
  }

  function centerGraphStep(stepId: string): void {
    const node = graph.nodes.find((candidate) => candidate.step.id === stepId);
    if (!node) return;
    centerCanvasOnGraphPoint(node.x + 86, node.y + 38);
  }

  const {
    groupSelectedWithDependencies,
    clearSelectedGroup,
    setSelectedGroupCollapsed,
    wrapSelectedPathInContainer,
    wrapSelectedGraphSelection,
    groupSelectedGraphSelection,
    routeSelectedPathFailures,
    clearSelectedContainer,
  } = createWorkflowGraphStructureActions({
    steps,
    onChange,
    selectedStep,
    selectedContainerSummary,
    selectedPathSummary,
    selectedPathFailureRouteSummary,
    setSelectedStepId,
    setGraphError,
  });

  function runWorkbenchAction(actionId: string): void {
    if (actionId === "fit-canvas") {
      setCanvasScaleFromPoint(0.86);
      return;
    }
    if (actionId === "actual-size") {
      setCanvasScaleFromPoint(1);
      return;
    }
    if (actionId === "center-selected") {
      centerSelectedGraphStep();
      return;
    }
    if (actionId === "diagnostics") {
      setGraphInspectorMode("edit");
      setShowGraphDetails(true);
      return;
    }
    if (isGraphPaletteNodeAction(actionId)) {
      insertPaletteNode(actionId);
      return;
    }
    if (isGraphPathSelectionAction(actionId)) {
      expandSelectedPath(actionId);
      return;
    }
    if (actionId === "group") {
      groupSelectedGraphSelection();
      return;
    }
    if (actionId === "branch-wrap") {
      wrapSelectedGraphSelection("branch");
      return;
    }
    if (actionId === "loop-wrap") {
      wrapSelectedGraphSelection("loop");
      return;
    }
    if (actionId === "route-failure") {
      routeSelectedPathFailures();
    }
  }

  function duplicateStep(stepId: string): void {
    const next = duplicateWorkflowStep(steps, stepId);
    onChange(next);
    setSelectedStepId(getSelectedStepIdAfterDuplicate(steps, next, stepId));
  }

  function duplicateSelectedStep(): void {
    if (!selectedStep) return;
    duplicateStep(selectedStep.id);
  }

  function duplicateSelectedContainer(): void {
    if (!selectedContainerSummary) return;
    const next = duplicateWorkflowContainer(steps, selectedContainerSummary.id);
    onChange(next);
    setSelectedStepId(getFirstNewStepId(steps, next) ?? selectedStep?.id ?? next[0]?.id ?? null);
  }

  function deleteStep(stepId: string): void {
    const next = removeWorkflowStep(steps, stepId);
    onChange(next);
    setSelectedStepId(getSelectedStepIdAfterDelete(steps, next, stepId));
  }

  function deleteSelectedStep(): void {
    if (!selectedStep) return;
    deleteStep(selectedStep.id);
  }

  function deleteSelectedEdge(): boolean {
    const edge = selectedEdgeActionAnchor?.edge ?? graph.edges.find((candidate) => candidate.id === selectedEdgeId);
    if (!edge) return false;
    disconnect(edge.source, edge.target);
    return true;
  }

  function deleteSelectedGraphObject(): void {
    if (deleteSelectedEdge()) return;
    deleteSelectedStep();
  }

  function handleDeleteGraphObjectPointerDown(event: React.PointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    deleteSelectedGraphObject();
  }

  function stopGraphControlEvent(event: React.SyntheticEvent<HTMLElement>): void {
    event.stopPropagation();
  }

  useEffect(() => {
    if (!selectedStepIdForKeyboard && !selectedEdgeId) return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (isEditableKeyboardTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      const edge = graph.edges.find((candidate) => candidate.id === selectedEdgeId);
      if (edge) {
        disconnect(edge.source, edge.target);
        return;
      }
      if (!selectedStepIdForKeyboard) return;
      deleteStep(selectedStepIdForKeyboard);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [graph.edges, selectedEdgeId, selectedStepIdForKeyboard, steps]);

  function handleCanvasClick(): void {
    closeGraphContextMenu();
    setSelectedEdgeId(null);
    setConnectingFromStepId(null);
  }

  function handleCanvasContextMenu(event: React.MouseEvent<HTMLDivElement>): void {
    const target = event.target as HTMLElement;
    if (target.closest("[data-graph-node='true'], [data-graph-toolbar='true'], [data-graph-menu='true'], [data-graph-edge='true'], [data-graph-handle='true'], [data-graph-edge-remove='true']")) return;
    event.preventDefault();
    setGraphContextMenu({ kind: "canvas", clientX: event.clientX, clientY: event.clientY });
  }

  function handleNodeContextMenu(event: React.MouseEvent<HTMLElement>, stepId: string): void {
    event.preventDefault();
    event.stopPropagation();
    selectStep(stepId);
    setGraphContextMenu({ kind: "node", stepId, clientX: event.clientX, clientY: event.clientY });
  }

  function handleEdgeClick(event: React.MouseEvent<Element>, edge: WorkflowGraphEdge): void {
    event.preventDefault();
    event.stopPropagation();
    closeGraphContextMenu();
    setConnectingFromStepId(null);
    setSelectedEdgeId(edge.id);
    setGraphError("");
  }

  function handleEdgeContextMenu(event: React.MouseEvent<Element>, edge: WorkflowGraphEdge): void {
    event.preventDefault();
    event.stopPropagation();
    setConnectingFromStepId(null);
    setSelectedEdgeId(edge.id);
    setGraphContextMenu({
      kind: "edge",
      edgeId: edge.id,
      sourceId: edge.source,
      targetId: edge.target,
      clientX: event.clientX,
      clientY: event.clientY,
    });
  }

  function connectPendingEdgeTo(targetId: string): void {
    const sourceId = connectingFromStepId;
    if (!sourceId) return;
    setConnectingFromStepId(null);
    if (sourceId === targetId) {
      setGraphError("Cannot connect a step to itself.");
      return;
    }
    connect(sourceId, targetId);
  }

  function beginEdgeConnection(event: React.PointerEvent<HTMLElement>, sourceId: string): void {
    event.preventDefault();
    event.stopPropagation();
    closeGraphContextMenu();
    setSelectedEdgeId(null);
    setConnectingFromStepId(sourceId);
    setGraphError("");
  }

  function completeEdgeConnection(event: React.PointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>, targetId: string): void {
    event.preventDefault();
    event.stopPropagation();
    connectPendingEdgeTo(targetId);
  }

  function runNodeContextAction(actionId: string, stepId: string): void {
    closeGraphContextMenu();
    if (actionId === "add-downstream") {
      addAfter(stepId);
      return;
    }
    if (actionId === "duplicate") {
      duplicateStep(stepId);
      return;
    }
    if (actionId === "delete") {
      deleteStep(stepId);
      return;
    }
    if (actionId === "center") {
      centerGraphStep(stepId);
      return;
    }
    const selectionMode = getNodeContextSelectionMode(actionId);
    if (selectionMode) {
      setSelectedStepId(stepId);
      setSelectedPathStepIds(expandWorkflowGraphSelection(steps, [stepId], selectionMode));
      return;
    }
    if (actionId === "connect-selected-to-this" && selectedStep && selectedStep.id !== stepId) {
      connect(selectedStep.id, stepId);
      return;
    }
    if (actionId === "connect-this-to-selected" && selectedStep && selectedStep.id !== stepId) {
      connect(stepId, selectedStep.id);
    }
  }

  function runCanvasContextAction(actionId: string): void {
    closeGraphContextMenu();
    if (isGraphCanvasViewAction(actionId)) {
      runWorkbenchAction(actionId);
      return;
    }
    if (isGraphPaletteNodeAction(actionId)) {
      insertPaletteNode(actionId);
    }
  }

  function runEdgeContextAction(actionId: string, sourceId: string, targetId: string): void {
    closeGraphContextMenu();
    if (actionId === "remove-edge") {
      disconnect(sourceId, targetId);
      return;
    }
    if (actionId === "select-source") {
      selectStep(sourceId);
      return;
    }
    if (actionId === "select-target") {
      selectStep(targetId);
    }
  }

  return {
    updateStepGraphPosition,
    renameSelectedStep,
    selectStep,
    expandSelectedPath,
    clearSelectedPath,
    connect,
    disconnect,
    addAfter,
    insertPaletteNode,
    centerSelectedGraphStep,
    centerGraphStep,
    runWorkbenchAction,
    duplicateStep,
    duplicateSelectedStep,
    duplicateSelectedContainer,
    deleteStep,
    deleteSelectedStep,
    deleteSelectedEdge,
    deleteSelectedGraphObject,
    handleDeleteGraphObjectPointerDown,
    stopGraphControlEvent,
    handleCanvasClick,
    handleCanvasContextMenu,
    handleNodeContextMenu,
    handleEdgeClick,
    handleEdgeContextMenu,
    connectPendingEdgeTo,
    beginEdgeConnection,
    completeEdgeConnection,
    runNodeContextAction,
    runCanvasContextAction,
    runEdgeContextAction,
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
