import * as React from "react";
import { useState, type JSX } from "react";
import type { StepDraft } from "../step-draft.js";
import type { WorkflowGraphInspectorMode, WorkflowGraphInterfaceInput, WorkflowGraphTriggerSummary } from "../workflow-graph.js";
import type { WorkflowToolGrant, WorkflowToolOption } from "../workflow-page-types.js";
import type { StepWorkspaceGraphEditorProps } from "../step-workspace-editor.js";
import { WorkflowGraphTestDrawer } from "./GraphTestDrawer.js";
import { graphInspectorResizeHandleStyle, graphShellStyle } from "./graphStyles.js";
import { type GraphContextMenuState, type GraphNodeDragState } from "./graphUiUtils.js";
import { GraphTriggerSummaryCard } from "./GraphTriggerSummaryCard.js";
import { GraphEmptyState } from "./GraphEmptyState.js";
import { useRawStepJsonEditor } from "./useRawStepJsonEditor.js";
import { useGraphAgents } from "./useGraphAgents.js";
import { useWorkflowGraphDerivedState } from "./useWorkflowGraphDerivedState.js";
import { useWorkflowGraphMetadataHandlers } from "./useWorkflowGraphMetadataHandlers.js";
import { useWorkflowGraphCanvasViewport } from "./useWorkflowGraphCanvasViewport.js";
import { useWorkflowGraphActions } from "./useWorkflowGraphActions.js";
import { GraphCanvas } from "./GraphCanvas.js";
import { GraphInspector } from "./GraphInspector.js";

