import { useMemo } from "react";
import type { GraphEdgeActionAnchor } from "./graphUiUtils.js";
import type { StepDraft } from "../step-draft.js";
import type { WorkflowGraphContainerSummary, WorkflowGraphDataFlowMap, WorkflowGraphExecutionEvidenceSummary, WorkflowGraphFailureRouteSummary, WorkflowGraphInspectorMode, WorkflowGraphInspectorSummary, WorkflowGraphRepairPlan, WorkflowGraphSelectionSummary, WorkflowGraphTestDrawerSummary, WorkflowGraphTriggerSummary, WorkflowGraphWorkbenchSummary } from "../workflow-graph.js";
import type { WorkflowGraphInterfaceInput } from "../workflow-graph.js";
import { buildWorkflowGraphContainerSummary, buildWorkflowGraphDataFlowMap, buildWorkflowGraphExecutionEvidenceSummary, buildWorkflowGraphFailureRouteSummary, buildWorkflowGraphInspectorSummary, buildWorkflowGraphModel, buildWorkflowGraphRepairPlan, buildWorkflowGraphSelectionSummary, buildWorkflowGraphTestDrawerSummary, buildWorkflowGraphWorkbenchSummary, getWorkflowGraphStepContext, summarizeWorkflowGraphTriggers } from "../workflow-graph.js";

