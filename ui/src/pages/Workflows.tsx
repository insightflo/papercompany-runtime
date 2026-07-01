import * as React from "react";
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type JSX } from "react";
import { useCompany } from "../context/CompanyContext";
import { buildManualRunFeedback, buildManualRunButtonState, findNewRunId, manualRunUnavailableMessage } from "./workflows/run-feedback.js";
import { ActiveRunsTable, RecentRunsTable, WorkflowRunDebugStrip, WorkflowRunDrawer, workflowRunDrawerActionsStyle, workflowRunOverlayBannerStyle, type WorkflowRunDrawerMode } from "./workflows/workflow-runs.js";
import { jsonToSteps, parseOptionalNonNegativeInteger, parseOptionalPositiveInteger, stepsToJson, withStepDraftDefaults, type StepDraft } from "./workflows/step-draft.js";
import { appendStepAfter, applyStepRunsToGraphSteps, applyWorkflowGraphFailureRoute, assignStepsToContainer, assignStepsToGroup, buildWorkflowGraphContainerSummary, buildWorkflowGraphDataFlowMap, buildWorkflowGraphDefinitionNavigator, buildWorkflowGraphExecutionEvidenceSummary, buildWorkflowGraphExportSnapshot, buildWorkflowGraphFailureRouteSummary, buildWorkflowGraphInspectorSummary, buildWorkflowGraphModel, buildWorkflowGraphRepairPlan, buildWorkflowGraphRunDebugSummary, buildWorkflowGraphSelectionSummary, buildWorkflowGraphStructurePaletteSummary, buildWorkflowGraphTestDrawerSummary, buildWorkflowGraphWorkbenchSummary, clearStepsGroup, clearWorkflowContainer, connectSteps, disconnectSteps, duplicateWorkflowContainer, duplicateWorkflowStep, expandWorkflowGraphSelection, getWorkflowGraphStepContext, insertWorkflowStepFromPalette, normalizeGraphEdgeKind, normalizeGraphRunStatus, parseDependencies, removeWorkflowStep, renameWorkflowStep, setGraphGroupCollapsed, summarizeWorkflowGraphInterface, summarizeWorkflowGraphTriggers, updateContainerMetadata, updateGraphEdgeMetadata, updateGraphGroupMetadata, updateStepAdvancedMetadata, updateStepApprovalMetadata, updateStepDataFlowMetadata, updateStepExecutionMetadata, updateStepNote, updateStepResourceMetadata, updateStepTestingMetadata, type WorkflowGraphContainerSummary, type WorkflowGraphContainerType, type WorkflowGraphDataFlowMap, type WorkflowGraphDefinitionNavigatorItem, type WorkflowGraphEdge, type WorkflowGraphEdgeKind, type WorkflowGraphEdgeMetadataRecord, type WorkflowGraphExecutionEvidenceSummary, type WorkflowGraphFailureRouteSummary, type WorkflowGraphInspectorMode, type WorkflowGraphInspectorSummary, type WorkflowGraphInterfaceInput, type WorkflowGraphNavigatorFilter, type WorkflowGraphPaletteNodeKind, type WorkflowGraphRepairPlan, type WorkflowGraphRunStatus, type WorkflowGraphSelectionMode, type WorkflowGraphSelectionSummary, type WorkflowGraphStep, type WorkflowGraphStepContext, type WorkflowGraphTestDrawerSummary, type WorkflowGraphTriggerSummary, type WorkflowGraphWorkbenchSummary } from "./workflows/workflow-graph.js";
import { CREATE_PARENT_ISSUE_POLICIES, normalizeCreateParentIssuePolicy, type CreateParentIssuePolicy } from "./workflows/workflow-parent-policy.js";
import type { PluginPageProps, PluginWidgetProps, StepEditorMode, ProjectOption, LabelOption, WorkflowToolOption, WorkflowToolGrant, WorkflowOverviewData, StatusFilter, WorkflowScopeFilter, WorkflowRestoreKind, WorkflowSummary, WorkflowRunSummary } from "./workflows/workflow-page-types.js";
import { badgeRowStyle, buttonDisabledStyle, buttonStyle, dangerButtonStyle, filterTabStyle, graphPolicyBadgeStyle, headerRowStyle, inputStyle, mutedTextStyle, noticeStyle, pageStyle, primaryButtonStyle, sectionTitleStyle, selectStyle, statusBadgeStyle, textareaStyle, titleStyle, widgetCountStyle, widgetTitleStyle, widgetStyle } from "./workflows/workflow-page-styles.js";
import { apiBaseUrl, createCompanyLabel, fetchCompanyLabels, formatDateTime, useAvailableWorkflowTools, useHostContext, usePluginAction, useWorkflowOverview, useWorkflowRunDetail } from "./workflows/workflow-page-api.js";
import { ErrorState, FieldLabel, HelpIcon, HelpedText } from "./workflows/shared-controls.js";
import { splitCommaList, WorkflowToolPicker } from "./workflows/workflow-tool-picker.js";
import { GraphModeTabs, StepWorkspaceEditor, type StepWorkspaceGraphEditorProps } from "./workflows/step-workspace-editor.js";
import { WorkflowGraphTestDrawer } from "./workflows/graph-editor/GraphTestDrawer.js";
import { filterRunsForWorkflows, hasRecurringWorkflowTrigger, isManualMissionPlanWorkflow } from "./workflows/workflow-filters.js";
import { WorkflowDefinitionList, WorkflowDefinitionMiniFlow } from "./workflows/workflow-definition-list.js";
import { WorkflowRestoreDialog } from "./workflows/workflow-restore-dialog.js";
import { buildWorkflowInterfaceMetadata, formatJsonArrayForForm, isRecord, normalizeMaxDailyRunsInput, parseJsonArrayField } from "./workflows/workflow-form-utils.js";
import { WorkflowHelpOverlay } from "./workflows/workflow-help-overlay.js";
import { WorkflowDefinitionsResizeHandle } from "./workflows/workflow-definitions-resize-handle.js";
import { WorkflowPageHeader } from "./workflows/workflow-page-header.js";
import { WorkflowDefinitionsToolbar } from "./workflows/workflow-definitions-toolbar.js";
import { WorkflowErrorState, WorkflowLoadingState } from "./workflows/workflow-page-states.js";
import { WorkflowRunOverlayBanner } from "./workflows/workflow-run-overlay-banner.js";
import { DefinitionsTable } from "./workflows/workflow-definitions-table.js";
import { WorkflowCreateForm } from "./workflows/workflow-create-form.js";
export { WorkflowDashboardWidget, WorkflowSidebarLink } from "./workflows/workflow-sidebar-and-widget.js";
import { formPanelStyle, workflowCreateActionsStyle, workflowCreateFieldStyle, workflowCreateHeaderStyle, workflowCreateIdentityStyle, workflowCreateSetupStripStyle, workflowCreateShellStyle, workflowCreateWorkspaceStyle, workflowFocusSectionStyle, workflowFocusToolbarGroupStyle, workflowFocusToolbarStyle, workflowManagementShellStyle, workflowSelectedEditorStyle, workflowSelectedHeaderStyle, workflowSelectedIdentityStyle, workflowSelectedSetupStripStyle, workflowSelectedWorkspaceStyle } from "./workflows/workflow-layout-styles.js";
import { WorkflowRunSections, type WorkflowRunHistoryScope } from "./workflows/workflow-run-sections.js";
import { WorkflowDefinitionRail } from "./workflows/workflow-definition-rail.js";
import { WorkflowExportPreview, WorkflowInterfaceFields, WorkflowInterfaceSummary } from "./workflows/workflow-interface-editor.js";
import { graphInspectorResizeHandleStyle, graphPaletteItems, graphShellStyle } from "./workflows/graph-editor/graphStyles.js";
import { type GraphCanvasPanState, type GraphContextMenuState, type GraphEdgeActionAnchor, type GraphNodeDragState } from "./workflows/graph-editor/graphUiUtils.js";
import { GraphCanvas } from "./workflows/graph-editor/GraphCanvas.js";
import { GraphInspector } from "./workflows/graph-editor/GraphInspector.js";
import { renderWorkflowGraphEditor } from "./workflows/graph-editor/WorkflowGraphEditor.js";