function WorkflowGraphEditor({
  steps,
  runOverlaySteps,
  onChange,
  triggerSummary,
  testInterfaceInput,
  availableTools,
  availableToolGrants,
  surface = "stacked",
}: {
  steps: StepDraft[];
  runOverlaySteps?: StepDraft[];
  onChange: (steps: StepDraft[]) => void;
  triggerSummary?: WorkflowGraphTriggerSummary;
  testInterfaceInput?: WorkflowGraphInterfaceInput;
  availableTools: WorkflowToolOption[];
  availableToolGrants: WorkflowToolGrant[];
  surface?: "stacked" | "focus";
}): JSX.Element {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(steps[0]?.id ?? null);
  const [selectedPathStepIds, setSelectedPathStepIds] = useState<string[]>(() => steps[0]?.id ? [steps[0].id] : []);
  const [failureHandlerStepId, setFailureHandlerStepId] = useState<string>("");
  const [graphError, setGraphError] = useState<string>("");
  const [graphInspectorMode, setGraphInspectorMode] = useState<WorkflowGraphInspectorMode>("edit");
  const [showGraphDetails, setShowGraphDetails] = useState<boolean>(false);
  const [showGraphTestDrawer, setShowGraphTestDrawer] = useState<boolean>(false);
  const [showGraphEvidenceDrawer, setShowGraphEvidenceDrawer] = useState<boolean>(false);
  const [graphContextMenu, setGraphContextMenu] = useState<GraphContextMenuState | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [connectingFromStepId, setConnectingFromStepId] = useState<string | null>(null);
  const [draggingStepId, setDraggingStepId] = useState<string | null>(null);
  const graphNodeDragRef = React.useRef<GraphNodeDragState | null>(null);
  const suppressNodeClickRef = React.useRef<string | null>(null);
  const graphAgents = useGraphAgents();
  const {
    graph, matchingNodeIds, selectedStep, selectedGraphNode, selectedStepIdForKeyboard,
    selectedDataFlowMap, selectedPathSummary,
    selectedPathFailureRouteSummary, selectedPathNodeIds, selectedContainerSummary, selectedGroup,
    diagnostics, repairPlan, inspectorSummary, testDrawerSummary, evidenceSummary, workbenchSummary,
    activeInspectorSection, showOverviewInspector, showEditInspector, showPolicyInspector,
    showRawInspector, inspectorAccent, canvasHeight, canvasWidth, graphTriggerSummary,
    selectedEdgeActionAnchor,
  } = useWorkflowGraphDerivedState({
    steps, runOverlaySteps, selectedStepId, selectedPathStepIds, failureHandlerStepId,
    graphInspectorMode, triggerSummary, testInterfaceInput, selectedEdgeId,
  });
  const {
    rawStepJsonText,
    rawStepJsonFeedback,
    setRawStepJsonText,
    setRawStepJsonFeedback,
    validateRawSelectedStepJson,
    applyRawSelectedStepJson,
  } = useRawStepJsonEditor({
    selectedStep,
    steps,
    onChange,
    setSelectedStepId,
    setSelectedPathStepIds,
    setGraphError: (e: string) => setGraphError(e),
  });
  const {
    updateSelected, updateSelectedGroupMetadata, updateSelectedAdvanced,
    updateSelectedApproval, updateSelectedTesting, updateSelectedExecution, updateSelectedDataFlow,
    updateSelectedResources, setSelectedNote, updateSelectedContainerMetadata,
  } = useWorkflowGraphMetadataHandlers({ steps, onChange, selectedStep, setGraphError });

  const closeGraphContextMenu = React.useCallback((): void => {
    setGraphContextMenu(null);
  }, []);

  const {
    canvasScale,
    canvasPanX,
    canvasPanY,
    graphInspectorWidth,
    graphCanvasRef,
    isCanvasPanning,
    setCanvasScaleFromPoint,
    centerCanvasOnGraphPoint,
    beginCanvasPan,
    handleCanvasPointerMove,
    endCanvasPan,
    beginGraphInspectorResize,
  } = useWorkflowGraphCanvasViewport({ closeGraphContextMenu });

  const {
    updateStepGraphPosition,
    renameSelectedStep,
    selectStep,
    expandSelectedPath,
    clearSelectedPath,
    disconnect,
    addAfter,
    insertPaletteNode,
    runWorkbenchAction,
    duplicateSelectedStep,
    duplicateSelectedContainer,
    handleDeleteGraphObjectPointerDown,
    stopGraphControlEvent,
    handleCanvasClick,
    handleCanvasContextMenu,
    handleNodeContextMenu,
    handleEdgeClick,
    handleEdgeContextMenu,
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
    clearSelectedContainer,
  } = useWorkflowGraphActions({
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
  });

  function beginNodeDrag(event: React.PointerEvent<HTMLButtonElement>, stepId: string, x: number, y: number): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    closeGraphContextMenu();
    selectStep(stepId);
    graphNodeDragRef.current = {
      stepId,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: x,
      startY: y,
      moved: false,
    };
    setDraggingStepId(stepId);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleNodePointerMove(event: React.PointerEvent<HTMLButtonElement>): void {
    const drag = graphNodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = (event.clientX - drag.startClientX) / canvasScale;
    const deltaY = (event.clientY - drag.startClientY) / canvasScale;
    if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) drag.moved = true;
    updateStepGraphPosition(drag.stepId, drag.startX + deltaX, drag.startY + deltaY);
  }

  function endNodeDrag(event: React.PointerEvent<HTMLButtonElement>): void {
    const drag = graphNodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) suppressNodeClickRef.current = drag.stepId;
    graphNodeDragRef.current = null;
    setDraggingStepId(null);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
  }

  function handleNodeClick(event: React.MouseEvent<HTMLButtonElement>, stepId: string): void {
    if (suppressNodeClickRef.current === stepId) {
      suppressNodeClickRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.stopPropagation();
    selectStep(stepId);
  }

  if (steps.length === 0) {
    return <GraphEmptyState onAddEntry={() => addAfter(null)} onInsertPaletteNode={insertPaletteNode} />;
  }

  return (
    <div style={{ ...graphShellStyle, gridTemplateColumns: `minmax(620px, 1fr) 8px ${graphInspectorWidth}px` }}>
      <GraphTriggerSummaryCard surface={surface} graphTriggerSummary={graphTriggerSummary} />
      <GraphCanvas
        graph={graph}
        canvasWidth={canvasWidth}
        canvasHeight={canvasHeight}
        canvasScale={canvasScale}
        canvasPanX={canvasPanX}
        canvasPanY={canvasPanY}
        isCanvasPanning={isCanvasPanning}
        draggingStepId={draggingStepId}
        connectingFromStepId={connectingFromStepId}
        graphCanvasRef={graphCanvasRef}
        selectedStep={selectedStep}
        selectedEdgeId={selectedEdgeId}
        selectedEdgeActionAnchor={selectedEdgeActionAnchor}
        graphContextMenu={graphContextMenu}
        selectedContainerSummary={selectedContainerSummary}
        selectedPathNodeIds={selectedPathNodeIds}
        matchingNodeIds={matchingNodeIds}
        availableTools={availableTools}
        workbenchSummary={workbenchSummary}
        beginCanvasPan={beginCanvasPan}
        handleCanvasPointerMove={handleCanvasPointerMove}
        endCanvasPan={endCanvasPan}
        handleCanvasClick={handleCanvasClick}
        handleCanvasContextMenu={handleCanvasContextMenu}
        stopGraphControlEvent={stopGraphControlEvent}
        handleEdgeClick={handleEdgeClick}
        handleEdgeContextMenu={handleEdgeContextMenu}
        beginNodeDrag={beginNodeDrag}
        handleNodePointerMove={handleNodePointerMove}
        endNodeDrag={endNodeDrag}
        handleNodeClick={handleNodeClick}
        handleNodeContextMenu={handleNodeContextMenu}
        beginEdgeConnection={beginEdgeConnection}
        completeEdgeConnection={completeEdgeConnection}
        disconnect={disconnect}
        setCanvasScaleFromPoint={setCanvasScaleFromPoint}
        runWorkbenchAction={runWorkbenchAction}
        runNodeContextAction={runNodeContextAction}
        runEdgeContextAction={runEdgeContextAction}
        runCanvasContextAction={runCanvasContextAction}
        addAfter={addAfter}
        handleDeleteGraphObjectPointerDown={handleDeleteGraphObjectPointerDown}
      />

      <div
        key="graph-inspector-resize"
        aria-label="Resize graph inspector"
        role="separator"
        style={graphInspectorResizeHandleStyle}
        title="Drag to resize Inspector"
        onPointerDown={beginGraphInspectorResize}
      >
        <span style={{ width: "2px", height: "42px", borderRadius: "2px", background: "var(--muted-foreground, #94a3b8)", opacity: 0.55 }} />
      </div>

      <GraphInspector
        steps={steps}
        selectedStep={selectedStep}
        selectedContainerSummary={selectedContainerSummary}
        selectedDataFlowMap={selectedDataFlowMap}
        selectedGroup={selectedGroup}
        selectedPathSummary={selectedPathSummary}
        inspectorSummary={inspectorSummary}
        activeInspectorSection={activeInspectorSection}
        evidenceSummary={evidenceSummary}
        repairPlan={repairPlan}
        diagnostics={diagnostics}
        graphError={graphError}
        graphInspectorMode={graphInspectorMode}
        inspectorAccent={inspectorAccent}
        showOverviewInspector={showOverviewInspector}
        showEditInspector={showEditInspector}
        showPolicyInspector={showPolicyInspector}
        showRawInspector={showRawInspector}
        showGraphDetails={showGraphDetails}
        showGraphTestDrawer={showGraphTestDrawer}
        showGraphEvidenceDrawer={showGraphEvidenceDrawer}
        rawStepJsonText={rawStepJsonText}
        rawStepJsonFeedback={rawStepJsonFeedback}
        availableTools={availableTools}
        availableToolGrants={availableToolGrants}
        graphAgents={graphAgents}
        testDrawerSlot={showOverviewInspector && showGraphTestDrawer ? (
          <WorkflowGraphTestDrawer
            key="test-drawer"
            summary={testDrawerSummary}
            steps={steps}
            interfaceInput={testInterfaceInput}
            onClose={() => setShowGraphTestDrawer(false)}
          />
        ) : null}
        setGraphInspectorMode={setGraphInspectorMode}
        setShowGraphTestDrawer={setShowGraphTestDrawer}
        setShowGraphEvidenceDrawer={setShowGraphEvidenceDrawer}
        setRawStepJsonText={setRawStepJsonText}
        setRawStepJsonFeedback={setRawStepJsonFeedback}
        selectStep={selectStep}
        addAfter={addAfter}
        expandSelectedPath={expandSelectedPath}
        clearSelectedPath={clearSelectedPath}
        groupSelectedGraphSelection={groupSelectedGraphSelection}
        wrapSelectedGraphSelection={wrapSelectedGraphSelection}
        wrapSelectedPathInContainer={wrapSelectedPathInContainer}
        duplicateSelectedStep={duplicateSelectedStep}
        duplicateSelectedContainer={duplicateSelectedContainer}
        clearSelectedContainer={clearSelectedContainer}
        clearSelectedGroup={clearSelectedGroup}
        groupSelectedWithDependencies={groupSelectedWithDependencies}
        setSelectedGroupCollapsed={setSelectedGroupCollapsed}
        handleDeleteGraphObjectPointerDown={handleDeleteGraphObjectPointerDown}
        renameSelectedStep={renameSelectedStep}
        updateSelected={updateSelected}
        updateSelectedAdvanced={updateSelectedAdvanced}
        updateSelectedApproval={updateSelectedApproval}
        updateSelectedTesting={updateSelectedTesting}
        updateSelectedExecution={updateSelectedExecution}
        updateSelectedDataFlow={updateSelectedDataFlow}
        updateSelectedResources={updateSelectedResources}
        updateSelectedGroupMetadata={updateSelectedGroupMetadata}
        updateSelectedContainerMetadata={updateSelectedContainerMetadata}
        setSelectedNote={setSelectedNote}
        validateRawSelectedStepJson={validateRawSelectedStepJson}
        applyRawSelectedStepJson={applyRawSelectedStepJson}
      />
    </div>
  );
}

export function renderWorkflowGraphEditor(props: StepWorkspaceGraphEditorProps): JSX.Element {
  return <WorkflowGraphEditor {...props} />;
}