export function useWorkflowGraphDerivedState({
  steps,
  runOverlaySteps,
  selectedStepId,
  selectedPathStepIds,
  failureHandlerStepId,
  graphInspectorMode,
  triggerSummary,
  testInterfaceInput,
  selectedEdgeId,
}: {
  steps: StepDraft[];
  runOverlaySteps?: StepDraft[];
  selectedStepId: string | null;
  selectedPathStepIds: string[];
  failureHandlerStepId: string;
  graphInspectorMode: WorkflowGraphInspectorMode;
  triggerSummary?: WorkflowGraphTriggerSummary;
  testInterfaceInput?: WorkflowGraphInterfaceInput;
  selectedEdgeId: string | null;
}) {
  const displaySteps = useMemo(() => {
    if (!runOverlaySteps) return steps;
    const positionsById = new Map(steps.map((step) => [step.id, {
      graphPositionX: step.graphPositionX,
      graphPositionY: step.graphPositionY,
    }]));
    return runOverlaySteps.map((step) => {
      const position = positionsById.get(step.id);
      return position ? { ...step, ...position } : step;
    });
  }, [runOverlaySteps, steps]);
  const graph = useMemo(() => buildWorkflowGraphModel(displaySteps), [displaySteps]);
  const matchingNodeIds = useMemo(() => new Set<string>(), []);
  const selectedStep = steps.find((step) => step.id === selectedStepId) ?? steps[0] ?? null;
  const selectedGraphNode = selectedStep ? graph.nodes.find((node) => node.step.id === selectedStep.id) ?? null : null;
  const selectedStepIdForKeyboard = selectedStep?.id ?? "";
  const selectedGraphContext = selectedStep ? getWorkflowGraphStepContext(steps, selectedStep.id) : null;
  const selectedDataFlowMap = useMemo<WorkflowGraphDataFlowMap | null>(
    () => selectedStep ? buildWorkflowGraphDataFlowMap(steps, selectedStep.id) : null,
    [selectedStep, steps],
  );
  const selectedPathSummary = useMemo<WorkflowGraphSelectionSummary>(
    () => buildWorkflowGraphSelectionSummary(steps, selectedPathStepIds),
    [steps, selectedPathStepIds],
  );
  const selectedPathFailureHandlerId = failureHandlerStepId || selectedPathSummary.outboundStepIds[0] || "";
  const selectedPathFailureRouteSummary = useMemo<WorkflowGraphFailureRouteSummary>(
    () => buildWorkflowGraphFailureRouteSummary(steps, selectedPathSummary.stepIds, selectedPathFailureHandlerId, {
      label: "Selected path failure",
      condition: "upstream step failed",
    }),
    [steps, selectedPathSummary.stepIds, selectedPathFailureHandlerId],
  );
  const selectedPathNodeIds = useMemo(
    () => new Set(selectedPathSummary.stepIds),
    [selectedPathSummary],
  );
  const selectedContainerSummary = useMemo<WorkflowGraphContainerSummary | null>(
    () => {
      const containerId = selectedStep?.graphContainerId.trim() ?? "";
      return containerId ? buildWorkflowGraphContainerSummary(steps, containerId) : null;
    },
    [selectedStep, steps],
  );
  const selectedGroup = selectedStep?.graphGroupId.trim()
    ? graph.groups.find((group) => group.id === selectedStep.graphGroupId.trim()) ?? null
    : null;
  const diagnostics = graph.diagnostics;
  const repairPlan = useMemo<WorkflowGraphRepairPlan>(
    () => buildWorkflowGraphRepairPlan(steps),
    [steps],
  );
  const inspectorSummary = useMemo<WorkflowGraphInspectorSummary>(
    () => buildWorkflowGraphInspectorSummary(steps, selectedStep?.id ?? "", selectedPathStepIds),
    [selectedPathStepIds, selectedStep, steps],
  );
  const testDrawerSummary = useMemo<WorkflowGraphTestDrawerSummary>(
    () => buildWorkflowGraphTestDrawerSummary(steps, selectedStep?.id ?? "", testInterfaceInput),
    [selectedStep, steps, testInterfaceInput],
  );
  const evidenceSummary = useMemo<WorkflowGraphExecutionEvidenceSummary>(
    () => buildWorkflowGraphExecutionEvidenceSummary(displaySteps, selectedStep?.id ?? ""),
    [displaySteps, selectedStep],
  );
  const workbenchSummary = useMemo<WorkflowGraphWorkbenchSummary>(
    () => buildWorkflowGraphWorkbenchSummary(steps, selectedStep?.id ?? "", selectedPathStepIds),
    [selectedPathStepIds, selectedStep, steps],
  );
  const activeInspectorSection = inspectorSummary.sections.find((section) => section.mode === graphInspectorMode) ?? inspectorSummary.sections[0];
  const showOverviewInspector = false;
  const showEditInspector = graphInspectorMode === "edit";
  const showPolicyInspector = graphInspectorMode === "policy";
  const showRawInspector = graphInspectorMode === "raw";
  const inspectorAccent = graphInspectorMode === "overview"
    ? "#22c55e"
    : graphInspectorMode === "edit"
      ? "#38bdf8"
      : graphInspectorMode === "policy"
        ? "#f59e0b"
        : graphInspectorMode === "raw"
          ? "#a78bfa"
          : "#fbbf24";
  const canvasHeight = Math.max(360, ...graph.nodes.map((node) => node.y + 132), 360);
  const canvasWidth = Math.max(620, ...graph.nodes.map((node) => node.x + 230), 620);
  const graphTriggerSummary = triggerSummary ?? summarizeWorkflowGraphTriggers({});
  const selectedEdgeActionAnchor = useMemo<GraphEdgeActionAnchor | null>(() => {
    if (!selectedEdgeId) return null;
    const edge = graph.edges.find((candidate) => candidate.id === selectedEdgeId);
    if (!edge) return null;
    const source = graph.nodes.find((node) => node.id === edge.source);
    const target = graph.nodes.find((node) => node.id === edge.target);
    if (!source || !target) return null;
    const startX = source.x + 172;
    const startY = source.y + 38;
    const endX = target.x;
    const endY = target.y + 38;
    const midX = startX + Math.max(34, (endX - startX) / 2);
    return { edge, x: midX, y: (startY + endY) / 2 };
  }, [graph.edges, graph.nodes, selectedEdgeId]);
  return {
    displaySteps, graph, matchingNodeIds, selectedStep, selectedGraphNode, selectedStepIdForKeyboard,
    selectedGraphContext, selectedDataFlowMap, selectedPathSummary, selectedPathFailureHandlerId,
    selectedPathFailureRouteSummary, selectedPathNodeIds, selectedContainerSummary, selectedGroup,
    diagnostics, repairPlan, inspectorSummary, testDrawerSummary, evidenceSummary, workbenchSummary,
    activeInspectorSection, showOverviewInspector, showEditInspector, showPolicyInspector,
    showRawInspector, inspectorAccent, canvasHeight, canvasWidth, graphTriggerSummary,
    selectedEdgeActionAnchor,
  };
}