export { jsonToSteps, stepsToJson };
export type { StepDraft };

const PLUGIN_ID = "paperclip.core-workflows";

// Fix: prevent parent window from capturing arrow keys in textareas
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    if (target?.tagName === "TEXTAREA" && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.stopPropagation();
    }
  }, true);
}




























export function WorkflowPage(props: PluginPageProps): JSX.Element {
  const hostContext = useHostContext();
  const companyId = hostContext.companyId ?? props.context?.companyId ?? "";
  const overview = useWorkflowOverview(companyId);
  const { tools: availableTools, grants: availableToolGrants, toolSystem } = useAvailableWorkflowTools(companyId);
  const createWorkflow = usePluginAction("create-workflow");
  const abortRun = usePluginAction("abort-run");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [workflowScopeFilter, setWorkflowScopeFilter] = useState<WorkflowScopeFilter>("reusable");
  const [workflowStatusFilter, setWorkflowStatusFilter] = useState<StatusFilter>("active");
  const [runHistoryScope, setRunHistoryScope] = useState<WorkflowRunHistoryScope>("all");
  const [activeRunsScope, setActiveRunsScope] = useState<WorkflowRunHistoryScope>("all");
  const [selectedHistoryWorkflowId, setSelectedHistoryWorkflowId] = useState<string | null>(null);
  const [navigatorSearch, setNavigatorSearch] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [showNewWorkflowForm, setShowNewWorkflowForm] = useState(false);
  const [definitionsCollapsed, setDefinitionsCollapsed] = useState(false);
  const [definitionsHeight, setDefinitionsHeight] = useState<number | null>(null);
  const definitionsResizeRef = useRef<number>(0);
  const definitionsStartY = useRef<number>(0);
  const [labels, setLabels] = useState<LabelOption[]>([]);
  const [highlightedRunId, setHighlightedRunId] = useState<string | null>(null);

  async function refreshOverview(): Promise<void> {
    if (isRefreshing) {
      return;
    }
    setIsRefreshing(true);
    try {
      await overview.refresh();
    } finally {
      setIsRefreshing(false);
    }
  }

  useEffect(() => {
    const nextLabels = overview.data?.labels ?? [];
    setLabels(nextLabels.map((label) => ({
      id: String(label.id),
      name: String(label.name ?? label.id),
      color: typeof label.color === "string" && label.color.trim() ? label.color : "#6366f1",
    })));
  }, [overview.data?.labels]);

  useEffect(() => {
    if (!companyId.trim()) {
      setLabels([]);
    }
  }, [companyId]);

  async function refreshLabels(): Promise<LabelOption[]> {
    const next = await fetchCompanyLabels(companyId);
    setLabels(next);
    return next;
  }

  function handleAbortRun(runId: string): void {
    void (async () => {
      try {
        await abortRun({ runId });
        await refreshOverview();
      } catch { /* ignore */ }
    })();
  }

  const refreshButtonLabel = isRefreshing ? "갱신 중..." : "↻ Refresh";

  const allWorkflows = overview.data?.workflows ?? [];
  const reusableWorkflows = useMemo(
    () => allWorkflows.filter((workflow) => !isManualMissionPlanWorkflow(workflow)),
    [allWorkflows],
  );
  const manualMissionWorkflows = useMemo(
    () => allWorkflows.filter(isManualMissionPlanWorkflow),
    [allWorkflows],
  );
  const scopedWorkflows = workflowScopeFilter === "manual_mission" ? manualMissionWorkflows : reusableWorkflows;
  const activeWorkflows = useMemo(
    () => scopedWorkflows.filter((w) => w.status.trim().toLowerCase() !== "archived"),
    [scopedWorkflows],
  );
  const archivedWorkflows = useMemo(
    () => scopedWorkflows.filter((w) => w.status.trim().toLowerCase() === "archived"),
    [scopedWorkflows],
  );
  const filteredWorkflows = workflowStatusFilter === "active" ? activeWorkflows : archivedWorkflows;

  if (overview.loading) {
    return <WorkflowLoadingState pluginId={PLUGIN_ID} isRefreshing={isRefreshing} refreshButtonLabel={refreshButtonLabel} onRefresh={refreshOverview} />;
  }

  if (overview.error) {
    return <WorkflowErrorState pluginId={PLUGIN_ID} isRefreshing={isRefreshing} refreshButtonLabel={refreshButtonLabel} onRefresh={refreshOverview} message={`Failed to load workflows: ${overview.error.message}`} onRetry={refreshOverview} />;
  }

  const data = {
    workflows: overview.data?.workflows ?? [],
    activeRuns: overview.data?.activeRuns ?? [],
    recentRuns: overview.data?.recentRuns ?? [],
    projects: overview.data?.projects ?? [],
    labels: overview.data?.labels ?? [],
  };
  const scopedActiveRuns = filterRunsForWorkflows(data.activeRuns, scopedWorkflows);
  const scopedRecentRuns = filterRunsForWorkflows(data.recentRuns, scopedWorkflows);
  const selectedHistoryWorkflow = selectedHistoryWorkflowId
    ? scopedWorkflows.find((workflow) => workflow.id === selectedHistoryWorkflowId) ?? null
    : null;
  const selectedHistoryRuns = selectedHistoryWorkflow
    ? filterRunsForWorkflows(scopedRecentRuns, [selectedHistoryWorkflow])
    : [];
  const historyRuns = runHistoryScope === "selected" && selectedHistoryWorkflow
    ? selectedHistoryRuns
    : scopedRecentRuns;
  const canFilterSelectedHistory = Boolean(selectedHistoryWorkflow);
  const selectedActiveRuns = selectedHistoryWorkflow
    ? filterRunsForWorkflows(scopedActiveRuns, [selectedHistoryWorkflow])
    : [];
  const displayActiveRuns = activeRunsScope === "selected" && selectedHistoryWorkflow
    ? selectedActiveRuns
    : scopedActiveRuns;

  return (
    <div data-plugin-id={PLUGIN_ID} id="wf-page" style={pageStyle}>
      <WorkflowPageHeader
        showHelp={showHelp}
        onToggleHelp={() => setShowHelp(!showHelp)}
        showNewWorkflowForm={showNewWorkflowForm}
        onNewWorkflow={() => { setCreateError(""); setShowNewWorkflowForm(true); }}
        isRefreshing={isRefreshing}
        refreshButtonLabel={refreshButtonLabel}
        onRefresh={refreshOverview}
      />

      <section id="wf-definitions" key="definitions-section" style={{ ...workflowFocusSectionStyle, height: definitionsCollapsed || definitionsHeight === null ? "auto" : `${definitionsHeight}px`, overflow: definitionsHeight === null ? "visible" : "auto", minHeight: definitionsCollapsed ? "auto" : "200px" }}>
        <WorkflowDefinitionsToolbar
          navigatorSearch={navigatorSearch}
          onNavigatorSearchChange={setNavigatorSearch}
          workflowScopeFilter={workflowScopeFilter}
          onWorkflowScopeFilterChange={setWorkflowScopeFilter}
          workflowStatusFilter={workflowStatusFilter}
          onWorkflowStatusFilterChange={setWorkflowStatusFilter}
          reusableCount={reusableWorkflows.length}
          manualCount={manualMissionWorkflows.length}
          activeCount={activeWorkflows.length}
          archivedCount={archivedWorkflows.length}
          definitionsCollapsed={definitionsCollapsed}
          onToggleCollapsed={() => setDefinitionsCollapsed((prev) => !prev)}
        />
        {!definitionsCollapsed && (
          <Fragment key="definitions-body">
        {showNewWorkflowForm ? (
          <WorkflowCreateForm
            companyId={companyId}
            projects={data.projects ?? []}
            toolSystem={toolSystem}
            availableTools={availableTools}
            availableToolGrants={availableToolGrants}
            renderGraphEditor={renderWorkflowGraphEditor}
            onCreated={refreshOverview}
            onCancel={() => setShowNewWorkflowForm(false)}
            onLabelsRefresh={refreshLabels}
          />
        ) : (
          <Fragment key="new-workflow-form-placeholder" />
        )}
        <DefinitionsTable
          key="definitions-table"
          workflows={filteredWorkflows}
          companyId={companyId}
          refreshOverview={refreshOverview}
          projects={data.projects ?? []}
          labels={labels}
          refreshLabels={refreshLabels}
          activeRuns={scopedActiveRuns}
          recentRuns={scopedRecentRuns}
          onManualRunStarted={setHighlightedRunId}
          highlightedRunId={highlightedRunId}
          onAbortRun={handleAbortRun}
          navigatorSearch={navigatorSearch}
          onEditingWorkflowChange={setSelectedHistoryWorkflowId}
          availableTools={availableTools}
          availableToolGrants={availableToolGrants}
        />
          </Fragment>
        )}
      </section>

      <WorkflowDefinitionsResizeHandle
        collapsed={definitionsCollapsed}
        height={definitionsHeight}
        resizeRef={definitionsResizeRef}
        startYRef={definitionsStartY}
        onHeightChange={setDefinitionsHeight}
      />

      <WorkflowRunSections
        activeRunsScope={activeRunsScope}
        runHistoryScope={runHistoryScope}
        onActiveRunsScopeChange={setActiveRunsScope}
        onRunHistoryScopeChange={setRunHistoryScope}
        selectedHistoryWorkflow={selectedHistoryWorkflow}
        scopedActiveRuns={scopedActiveRuns}
        selectedActiveRuns={selectedActiveRuns}
        displayActiveRuns={displayActiveRuns}
        canFilterSelectedHistory={canFilterSelectedHistory}
        scopedRecentRuns={scopedRecentRuns}
        selectedHistoryRuns={selectedHistoryRuns}
        historyRuns={historyRuns}
        companyId={companyId}
        onAbortRun={handleAbortRun}
        onRefreshOverview={refreshOverview}
        highlightedRunId={highlightedRunId}
      />

      {showHelp && <WorkflowHelpOverlay onClose={() => setShowHelp(false)} />}
    </div>
  );
}

export function Workflows(): JSX.Element {
  return <WorkflowPage context={{}} />;
}
