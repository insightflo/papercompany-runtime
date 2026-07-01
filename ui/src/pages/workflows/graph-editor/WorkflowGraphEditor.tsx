import * as React from "react";
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type JSX } from "react";
import { useCompany } from "../../../context/CompanyContext";
import { buildManualRunFeedback, buildManualRunButtonState, findNewRunId, manualRunUnavailableMessage } from "../run-feedback.js";
import { ActiveRunsTable, RecentRunsTable, WorkflowRunDebugStrip, WorkflowRunDrawer, workflowRunDrawerActionsStyle, workflowRunOverlayBannerStyle, type WorkflowRunDrawerMode } from "../workflow-runs.js";
import { jsonToSteps, parseOptionalNonNegativeInteger, parseOptionalPositiveInteger, stepsToJson, withStepDraftDefaults, type StepDraft } from "../step-draft.js";
import { appendStepAfter, applyStepRunsToGraphSteps, applyWorkflowGraphFailureRoute, assignStepsToContainer, assignStepsToGroup, buildWorkflowGraphContainerSummary, buildWorkflowGraphDataFlowMap, buildWorkflowGraphDefinitionNavigator, buildWorkflowGraphExecutionEvidenceSummary, buildWorkflowGraphExportSnapshot, buildWorkflowGraphFailureRouteSummary, buildWorkflowGraphInspectorSummary, buildWorkflowGraphModel, buildWorkflowGraphRepairPlan, buildWorkflowGraphRunDebugSummary, buildWorkflowGraphSelectionSummary, buildWorkflowGraphStructurePaletteSummary, buildWorkflowGraphTestDrawerSummary, buildWorkflowGraphWorkbenchSummary, clearStepsGroup, clearWorkflowContainer, connectSteps, disconnectSteps, duplicateWorkflowContainer, duplicateWorkflowStep, expandWorkflowGraphSelection, getWorkflowGraphStepContext, insertWorkflowStepFromPalette, normalizeGraphEdgeKind, normalizeGraphRunStatus, parseDependencies, removeWorkflowStep, renameWorkflowStep, setGraphGroupCollapsed, summarizeWorkflowGraphInterface, summarizeWorkflowGraphTriggers, updateContainerMetadata, updateGraphEdgeMetadata, updateGraphGroupMetadata, updateStepAdvancedMetadata, updateStepApprovalMetadata, updateStepDataFlowMetadata, updateStepExecutionMetadata, updateStepNote, updateStepResourceMetadata, updateStepTestingMetadata, type WorkflowGraphContainerSummary, type WorkflowGraphContainerType, type WorkflowGraphDataFlowMap, type WorkflowGraphDefinitionNavigatorItem, type WorkflowGraphEdge, type WorkflowGraphEdgeKind, type WorkflowGraphEdgeMetadataRecord, type WorkflowGraphExecutionEvidenceSummary, type WorkflowGraphFailureRouteSummary, type WorkflowGraphInspectorMode, type WorkflowGraphInspectorSummary, type WorkflowGraphInterfaceInput, type WorkflowGraphNavigatorFilter, type WorkflowGraphPaletteNodeKind, type WorkflowGraphRepairPlan, type WorkflowGraphRunStatus, type WorkflowGraphSelectionMode, type WorkflowGraphSelectionSummary, type WorkflowGraphStep, type WorkflowGraphStepContext, type WorkflowGraphTestDrawerSummary, type WorkflowGraphTriggerSummary, type WorkflowGraphWorkbenchSummary } from "../workflow-graph.js";
import { CREATE_PARENT_ISSUE_POLICIES, normalizeCreateParentIssuePolicy, type CreateParentIssuePolicy } from "../workflow-parent-policy.js";
import type { PluginPageProps, PluginWidgetProps, StepEditorMode, ProjectOption, LabelOption, WorkflowToolOption, WorkflowToolGrant, WorkflowOverviewData, StatusFilter, WorkflowScopeFilter, WorkflowRestoreKind, WorkflowSummary, WorkflowRunSummary } from "../workflow-page-types.js";
import { badgeRowStyle, buttonDisabledStyle, buttonStyle, dangerButtonStyle, filterTabStyle, graphPolicyBadgeStyle, headerRowStyle, inputStyle, mutedTextStyle, noticeStyle, pageStyle, primaryButtonStyle, sectionTitleStyle, selectStyle, statusBadgeStyle, textareaStyle, titleStyle, widgetCountStyle, widgetTitleStyle, widgetStyle } from "../workflow-page-styles.js";
import { apiBaseUrl, createCompanyLabel, fetchCompanyLabels, formatDateTime, useAvailableWorkflowTools, useHostContext, usePluginAction, useWorkflowOverview, useWorkflowRunDetail } from "../workflow-page-api.js";
import { ErrorState, FieldLabel, HelpIcon, HelpedText } from "../shared-controls.js";
import { splitCommaList, WorkflowToolPicker } from "../workflow-tool-picker.js";
import { GraphModeTabs, StepWorkspaceEditor, type StepWorkspaceGraphEditorProps } from "../step-workspace-editor.js";
import { WorkflowGraphTestDrawer } from "./GraphTestDrawer.js";
import { filterRunsForWorkflows, hasRecurringWorkflowTrigger, isManualMissionPlanWorkflow } from "../workflow-filters.js";
import { WorkflowDefinitionList, WorkflowDefinitionMiniFlow } from "../workflow-definition-list.js";
import { WorkflowRestoreDialog } from "../workflow-restore-dialog.js";
import { buildWorkflowInterfaceMetadata, formatJsonArrayForForm, isRecord, normalizeMaxDailyRunsInput, parseJsonArrayField } from "../workflow-form-utils.js";
import { WorkflowHelpOverlay } from "../workflow-help-overlay.js";
import { WorkflowDefinitionsResizeHandle } from "../workflow-definitions-resize-handle.js";
import { WorkflowPageHeader } from "../workflow-page-header.js";
import { WorkflowDefinitionsToolbar } from "../workflow-definitions-toolbar.js";
import { WorkflowErrorState, WorkflowLoadingState } from "../workflow-page-states.js";
import { WorkflowRunOverlayBanner } from "../workflow-run-overlay-banner.js";
import { formPanelStyle, workflowCreateActionsStyle, workflowCreateFieldStyle, workflowCreateHeaderStyle, workflowCreateIdentityStyle, workflowCreateSetupStripStyle, workflowCreateShellStyle, workflowCreateWorkspaceStyle, workflowFocusSectionStyle, workflowFocusToolbarGroupStyle, workflowFocusToolbarStyle, workflowManagementShellStyle, workflowSelectedHeaderStyle, workflowSelectedIdentityStyle, workflowSelectedSetupStripStyle, workflowSelectedWorkspaceStyle } from "../workflow-layout-styles.js";
import { WorkflowRunSections, type WorkflowRunHistoryScope } from "../workflow-run-sections.js";
import { WorkflowDefinitionRail } from "../workflow-definition-rail.js";
import { WorkflowExportPreview, WorkflowInterfaceFields, WorkflowInterfaceSummary } from "../workflow-interface-editor.js";
import { graphInspectorResizeHandleStyle, graphPaletteItems, graphShellStyle } from "./graphStyles.js";
import { type GraphCanvasPanState, type GraphContextMenuState, type GraphEdgeActionAnchor, type GraphNodeDragState } from "./graphUiUtils.js";
import { clampGraphCanvasScale, clampGraphInspectorWidth, graphEdgeMetadataFor, isEditableKeyboardTarget, LABEL_COLOR_PRESETS } from "./WorkflowGraphEditorHelpers.js";
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
  const [canvasScale, setCanvasScale] = useState<number>(1);
  const [graphInspectorWidth, setGraphInspectorWidth] = useState<number>(420);
  const [rawStepJsonText, setRawStepJsonText] = useState<string>("");
  const [rawStepJsonFeedback, setRawStepJsonFeedback] = useState<{ tone: "info" | "error" | "success"; message: string } | null>(null);
  const [graphContextMenu, setGraphContextMenu] = useState<GraphContextMenuState | null>(null);
  const { selectedCompanyId: graphCompanyId } = useCompany();
  const [graphAgents, setGraphAgents] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    const cid = graphCompanyId ?? "";
    if (!cid.trim()) return;
    let cancelled = false;
    fetch(`${apiBaseUrl()}/api/companies/${encodeURIComponent(cid)}/agents`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data: unknown) => {
        if (cancelled || !Array.isArray(data)) return;
        setGraphAgents(
          data
            .filter((a): a is Record<string, unknown> => Boolean(a && typeof a === "object"))
            .map((a) => ({ id: String(a.id ?? ""), name: String(a.name ?? a.id ?? "") })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [graphCompanyId]);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [connectingFromStepId, setConnectingFromStepId] = useState<string | null>(null);
  const [draggingStepId, setDraggingStepId] = useState<string | null>(null);
  const [isCanvasPanning, setIsCanvasPanning] = useState<boolean>(false);
  const [canvasPanX, setCanvasPanX] = useState<number>(0);
  const [canvasPanY, setCanvasPanY] = useState<number>(0);
  const graphCanvasRef = React.useRef<HTMLDivElement | null>(null);
  const graphNodeDragRef = React.useRef<GraphNodeDragState | null>(null);
  const graphCanvasPanRef = React.useRef<GraphCanvasPanState | null>(null);
  const suppressNodeClickRef = React.useRef<string | null>(null);
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
        ? "#a78bfa"
        : "#fbbf24";
  const graphTriggerSummary = triggerSummary ?? summarizeWorkflowGraphTriggers({});
  const selectedRawStepJson = useMemo(
    () => selectedStep ? JSON.stringify(stepsToJson([selectedStep])[0], null, 2) : "",
    [selectedStep],
  );
  const canvasWidth = Math.max(620, ...graph.nodes.map((node) => node.x + 230), 620);
  const canvasHeight = Math.max(360, ...graph.nodes.map((node) => node.y + 132), 360);
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

  useEffect(() => {
    setRawStepJsonText(selectedRawStepJson);
    setRawStepJsonFeedback(null);
  }, [selectedRawStepJson]);

  useEffect(() => {
    const container = graphCanvasRef.current;
    if (!container) return undefined;
    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault();
      closeGraphContextMenu();
      const direction = event.deltaY > 0 ? -1 : 1;
      setCanvasScaleFromPoint(canvasScale + direction * 0.1, event.clientX, event.clientY);
    };
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [canvasScale]);

  function updateSelected(patch: Partial<StepDraft>): void {
    if (!selectedStep) return;
    onChange(steps.map((step) => (step.id === selectedStep.id ? { ...step, ...patch } : step)));
  }

  function updateStepGraphPosition(stepId: string, x: number, y: number): void {
    onChange(steps.map((step) => (step.id === stepId ? {
      ...step,
      graphPositionX: Math.round(x),
      graphPositionY: Math.round(y),
    } : step)));
  }

  function setCanvasScaleFromPoint(nextScale: number, clientX?: number, clientY?: number): void {
    const container = graphCanvasRef.current;
    const normalizedScale = clampGraphCanvasScale(nextScale);
    if (!container || clientX === undefined || clientY === undefined) {
      setCanvasScale(normalizedScale);
      return;
    }
    const rect = container.getBoundingClientRect();
    const offsetX = clientX - rect.left;
    const offsetY = clientY - rect.top;
    const graphX = (-canvasPanX + offsetX) / canvasScale;
    const graphY = (-canvasPanY + offsetY) / canvasScale;
    setCanvasScale(normalizedScale);
    setCanvasPanX(offsetX - graphX * normalizedScale);
    setCanvasPanY(offsetY - graphY * normalizedScale);
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

  function updateEdge(sourceId: string, patch: { kind?: string; label?: string; condition?: string }): void {
    if (!selectedStep) return;
    setGraphError("");
    onChange(updateGraphEdgeMetadata(steps, sourceId, selectedStep.id, patch));
  }

  function addAfter(stepId: string | null): void {
    const next = appendStepAfter(steps, stepId);
    onChange(next);
    const insertedIndex = stepId ? steps.findIndex((step) => step.id === stepId) + 1 : next.length - 1;
    setSelectedStepId(next[Math.max(0, insertedIndex)]?.id ?? null);
  }

  function insertPaletteNode(kind: WorkflowGraphPaletteNodeKind): void {
    const beforeIds = new Set(steps.map((step) => step.id));
    const next = insertWorkflowStepFromPalette(steps, selectedStep?.id ?? null, kind);
    onChange(next);
    const insertedStep = next.find((step) => !beforeIds.has(step.id));
    setSelectedStepId(insertedStep?.id ?? selectedStep?.id ?? next[0]?.id ?? null);
    setGraphError("");
  }

  function centerSelectedGraphStep(): void {
    if (!selectedGraphNode || !graphCanvasRef.current) return;
    const container = graphCanvasRef.current;
    const nodeCenterX = (selectedGraphNode.x + 86) * canvasScale;
    const nodeCenterY = (selectedGraphNode.y + 38) * canvasScale;
    setCanvasPanX(container.clientWidth / 2 - nodeCenterX);
    setCanvasPanY(container.clientHeight / 2 - nodeCenterY);
  }

  function centerGraphStep(stepId: string): void {
    const node = graph.nodes.find((candidate) => candidate.step.id === stepId);
    if (!node || !graphCanvasRef.current) return;
    const container = graphCanvasRef.current;
    const nodeCenterX = (node.x + 86) * canvasScale;
    const nodeCenterY = (node.y + 38) * canvasScale;
    setCanvasPanX(container.clientWidth / 2 - nodeCenterX);
    setCanvasPanY(container.clientHeight / 2 - nodeCenterY);
  }

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
    if (actionId === "agent" || actionId === "tool" || actionId === "branch" || actionId === "loop" || actionId === "approval" || actionId === "failure-handler") {
      insertPaletteNode(actionId);
      return;
    }
    if (actionId === "upstream" || actionId === "downstream" || actionId === "connected") {
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
    const insertedIndex = steps.findIndex((step) => step.id === stepId) + 1;
    setSelectedStepId(next[Math.max(0, insertedIndex)]?.id ?? stepId);
  }

  function duplicateSelectedStep(): void {
    if (!selectedStep) return;
    duplicateStep(selectedStep.id);
  }

  function duplicateSelectedContainer(): void {
    if (!selectedContainerSummary) return;
    const beforeIds = new Set(steps.map((step) => step.id));
    const next = duplicateWorkflowContainer(steps, selectedContainerSummary.id);
    onChange(next);
    const copiedStep = next.find((step) => !beforeIds.has(step.id));
    setSelectedStepId(copiedStep?.id ?? selectedStep?.id ?? next[0]?.id ?? null);
  }

  function deleteStep(stepId: string): void {
    const selectedIndex = steps.findIndex((step) => step.id === stepId);
    const next = removeWorkflowStep(steps, stepId);
    onChange(next);
    setSelectedStepId(next[Math.min(Math.max(selectedIndex, 0), Math.max(next.length - 1, 0))]?.id ?? null);
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

  function beginGraphInspectorResize(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startClientX = event.clientX;
    const startWidth = graphInspectorWidth;
    const onMove = (moveEvent: PointerEvent): void => {
      setGraphInspectorWidth(clampGraphInspectorWidth(startWidth - (moveEvent.clientX - startClientX)));
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
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

  function closeGraphContextMenu(): void {
    setGraphContextMenu(null);
  }

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

  function beginCanvasPan(event: React.PointerEvent<HTMLDivElement>): void {
    const target = event.target as HTMLElement;
    if (target.closest("[data-graph-node='true'], [data-graph-toolbar='true'], [data-graph-menu='true'], [data-graph-edge='true'], [data-graph-handle='true'], [data-graph-edge-remove='true']")) return;
    if (event.button !== 0 && event.button !== 1) return;
    closeGraphContextMenu();
    graphCanvasPanRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPanX: canvasPanX,
      startPanY: canvasPanY,
    };
    setIsCanvasPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleCanvasPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const pan = graphCanvasPanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    setCanvasPanX(pan.startPanX + (event.clientX - pan.startClientX));
    setCanvasPanY(pan.startPanY + (event.clientY - pan.startClientY));
  }

  function endCanvasPan(event: React.PointerEvent<HTMLDivElement>): void {
    const pan = graphCanvasPanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    graphCanvasPanRef.current = null;
    setIsCanvasPanning(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
  }

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
    if (actionId === "select-upstream" || actionId === "select-downstream" || actionId === "select-connected") {
      const mode = actionId.replace("select-", "") as WorkflowGraphSelectionMode;
      setSelectedStepId(stepId);
      setSelectedPathStepIds(expandWorkflowGraphSelection(steps, [stepId], mode));
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
    if (actionId === "fit-canvas" || actionId === "actual-size" || actionId === "center-selected") {
      runWorkbenchAction(actionId);
      return;
    }
    if (actionId === "agent" || actionId === "tool" || actionId === "branch" || actionId === "loop" || actionId === "approval" || actionId === "failure-handler") {
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

  function groupSelectedWithDependencies(): void {
    if (!selectedStep) return;
    const upstreamIds = parseDependencies(selectedStep.dependsOn);
    const stepIds = Array.from(new Set([...upstreamIds, selectedStep.id]));
    const groupId = selectedStep.graphGroupId.trim() || `${selectedStep.id}-group`;
    onChange(assignStepsToGroup(steps, stepIds, {
      id: groupId,
      title: selectedStep.graphGroupTitle.trim() || "Workflow group",
      color: selectedStep.graphGroupColor.trim() || "#64748b",
    }));
  }

  function clearSelectedGroup(): void {
    if (!selectedStep) return;
    onChange(clearStepsGroup(steps, [selectedStep.id]));
  }

  function setSelectedGroupCollapsed(collapsed: boolean): void {
    if (!selectedStep || !selectedStep.graphGroupId.trim()) return;
    onChange(setGraphGroupCollapsed(steps, selectedStep.graphGroupId, collapsed));
  }

  function updateSelectedGroupMetadata(patch: { title?: string; color?: string; collapsedByDefault?: boolean }): void {
    if (!selectedStep) return;
    const groupId = selectedStep.graphGroupId.trim();
    if (!groupId) {
      onChange(steps.map((step) => step.id === selectedStep.id ? {
        ...step,
        ...(patch.title !== undefined ? { graphGroupTitle: patch.title } : {}),
        ...(patch.color !== undefined ? { graphGroupColor: patch.color } : {}),
        ...(patch.collapsedByDefault !== undefined ? { graphGroupCollapsedByDefault: patch.collapsedByDefault } : {}),
      } : step));
      return;
    }
    onChange(updateGraphGroupMetadata(steps, groupId, patch));
  }

  function updateSelectedAdvanced(patch: Partial<Pick<StepDraft, "onFailure" | "maxRetries" | "graphRetryDelaySeconds" | "graphRetryBackoff" | "graphRetryJitter" | "timeoutSeconds" | "graphSleepSeconds" | "graphSuspendUntil" | "graphSuspendTimeoutSeconds" | "graphSuspendTimeoutAction" | "graphEarlyReturn" | "graphEarlyReturnContentType" | "graphEarlyReturnSchema" | "graphErrorHandler" | "graphErrorHandlerScope" | "graphErrorHandlerInput" | "graphRestartBoundary" | "graphRestartStrategy" | "graphRestartInput" | "graphEarlyStopCondition" | "graphEarlyStopLabelSkipped">>): void {
    if (!selectedStep) return;
    const nextDraft = { ...selectedStep, ...patch };
    onChange(updateStepAdvancedMetadata(steps, selectedStep.id, {
      ...(Object.hasOwn(patch, "onFailure") ? { onFailure: nextDraft.onFailure } : {}),
      ...(Object.hasOwn(patch, "maxRetries") ? { maxRetries: parseOptionalNonNegativeInteger(String(nextDraft.maxRetries ?? "")) } : {}),
      ...(Object.hasOwn(patch, "graphRetryDelaySeconds") ? { retryDelaySeconds: parseOptionalPositiveInteger(String(nextDraft.graphRetryDelaySeconds ?? "")) } : {}),
      ...(Object.hasOwn(patch, "graphRetryBackoff") ? { retryBackoff: nextDraft.graphRetryBackoff } : {}),
      ...(Object.hasOwn(patch, "graphRetryJitter") ? { retryJitter: nextDraft.graphRetryJitter } : {}),
      ...(Object.hasOwn(patch, "timeoutSeconds") ? { timeoutSeconds: parseOptionalPositiveInteger(String(nextDraft.timeoutSeconds ?? "")) } : {}),
      ...(Object.hasOwn(patch, "graphSleepSeconds") ? { sleepSeconds: parseOptionalPositiveInteger(String(nextDraft.graphSleepSeconds ?? "")) } : {}),
      ...(Object.hasOwn(patch, "graphSuspendUntil") ? { suspendUntil: nextDraft.graphSuspendUntil } : {}),
      ...(Object.hasOwn(patch, "graphSuspendTimeoutSeconds") ? { suspendTimeoutSeconds: parseOptionalPositiveInteger(String(nextDraft.graphSuspendTimeoutSeconds ?? "")) } : {}),
      ...(Object.hasOwn(patch, "graphSuspendTimeoutAction") ? { suspendTimeoutAction: nextDraft.graphSuspendTimeoutAction } : {}),
      ...(Object.hasOwn(patch, "graphEarlyReturn") ? { earlyReturn: nextDraft.graphEarlyReturn } : {}),
      ...(Object.hasOwn(patch, "graphEarlyReturnContentType") ? { earlyReturnContentType: nextDraft.graphEarlyReturnContentType } : {}),
      ...(Object.hasOwn(patch, "graphEarlyReturnSchema") ? { earlyReturnSchema: nextDraft.graphEarlyReturnSchema } : {}),
      ...(Object.hasOwn(patch, "graphErrorHandler") ? { errorHandler: nextDraft.graphErrorHandler } : {}),
      ...(Object.hasOwn(patch, "graphErrorHandlerScope") ? { errorHandlerScope: nextDraft.graphErrorHandlerScope } : {}),
      ...(Object.hasOwn(patch, "graphErrorHandlerInput") ? { errorHandlerInput: nextDraft.graphErrorHandlerInput } : {}),
      ...(Object.hasOwn(patch, "graphRestartBoundary") ? { restartBoundary: nextDraft.graphRestartBoundary } : {}),
      ...(Object.hasOwn(patch, "graphRestartStrategy") ? { restartStrategy: nextDraft.graphRestartStrategy } : {}),
      ...(Object.hasOwn(patch, "graphRestartInput") ? { restartInput: nextDraft.graphRestartInput } : {}),
      ...(Object.hasOwn(patch, "graphEarlyStopCondition") ? { earlyStopCondition: nextDraft.graphEarlyStopCondition } : {}),
      ...(Object.hasOwn(patch, "graphEarlyStopLabelSkipped") ? { earlyStopLabelSkipped: nextDraft.graphEarlyStopLabelSkipped } : {}),
    }));
  }

  function updateSelectedApproval(patch: Partial<Pick<StepDraft, "graphApprovalRequired" | "graphApprovalPrompt" | "graphApprovalRecipients" | "graphApprovalTimeoutSeconds" | "graphApprovalTimeoutAction">>): void {
    if (!selectedStep) return;
    const nextDraft = { ...selectedStep, ...patch };
    onChange(updateStepApprovalMetadata(steps, selectedStep.id, {
      ...(Object.hasOwn(patch, "graphApprovalRequired") ? { required: nextDraft.graphApprovalRequired } : {}),
      ...(Object.hasOwn(patch, "graphApprovalPrompt") ? { prompt: nextDraft.graphApprovalPrompt } : {}),
      ...(Object.hasOwn(patch, "graphApprovalRecipients") ? { recipients: nextDraft.graphApprovalRecipients } : {}),
      ...(Object.hasOwn(patch, "graphApprovalTimeoutSeconds") ? { timeoutSeconds: parseOptionalPositiveInteger(String(nextDraft.graphApprovalTimeoutSeconds ?? "")) } : {}),
      ...(Object.hasOwn(patch, "graphApprovalTimeoutAction") ? { timeoutAction: nextDraft.graphApprovalTimeoutAction } : {}),
    }));
  }

  function updateSelectedTesting(patch: Partial<Pick<StepDraft, "graphMockEnabled" | "graphMockResult" | "graphPinnedResultRunId">>): void {
    if (!selectedStep) return;
    const nextDraft = { ...selectedStep, ...patch };
    onChange(updateStepTestingMetadata(steps, selectedStep.id, {
      ...(Object.hasOwn(patch, "graphMockEnabled") ? { mockEnabled: nextDraft.graphMockEnabled } : {}),
      ...(Object.hasOwn(patch, "graphMockResult") ? { mockResult: nextDraft.graphMockResult } : {}),
      ...(Object.hasOwn(patch, "graphPinnedResultRunId") ? { pinnedResultRunId: nextDraft.graphPinnedResultRunId } : {}),
    }));
  }

  function updateSelectedExecution(patch: Partial<Pick<StepDraft, "graphConcurrencyKey" | "graphConcurrencyLimit" | "graphPriority" | "graphCacheEnabled" | "graphCacheTtlSeconds" | "graphDeleteAfterUse">>): void {
    if (!selectedStep) return;
    const nextDraft = { ...selectedStep, ...patch };
    onChange(updateStepExecutionMetadata(steps, selectedStep.id, {
      ...(Object.hasOwn(patch, "graphConcurrencyKey") ? { concurrencyKey: nextDraft.graphConcurrencyKey } : {}),
      ...(Object.hasOwn(patch, "graphConcurrencyLimit") ? { concurrencyLimit: parseOptionalPositiveInteger(String(nextDraft.graphConcurrencyLimit ?? "")) } : {}),
      ...(Object.hasOwn(patch, "graphPriority") ? { priority: nextDraft.graphPriority } : {}),
      ...(Object.hasOwn(patch, "graphCacheEnabled") ? { cacheEnabled: nextDraft.graphCacheEnabled } : {}),
      ...(Object.hasOwn(patch, "graphCacheTtlSeconds") ? { cacheTtlSeconds: parseOptionalPositiveInteger(String(nextDraft.graphCacheTtlSeconds ?? "")) } : {}),
      ...(Object.hasOwn(patch, "graphDeleteAfterUse") ? { deleteAfterUse: nextDraft.graphDeleteAfterUse } : {}),
    }));
  }

  function updateSelectedDataFlow(patch: Partial<Pick<StepDraft, "graphInputExpression" | "graphOutputSchema" | "graphWorkProductRequired" | "graphWorkProductPattern">>): void {
    if (!selectedStep) return;
    const nextDraft = { ...selectedStep, ...patch };
    onChange(updateStepDataFlowMetadata(steps, selectedStep.id, {
      ...(Object.hasOwn(patch, "graphInputExpression") ? { inputExpression: nextDraft.graphInputExpression } : {}),
      ...(Object.hasOwn(patch, "graphOutputSchema") ? { outputSchema: nextDraft.graphOutputSchema } : {}),
      ...(Object.hasOwn(patch, "graphWorkProductRequired") ? { workProductRequired: nextDraft.graphWorkProductRequired } : {}),
      ...(Object.hasOwn(patch, "graphWorkProductPattern") ? { workProductPattern: nextDraft.graphWorkProductPattern } : {}),
    }));
  }

  function updateSelectedResources(patch: Partial<Pick<StepDraft, "graphResourceRefs" | "graphSecretRefs">>): void {
    if (!selectedStep) return;
    const nextDraft = { ...selectedStep, ...patch };
    onChange(updateStepResourceMetadata(steps, selectedStep.id, {
      ...(Object.hasOwn(patch, "graphResourceRefs") ? { resourceRefs: nextDraft.graphResourceRefs } : {}),
      ...(Object.hasOwn(patch, "graphSecretRefs") ? { secretRefs: nextDraft.graphSecretRefs } : {}),
    }));
  }

  function setSelectedNote(note: string): void {
    if (!selectedStep) return;
    onChange(updateStepNote(steps, selectedStep.id, note));
  }

  function wrapSelectedPathInContainer(): void {
    if (!selectedStep) return;
    const downstreamIds = steps
      .filter((step) => parseDependencies(step.dependsOn).includes(selectedStep.id))
      .map((step) => step.id);
    const stepIds = Array.from(new Set([selectedStep.id, ...downstreamIds]));
    const containerId = selectedStep.graphContainerId.trim() || `${selectedStep.id}-${selectedStep.graphContainerType}`;
    onChange(assignStepsToContainer(steps, stepIds, {
      id: containerId,
      type: selectedStep.graphContainerType,
      title: selectedStep.graphContainerTitle.trim() || (selectedStep.graphContainerType === "loop" ? "Loop container" : "Branch container"),
      description: selectedStep.graphContainerDescription.trim(),
      mode: selectedStep.graphContainerMode,
      condition: selectedStep.graphContainerCondition,
      iterator: selectedStep.graphContainerIterator,
      skipFailure: selectedStep.graphContainerSkipFailure,
      runInParallel: selectedStep.graphContainerRunInParallel,
      parallelism: parseOptionalPositiveInteger(String(selectedStep.graphContainerParallelism ?? "")),
    }));
  }

  function wrapSelectedGraphSelection(containerType: WorkflowGraphContainerType): void {
    if (!selectedStep || selectedPathSummary.blocked || selectedPathSummary.stepIds.length === 0) return;
    const containerId = selectedStep.graphContainerId.trim() || `${selectedStep.id}-${containerType}`;
    onChange(assignStepsToContainer(steps, selectedPathSummary.stepIds, {
      id: containerId,
      type: containerType,
      title: selectedStep.graphContainerTitle.trim() || (containerType === "loop" ? "Loop selection" : "Branch selection"),
      description: selectedStep.graphContainerDescription.trim(),
      mode: containerType === "loop" ? "for-each" : "branch-one",
      condition: selectedStep.graphContainerCondition,
      iterator: selectedStep.graphContainerIterator,
      skipFailure: selectedStep.graphContainerSkipFailure,
      runInParallel: selectedStep.graphContainerRunInParallel,
      parallelism: parseOptionalPositiveInteger(String(selectedStep.graphContainerParallelism ?? "")),
    }));
  }

  function groupSelectedGraphSelection(): void {
    if (!selectedStep || selectedPathSummary.blocked || selectedPathSummary.stepIds.length === 0) return;
    const groupId = selectedStep.graphGroupId.trim() || `${selectedStep.id}-selection`;
    onChange(assignStepsToGroup(steps, selectedPathSummary.stepIds, {
      id: groupId,
      title: selectedStep.graphGroupTitle.trim() || "Selected path",
      color: selectedStep.graphGroupColor.trim() || "#22c55e",
    }));
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

  function updateSelectedContainerMetadata(patch: Partial<Pick<StepDraft, "graphContainerType" | "graphContainerTitle" | "graphContainerDescription" | "graphContainerMode" | "graphContainerCondition" | "graphContainerIterator" | "graphContainerSkipFailure" | "graphContainerRunInParallel" | "graphContainerParallelism">>): void {
    if (!selectedStep) return;
    const groupId = selectedStep.graphContainerId.trim();
    const nextDraft = { ...selectedStep, ...patch };
    const parsedParallelism = parseOptionalPositiveInteger(String(nextDraft.graphContainerParallelism ?? ""));
    if (!groupId) {
      onChange(steps.map((step) => step.id === selectedStep.id ? { ...step, ...patch } : step));
      return;
    }
    onChange(updateContainerMetadata(steps, groupId, {
      ...(Object.hasOwn(patch, "graphContainerType") ? { type: nextDraft.graphContainerType } : {}),
      ...(Object.hasOwn(patch, "graphContainerTitle") ? { title: nextDraft.graphContainerTitle } : {}),
      ...(Object.hasOwn(patch, "graphContainerDescription") ? { description: nextDraft.graphContainerDescription } : {}),
      ...(Object.hasOwn(patch, "graphContainerMode") ? { mode: nextDraft.graphContainerMode } : {}),
      ...(Object.hasOwn(patch, "graphContainerCondition") ? { condition: nextDraft.graphContainerCondition } : {}),
      ...(Object.hasOwn(patch, "graphContainerIterator") ? { iterator: nextDraft.graphContainerIterator } : {}),
      ...(Object.hasOwn(patch, "graphContainerSkipFailure") ? { skipFailure: nextDraft.graphContainerSkipFailure } : {}),
      ...(Object.hasOwn(patch, "graphContainerRunInParallel") ? { runInParallel: nextDraft.graphContainerRunInParallel } : {}),
      ...(Object.hasOwn(patch, "graphContainerParallelism") ? { parallelism: parsedParallelism } : {}),
    }));
  }

  function renderDataFlowChips(values: string[], emptyLabel: string, tone: "normal" | "muted" | "error" = "normal"): JSX.Element {
    if (values.length === 0) {
      return <span style={{ ...mutedTextStyle, fontSize: "11px" }}>{emptyLabel}</span>;
    }
    const color = tone === "error" ? "var(--destructive, #ef4444)" : tone === "muted" ? "var(--muted-foreground, #94a3b8)" : "#14b8a6";
    return (
      <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
        {values.map((value) => (
          <span key={value} style={{ ...graphPolicyBadgeStyle, color }}>{value}</span>
        ))}
      </div>
    );
  }

  function parseRawSelectedStepJson(): StepDraft | null {
    if (!selectedStep) return null;
    try {
      const parsed = JSON.parse(rawStepJsonText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setRawStepJsonFeedback({ tone: "error", message: "Selected step JSON must be one object." });
        return null;
      }
      const [draft] = jsonToSteps([parsed as WorkflowOverviewData["workflows"][number]["steps"][number]]);
      if (!draft?.id.trim()) {
        setRawStepJsonFeedback({ tone: "error", message: "Selected step JSON must include a non-empty id." });
        return null;
      }
      const duplicate = steps.some((step) => step.id !== selectedStep.id && step.id === draft.id);
      if (duplicate) {
        setRawStepJsonFeedback({ tone: "error", message: `Step id "${draft.id}" already exists.` });
        return null;
      }
      return draft;
    } catch (error) {
      setRawStepJsonFeedback({ tone: "error", message: `JSON parse failed: ${error instanceof Error ? error.message : String(error)}` });
      return null;
    }
  }

  function validateRawSelectedStepJson(): void {
    const parsed = parseRawSelectedStepJson();
    if (!parsed) return;
    setRawStepJsonFeedback({ tone: "success", message: `Valid step JSON for ${parsed.id}.` });
  }

    function applyRawSelectedStepJson(): void {
      if (!selectedStep) return;
      const parsed = parseRawSelectedStepJson();
      if (!parsed) return;
      const renamedSteps = parsed.id !== selectedStep.id
        ? renameWorkflowStep(steps, selectedStep.id, parsed.id)
        : steps;
      onChange(renamedSteps.map((step) => (step.id === parsed.id ? parsed : step)));
      setSelectedStepId(parsed.id);
    setSelectedPathStepIds(parsed.id.trim() ? [parsed.id] : []);
    setRawStepJsonFeedback({ tone: "success", message: `Applied JSON to ${parsed.id}.` });
    setGraphError("");
  }

  if (steps.length === 0) {
    return (
      <div style={formPanelStyle}>
        <p key="empty-message" style={mutedTextStyle}>No steps yet. Start with an entry node.</p>
        <div key="empty-actions" style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
          <button key="add-entry" type="button" style={primaryButtonStyle} onClick={() => addAfter(null)}>
            Add Entry Step
          </button>
          <div key="starter-palette" style={{ display: "contents" }}>
            {graphPaletteItems.slice(0, 2).map((item) => (
              <button key={item.kind} type="button" style={buttonStyle} onClick={() => insertPaletteNode(item.kind)}>
                Start with {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ ...graphShellStyle, gridTemplateColumns: `minmax(620px, 1fr) 8px ${graphInspectorWidth}px` }}>
      {surface === "stacked" ? (
        <div
          key="graph-trigger-summary"
          style={{
            gridColumn: "1 / -1",
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) auto",
            gap: "10px",
            alignItems: "center",
            padding: "10px 12px",
            border: "1px solid var(--border, #334155)",
            borderRadius: "8px",
            background: "var(--background, #020617)",
          }}
        >
          <div key="trigger-copy" style={{ minWidth: 0 }}>
            <div key="trigger-title-row" style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <span key="title" style={{ fontSize: "12px", fontWeight: 800, color: "var(--foreground, #f8fafc)" }}>Flow triggers</span>
              <span key="status" style={{ ...statusBadgeStyle(graphTriggerSummary.status), fontSize: "10px" }}>{graphTriggerSummary.status}</span>
              {graphTriggerSummary.badges.map((badge) => (
                <span key={badge} style={graphPolicyBadgeStyle}>{badge}</span>
              ))}
            </div>
            <p key="description" style={{ margin: "5px 0 0", color: "var(--muted-foreground, #94a3b8)", fontSize: "12px", overflowWrap: "anywhere" }}>
              {graphTriggerSummary.description}
            </p>
            {graphTriggerSummary.schedule.error ? (
              <p key="error" style={{ margin: "5px 0 0", color: "var(--destructive, #ef4444)", fontSize: "12px", overflowWrap: "anywhere" }}>
                Last schedule error{graphTriggerSummary.schedule.errorAt ? ` (${formatDateTime(graphTriggerSummary.schedule.errorAt)})` : ""}: {graphTriggerSummary.schedule.error}
              </p>
            ) : (
              <Fragment key="error-placeholder" />
            )}
          </div>
          <div key="trigger-timing" style={{ display: "grid", gap: "2px", justifyItems: "end" }}>
            <span key="timezone" style={{ ...mutedTextStyle, fontSize: "11px" }}>
              {graphTriggerSummary.schedule.timezone || "Local timezone"}
            </span>
            <span key="last-run" style={{ fontSize: "12px", color: "var(--foreground, #f8fafc)", whiteSpace: "nowrap" }}>
              {graphTriggerSummary.schedule.lastRunAt ? `Last run ${formatDateTime(graphTriggerSummary.schedule.lastRunAt)}` : "No scheduled run yet"}
            </span>
          </div>
        </div>
      ) : (
        <Fragment key="graph-trigger-summary-placeholder" />
      )}
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
