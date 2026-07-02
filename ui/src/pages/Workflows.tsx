import { Fragment, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { jsonToSteps, stepsToJson, type StepDraft } from "./workflows/step-draft.js";
import type { PluginPageProps, LabelOption, StatusFilter, WorkflowScopeFilter } from "./workflows/workflow-page-types.js";
import { pageStyle } from "./workflows/workflow-page-styles.js";
import { fetchCompanyLabels, useAvailableWorkflowTools, useHostContext, usePluginAction, useWorkflowOverview } from "./workflows/workflow-page-api.js";
import { filterRunsForWorkflows, isManualMissionPlanWorkflow } from "./workflows/workflow-filters.js";
import { WorkflowHelpOverlay } from "./workflows/workflow-help-overlay.js";
import { WorkflowDefinitionsResizeHandle } from "./workflows/workflow-definitions-resize-handle.js";
import { WorkflowPageHeader } from "./workflows/workflow-page-header.js";
import { WorkflowDefinitionsToolbar } from "./workflows/workflow-definitions-toolbar.js";
import { WorkflowErrorState, WorkflowLoadingState } from "./workflows/workflow-page-states.js";
import { DefinitionsTable } from "./workflows/workflow-definitions-table.js";
import { WorkflowCreateForm } from "./workflows/workflow-create-form.js";
export { WorkflowDashboardWidget, WorkflowSidebarLink } from "./workflows/workflow-sidebar-and-widget.js";
import { workflowFocusSectionStyle } from "./workflows/workflow-layout-styles.js";
import { WorkflowRunSections, type WorkflowRunHistoryScope } from "./workflows/workflow-run-sections.js";
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
        onNewWorkflow={() => { setShowNewWorkflowForm(true); }}
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
