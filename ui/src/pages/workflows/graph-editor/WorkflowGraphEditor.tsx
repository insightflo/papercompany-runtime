import * as React from "react";
import { useState, type JSX } from "react";
import type { StepDraft } from "../step-draft.js";
import type { PendingWorkflowConnection } from "../workflow-control-nodes.js";
import type { WorkflowGraphEdge, WorkflowGraphInspectorMode, WorkflowGraphInterfaceInput, WorkflowGraphTriggerSummary } from "../workflow-graph.js";
import type { WorkflowToolGrant, WorkflowToolOption } from "../workflow-page-types.js";
import type { StepWorkspaceGraphEditorProps } from "../step-workspace-editor.js";
import { WorkflowGraphTestDrawer } from "./GraphTestDrawer.js";
import { graphShellStyle, graphWorkbenchResizeHandleStyle } from "./graphStyles.js";
import { GraphDetailsDialog } from "./GraphDetailsDialog.js";
import { noticeStyle } from "../workflow-page-styles.js";
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
import {
  resolveQaCapAcceptancePolicy,
  setQaCapAcceptance as applyQaCapAcceptance,
  setQaLoopEnabled as applyQaLoopEnabled,
  setQaReworkMaxIterations as updateQaReworkMaxIterations,
} from "../qa-cap-acceptance-policy.js";

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
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [workbenchHeight, setWorkbenchHeight] = useState<number | null>(null);
  const graphShellRef = React.useRef<HTMLDivElement | null>(null);
  const workbenchResizeStartRef = React.useRef<{ pointerY: number; height: number } | null>(null);
  const workbenchDragCleanupRef = React.useRef<(() => void) | null>(null);
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
  const [pendingConnection, setPendingConnection] = useState<PendingWorkflowConnection | null>(null);
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
  const qaCapAcceptancePolicy = React.useMemo(
    () => resolveQaCapAcceptancePolicy(steps, selectedStep?.id ?? ""),
    [selectedStep?.id, steps],
  );

  const setQaLoopEnabled = React.useCallback((enabled: boolean, producerStepId?: string): void => {
    if (!selectedStep) return;
    onChange(applyQaLoopEnabled(steps, selectedStep.id, enabled, producerStepId));
    setGraphError("");
  }, [onChange, selectedStep, steps]);

  const setQaCapAcceptance = React.useCallback((value: boolean): void => {
    if (!selectedStep) return;
    onChange(applyQaCapAcceptance(steps, selectedStep.id, value));
    setGraphError("");
  }, [onChange, selectedStep, steps]);

  const setQaReworkMaxIterations = React.useCallback((value: number): void => {
    if (!selectedStep) return;
    onChange(updateQaReworkMaxIterations(steps, selectedStep.id, value));
    setGraphError("");
  }, [onChange, selectedStep, steps]);

  const closeGraphContextMenu = React.useCallback((): void => {
    setGraphContextMenu(null);
  }, []);

  const {
    canvasScale,
    canvasPanX,
    canvasPanY,
    graphCanvasRef,
    isCanvasPanning,
    setCanvasScaleFromPoint,
    centerCanvasOnGraphPoint,
    beginCanvasPan,
    handleCanvasPointerMove,
    endCanvasPan,
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
    pendingConnection,
    setSelectedStepId,
    setSelectedPathStepIds,
    setFailureHandlerStepId,
    setGraphError,
    setGraphInspectorMode,
    setShowGraphDetails: (value) => { setShowGraphDetails(value); if (value) setDetailsOpen(true); },
    setSelectedEdgeId,
    setPendingConnection,
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

  function handleNodeDoubleClick(event: React.MouseEvent<HTMLButtonElement>, stepId: string): void {
    event.preventDefault();
    event.stopPropagation();
    selectStep(stepId);
    setDetailsOpen(true);
  }

  function handleEdgeDoubleClick(event: React.MouseEvent<Element>, edge: WorkflowGraphEdge): void {
    event.preventDefault();
    event.stopPropagation();
    setSelectedEdgeId(edge.id);
    setGraphError("");
    setDetailsOpen(true);
  }

  function handleNodeKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, stepId: string): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    selectStep(stepId);
    setDetailsOpen(true);
  }

  function beginWorkbenchResize(event: React.MouseEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const measured = graphShellRef.current?.offsetHeight ?? 0;
    workbenchResizeStartRef.current = {
      pointerY: event.clientY,
      height: workbenchHeight ?? (measured > 0 ? measured : 480),
    };
    const onMove = (moveEvent: MouseEvent): void => {
      const start = workbenchResizeStartRef.current;
      if (!start) return;
      const maxHeight = Math.max(480, window.innerHeight - 140);
      const next = Math.min(maxHeight, Math.max(380, start.height + (moveEvent.clientY - start.pointerY)));
      setWorkbenchHeight(next);
    };
    const onUp = (): void => {
      workbenchResizeStartRef.current = null;
      workbenchDragCleanupRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    workbenchDragCleanupRef.current = onUp;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "ns-resize";
  }

  React.useEffect(() => () => { workbenchDragCleanupRef.current?.(); }, []);

  function handleWorkbenchResizeKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const maxHeight = Math.max(480, window.innerHeight - 140);
      const current = workbenchHeight ?? maxHeight;
      const delta = event.key === "ArrowUp" ? -40 : 40;
      setWorkbenchHeight(Math.min(maxHeight, Math.max(380, current + delta)));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setWorkbenchHeight(null);
    }
  }

  if (steps.length === 0) {
    return <GraphEmptyState onAddEntry={() => addAfter(null)} onInsertPaletteNode={insertPaletteNode} />;
  }

  return (
    <>
      <GraphTriggerSummaryCard surface={surface} graphTriggerSummary={graphTriggerSummary} />
      <div
        ref={graphShellRef}
        data-graph-workbench="true"
        style={{ ...graphShellStyle, ...(workbenchHeight === null ? {} : { height: `${workbenchHeight}px`, minHeight: `${workbenchHeight}px` }) }}
      >
      <div data-graph-canvas-region style={{ minWidth: 0, minHeight: 0, display: "grid" }}>
      <GraphCanvas
        graph={graph}
        canvasWidth={canvasWidth}
        canvasHeight={canvasHeight}
        canvasScale={canvasScale}
        canvasPanX={canvasPanX}
        canvasPanY={canvasPanY}
        isCanvasPanning={isCanvasPanning}
        draggingStepId={draggingStepId}
        pendingConnection={pendingConnection}
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
        handleEdgeDoubleClick={handleEdgeDoubleClick}
        handleEdgeContextMenu={handleEdgeContextMenu}
        beginNodeDrag={beginNodeDrag}
        handleNodePointerMove={handleNodePointerMove}
        endNodeDrag={endNodeDrag}
        handleNodeClick={handleNodeClick}
        handleNodeDoubleClick={handleNodeDoubleClick}
        handleNodeKeyDown={handleNodeKeyDown}
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

      </div>
      <div
        data-graph-resize-handle="true"
        role="separator"
        aria-orientation="horizontal"
        aria-label="그래프 영역 높이 조절"
        title="드래그: 높이 조절 · 더블클릭: 기본 높이로"
        style={graphWorkbenchResizeHandleStyle}
        aria-valuenow={workbenchHeight ?? undefined}
        aria-valuemin={380}
        aria-valuemax={Math.max(480, window.innerHeight - 140)}
        tabIndex={0}
        onMouseDown={beginWorkbenchResize}
        onKeyDown={handleWorkbenchResizeKeyDown}
        onDoubleClick={() => { setWorkbenchHeight(null); }}
      >
        <div style={{ width: "48px", height: "3px", borderRadius: "2px", background: "var(--muted-foreground, #94a3b8)" }} />
      </div>
      </div>
      {!detailsOpen && graphError ? (
        <p role="alert" style={{ ...noticeStyle("error"), margin: "10px 0 0" }}>{graphError}</p>
      ) : null}
      {detailsOpen ? (
        <GraphDetailsDialog
          steps={steps}
          selectedStep={selectedStep}
          selectedEdge={graph.edges.find((edge) => edge.id === selectedEdgeId)}
          graphError={graphError}
          onClose={() => { setDetailsOpen(false); }}
        >
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
        qaCapAcceptancePolicy={qaCapAcceptancePolicy}
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
        setQaLoopEnabled={setQaLoopEnabled}
        setQaCapAcceptance={setQaCapAcceptance}
        setQaReworkMaxIterations={setQaReworkMaxIterations}
        validateRawSelectedStepJson={validateRawSelectedStepJson}
        applyRawSelectedStepJson={applyRawSelectedStepJson}
      />
      </GraphDetailsDialog>
      ) : null}
    </>
  );
}

export function renderWorkflowGraphEditor(props: StepWorkspaceGraphEditorProps): JSX.Element {
  return <WorkflowGraphEditor {...props} />;
}
