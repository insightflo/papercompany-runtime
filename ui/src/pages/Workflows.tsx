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



























function DefinitionsTable({
  workflows,
  companyId,
  refreshOverview,
  projects,
  labels,
  refreshLabels,
  activeRuns,
  recentRuns,
  onManualRunStarted,
  highlightedRunId,
  onAbortRun,
  navigatorSearch,
  onEditingWorkflowChange,
  availableTools,
  availableToolGrants,
}: {
  workflows: WorkflowOverviewData["workflows"];
  companyId: string;
  refreshOverview: () => Promise<void>;
  projects: ProjectOption[];
  labels: LabelOption[];
  refreshLabels: () => Promise<LabelOption[]>;
  activeRuns: WorkflowOverviewData["activeRuns"];
  recentRuns: WorkflowOverviewData["recentRuns"];
  onManualRunStarted: (runId: string | null) => void;
  highlightedRunId: string | null;
  onAbortRun: (runId: string) => void;
  navigatorSearch: string;
  onEditingWorkflowChange?: (workflowId: string | null) => void;
  availableTools: WorkflowToolOption[];
  availableToolGrants: WorkflowToolGrant[];
}): JSX.Element {
  const updateWorkflow = usePluginAction("update-workflow");
  const deleteWorkflow = usePluginAction("delete-workflow");
  const runWorkflow = usePluginAction("start-workflow");
  const [editingWorkflowId, setEditingWorkflowId] = useState<string | null>(null);
  const [railCollapsed, setRailCollapsed] = useState<boolean>(false);
  const [editingName, setEditingName] = useState<string>("");
  const [editingDescription, setEditingDescription] = useState<string>("");
  const [editingStatus, setEditingStatus] = useState<string>("active");
  const [editingTriggerLabels, setEditingTriggerLabels] = useState<string>("");
  const [editingLabelIds, setEditingLabelIds] = useState<string[]>([]);
  const [showNewLabelForm, setShowNewLabelForm] = useState<boolean>(false);
  const [newLabelName, setNewLabelName] = useState<string>("");
  const [newLabelColor, setNewLabelColor] = useState<string>("#6366f1");
  const [creatingLabel, setCreatingLabel] = useState<boolean>(false);
  const [editingSchedule, setEditingSchedule] = useState<string>("");
  const [editingMaxDailyRuns, setEditingMaxDailyRuns] = useState<string>("");
  const [editingTimezone, setEditingTimezone] = useState<string>("Asia/Seoul");
  const [editingProjectId, setEditingProjectId] = useState<string>("");
  const [editingCreateParentIssuePolicy, setEditingCreateParentIssuePolicy] = useState<CreateParentIssuePolicy>("when_multiple_steps");
  const [editingSteps, setEditingSteps] = useState<StepDraft[]>([]);
  const [editStepMode, setEditStepMode] = useState<StepEditorMode>("graph");
  const [editJsonText, setEditJsonText] = useState("");
  const [editingFlowInputsText, setEditingFlowInputsText] = useState("[]");
  const [editingFlowEnvVariablesText, setEditingFlowEnvVariablesText] = useState("[]");
  const [editingTestInputPresetsText, setEditingTestInputPresetsText] = useState("[]");
  const [pendingWorkflowId, setPendingWorkflowId] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<WorkflowOverviewData["workflows"][number] | null>(null);
  const [tableError, setTableError] = useState<string>("");
  const [tableNotice, setTableNotice] = useState<{ tone: "info" | "success"; message: string } | null>(null);
  const [graphShellDismissed, setGraphShellDismissed] = useState<boolean>(false);
  const [runDrawerMode, setRunDrawerMode] = useState<WorkflowRunDrawerMode>("closed");
  const [inspectedRunId, setInspectedRunId] = useState<string | null>(null);
  const navigatorFilter: WorkflowGraphNavigatorFilter = "all";
  const inspectedRunDetail = useWorkflowRunDetail(inspectedRunId);

  function clearTableFeedback(): void {
    setTableError("");
    setTableNotice(null);
  }

  function beginEdit(workflow: WorkflowOverviewData["workflows"][number]): void {
    clearTableFeedback();
    setGraphShellDismissed(false);
    setRunDrawerMode("closed");
    setInspectedRunId(null);
    setEditingWorkflowId(workflow.id);
    onEditingWorkflowChange?.(workflow.id);
    setEditingName(workflow.name);
    setEditingDescription(workflow.description);
    setEditingStatus(workflow.status);
    setEditingTriggerLabels((workflow.triggerLabels ?? []).join(", "));
    setEditingLabelIds(workflow.labelIds ?? []);
    setShowNewLabelForm(false);
    setNewLabelName("");
    setNewLabelColor("#6366f1");
    const rawWorkflow = workflow as Record<string, unknown>;
    const rawSchedule = rawWorkflow.schedule;
    const rawProjectId = rawWorkflow.projectId;
    const rawTimezone = rawWorkflow.timezone;
    const rawMaxDailyRuns = rawWorkflow.maxDailyRuns;
    const rawCreateParentIssuePolicy = rawWorkflow.createParentIssuePolicy;
    setEditingSchedule(typeof rawSchedule === "string" ? rawSchedule : "");
    setEditingProjectId(typeof rawProjectId === "string" ? rawProjectId : "");
    setEditingTimezone(typeof rawTimezone === "string" && rawTimezone.trim() ? rawTimezone : "Asia/Seoul");
    setEditingCreateParentIssuePolicy(normalizeCreateParentIssuePolicy(rawCreateParentIssuePolicy));
    setEditingMaxDailyRuns(
      typeof rawMaxDailyRuns === "number" && Number.isFinite(rawMaxDailyRuns)
        ? String(Math.trunc(rawMaxDailyRuns))
        : "",
    );
    setEditingSteps(jsonToSteps(workflow.steps));
    setEditStepMode("graph");
    setEditJsonText(JSON.stringify(workflow.steps, null, 2));
    setEditingFlowInputsText(formatJsonArrayForForm(workflow.legacyMetadata?.graphFlowInputs));
    setEditingFlowEnvVariablesText(formatJsonArrayForForm(workflow.legacyMetadata?.graphFlowEnvVariables));
    setEditingTestInputPresetsText(formatJsonArrayForForm(workflow.legacyMetadata?.graphTestInputPresets));
  }

  function cancelEdit(): void {
    setGraphShellDismissed(true);
    setEditingWorkflowId(null);
    onEditingWorkflowChange?.(null);
    setEditingName("");
    setEditingDescription("");
    setEditingStatus("active");
    setEditingTriggerLabels("");
    setEditingLabelIds([]);
    setShowNewLabelForm(false);
    setNewLabelName("");
    setNewLabelColor("#6366f1");
    setEditingSchedule("");
    setEditingMaxDailyRuns("");
    setEditingTimezone("Asia/Seoul");
    setEditingProjectId("");
    setEditingCreateParentIssuePolicy("when_multiple_steps");
    setEditingSteps([]);
    setEditStepMode("graph");
    setEditJsonText("");
    setEditingFlowInputsText("[]");
    setEditingFlowEnvVariablesText("[]");
    setEditingTestInputPresetsText("[]");
    setRunDrawerMode("closed");
    setInspectedRunId(null);
    clearTableFeedback();
  }

  useEffect(() => {
    if (editingWorkflowId || workflows.length === 0) return;
    beginEdit(workflows[0]!);
  }, [editingWorkflowId, workflows]);

  useEffect(() => {
    if (editingWorkflowId && !workflows.some((w) => w.id === editingWorkflowId)) {
      setGraphShellDismissed(false);
      setEditingWorkflowId(null);
      onEditingWorkflowChange?.(null);
    }
  }, [editingWorkflowId, onEditingWorkflowChange, workflows]);

  function switchEditingStepMode(nextMode: StepEditorMode): void {
    if (nextMode === editStepMode) return;
    setTableError("");
    if (nextMode === "json") {
      setEditJsonText(JSON.stringify(stepsToJson(editingSteps), null, 2));
      setEditStepMode(nextMode);
      return;
    }
    if (editStepMode === "json") {
      try {
        const parsed = JSON.parse(editJsonText) as unknown;
        if (!Array.isArray(parsed)) {
          setTableError("steps는 JSON 배열이어야 합니다.");
          return;
        }
        setEditingSteps(jsonToSteps(parsed as WorkflowOverviewData["workflows"][number]["steps"]));
      } catch (error) {
        setTableError(`JSON 파싱 실패: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    setEditStepMode(nextMode);
  }

  async function onSaveEdit(workflowId: string): Promise<void> {
    const nextName = editingName.trim();
    if (!nextName) {
      setTableError("name은 필수입니다.");
      return;
    }

    setPendingWorkflowId(workflowId);
    setTableError("");
    try {
      const parsedMaxDailyRuns = normalizeMaxDailyRunsInput(editingMaxDailyRuns);
      if (parsedMaxDailyRuns.error) {
        setTableError(parsedMaxDailyRuns.error);
        return;
      }
      const triggerLabels = editingTriggerLabels.split(",").map((l) => l.trim()).filter(Boolean);
      const labelIds = editingLabelIds.map((l) => l.trim()).filter(Boolean);
      let steps: unknown[];
      if (editStepMode === "json") {
        try {
          steps = JSON.parse(editJsonText);
          if (!Array.isArray(steps)) { setTableError("steps는 JSON 배열이어야 합니다."); return; }
        } catch (e) { setTableError(`JSON 파싱 실패: ${e instanceof Error ? e.message : String(e)}`); return; }
      } else {
        steps = stepsToJson(editingSteps);
      }
      const legacyMetadata = buildWorkflowInterfaceMetadata(
        workflows.find((workflow) => workflow.id === workflowId)?.legacyMetadata,
        editingFlowInputsText,
        editingFlowEnvVariablesText,
        editingTestInputPresetsText,
      );
      if (legacyMetadata.error) {
        setTableError(legacyMetadata.error);
        return;
      }
      const patch = {
        name: nextName,
        description: editingDescription.trim(),
        status: editingStatus.trim() || "active",
        triggerLabels,
        labelIds,
        steps,
        schedule: editingSchedule.trim(),
        maxDailyRuns: parsedMaxDailyRuns.value,
        timezone: editingTimezone.trim(),
        projectId: editingProjectId.trim(),
        createParentIssuePolicy: editingCreateParentIssuePolicy,
        legacyMetadata: legacyMetadata.value,
      };
      const updated = await updateWorkflow({
        companyId,
        workflowId,
        id: workflowId,
        patch,
        ...patch,
      });
      const updatedRecord = updated && typeof updated === "object" ? updated as Record<string, unknown> : {};
      const updatedWorkflow = (updatedRecord.workflow && typeof updatedRecord.workflow === "object"
        ? updatedRecord.workflow
        : updatedRecord) as WorkflowOverviewData["workflows"][number] | null;
      if (updatedWorkflow?.id) {
        beginEdit(updatedWorkflow);
      }
      await refreshOverview();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTableError(`수정 실패: ${message}`);
    } finally {
      setPendingWorkflowId(null);
    }
  }

  async function onCreateLabelForEditForm(): Promise<void> {
    const name = newLabelName.trim();
    if (!name) {
      setTableError("새 레이블 이름을 입력하세요.");
      return;
    }
    if (!companyId.trim()) {
      setTableError("companyId가 없어 레이블을 생성할 수 없습니다.");
      return;
    }

    setTableError("");
    setCreatingLabel(true);
    try {
      const created = await createCompanyLabel(companyId, name, newLabelColor);
      const nextLabels = await refreshLabels();
      const createdId = nextLabels.find((label) => label.id === created.id)?.id ?? created.id;
      setEditingLabelIds((prev) => (prev.includes(createdId) ? prev : [...prev, createdId]));
      setNewLabelName("");
      setNewLabelColor("#6366f1");
      setShowNewLabelForm(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTableError(`레이블 생성 실패: ${message}`);
    } finally {
      setCreatingLabel(false);
    }
  }

  async function onDeleteWorkflow(workflow: WorkflowOverviewData["workflows"][number]): Promise<void> {
    const accepted = typeof window !== "undefined"
      ? window.confirm(`"${workflow.name}" 워크플로를 보관할까요?`)
      : true;
    if (!accepted) {
      return;
    }

    setPendingWorkflowId(workflow.id);
    setTableError("");
    try {
      await deleteWorkflow({
        companyId,
        workflowId: workflow.id,
        id: workflow.id,
        status: "archived",
      });
      if (editingWorkflowId === workflow.id) {
        cancelEdit();
      }
      await refreshOverview();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTableError(`삭제 실패: ${message}`);
    } finally {
      setPendingWorkflowId(null);
    }
  }

  async function onToggleStatus(workflow: WorkflowOverviewData["workflows"][number]): Promise<void> {
    const normalized = workflow.status.trim().toLowerCase();
    if (normalized !== "active" && normalized !== "paused") {
      return;
    }

    const nextStatus = normalized === "active" ? "paused" : "active";
    setPendingWorkflowId(workflow.id);
    setTableError("");
    try {
      await updateWorkflow({
        companyId,
        workflowId: workflow.id,
        id: workflow.id,
        patch: { status: nextStatus },
        status: nextStatus,
      });
      await refreshOverview();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTableError(`status 변경 실패: ${message}`);
    } finally {
      setPendingWorkflowId(null);
    }
  }

  async function onRunWorkflow(workflow: WorkflowOverviewData["workflows"][number]): Promise<void> {
    const normalizedStatus = workflow.status.trim().toLowerCase();
    if (normalizedStatus !== "active") {
      setTableError("");
      setTableNotice({ tone: "info", message: manualRunUnavailableMessage(normalizedStatus) });
      onManualRunStarted(null);
      return;
    }

    const beforeRunIds = new Set([...activeRuns, ...recentRuns].map((run) => run.id));
    setPendingWorkflowId(workflow.id);
    clearTableFeedback();
    try {
      const result = await runWorkflow({ companyId, workflowId: workflow.id }) as Record<string, unknown> | null | undefined;
      const runId = typeof result?.runId === "string" ? result.runId : typeof result?.id === "string" ? result.id : null;
      const highlightedRunId = findNewRunId(beforeRunIds, runId, activeRuns, recentRuns);
      onManualRunStarted(highlightedRunId);
      setTableNotice({
        tone: "success",
        message: buildManualRunFeedback(workflow.name, {
          id: typeof result?.id === "string" ? result.id : undefined,
          runId: runId ?? undefined,
          parentIssueId: typeof result?.parentIssueId === "string" ? result.parentIssueId : undefined,
          parentIssueIdentifier: typeof result?.parentIssueIdentifier === "string" ? result.parentIssueIdentifier : undefined,
        }),
      });
      await refreshOverview();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onManualRunStarted(null);
      setTableError(`Run 실패: ${message}`);
    } finally {
      setPendingWorkflowId(null);
    }
  }

  async function onRestoreWorkflow(workflow: WorkflowOverviewData["workflows"][number], kind: WorkflowRestoreKind): Promise<void> {
    setPendingWorkflowId(workflow.id);
    setTableError("");
    try {
      // 복원 종류에 따라 source/sourceKind 도 갱신. shared PATCH schema 가 source/sourceKind 를
      // 허용하고 workflow-store update 가 patch 를 통과시킨다.
      const sourcePatch = kind === "manual"
        ? { source: "manual_mission", sourceKind: "manual_mission" }
        : { source: "native", sourceKind: "workflow" };
      await updateWorkflow({
        companyId,
        workflowId: workflow.id,
        id: workflow.id,
        patch: { status: "active", ...sourcePatch },
        status: "active",
        ...sourcePatch,
      });
      await refreshOverview();
      setTableNotice({ tone: "success", message: `${workflow.name} 복원 완료 (${kind === "manual" ? "Manual mission plan" : "Reusable procedure"})` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTableError(`복원 실패: ${message}`);
    } finally {
      setPendingWorkflowId(null);
    }
  }

  function confirmRestoreWorkflow(kind: WorkflowRestoreKind): void {
    const target = restoreTarget;
    if (!target) return;
    setRestoreTarget(null);
    void onRestoreWorkflow(target, kind);
  }

  if (workflows.length === 0) {
    return <p style={mutedTextStyle}>No workflows defined yet.</p>;
  }

  const editingWorkflow = workflows.find((workflow) => workflow.id === editingWorkflowId) ?? null;
  const editingWorkflowPending = editingWorkflow ? pendingWorkflowId === editingWorkflow.id : false;
  const editingWorkflowActiveRuns = editingWorkflow ? filterRunsForWorkflows(activeRuns, [editingWorkflow]) : [];
  const editingWorkflowRecentRuns = editingWorkflow ? filterRunsForWorkflows(recentRuns, [editingWorkflow]) : [];
  const inspectedRunSummary: WorkflowRunSummary | null = inspectedRunId
    ? [...editingWorkflowActiveRuns, ...editingWorkflowRecentRuns].find((run) => run.id === inspectedRunId) ?? null
    : null;
  const runOverlaySteps = inspectedRunId && inspectedRunDetail.data?.stepRuns
    ? applyStepRunsToGraphSteps(editingSteps, inspectedRunDetail.data.stepRuns)
    : undefined;
  const editingWorkflowRunDebugSummary = inspectedRunId ? buildWorkflowGraphRunDebugSummary({
    steps: editingSteps,
    stepRuns: inspectedRunDetail.data?.stepRuns ?? [],
    selectedStepId: editingSteps[0]?.id ?? "",
  }) : null;
  const navigatorSummary = buildWorkflowGraphDefinitionNavigator({
    workflows,
    activeRuns,
    recentRuns,
    search: navigatorSearch,
    filter: navigatorFilter,
  });

    return (
      <div style={{ display: "grid", gap: "8px" }}>
        {tableError ? <p key="table-error" style={noticeStyle("error")}>{tableError}</p> : null}
        {tableNotice ? <p key="table-notice" style={noticeStyle(tableNotice.tone)}>{tableNotice.message}</p> : null}
            {restoreTarget ? (
              <WorkflowRestoreDialog
                workflow={restoreTarget}
                onCancel={() => setRestoreTarget(null)}
                onConfirm={confirmRestoreWorkflow}
              />
            ) : null}
        {editingWorkflow ? (
        <div id="wf-editor" key="selected-workflow-shell" style={{ ...workflowManagementShellStyle, gridTemplateColumns: railCollapsed ? "36px minmax(640px, 1fr)" : "280px minmax(640px, 1fr)" }}>
          <WorkflowDefinitionRail
            collapsed={railCollapsed}
            onCollapsedChange={setRailCollapsed}
            visibleItems={navigatorSummary.visibleItems}
            workflows={workflows}
            selectedWorkflowId={editingWorkflow?.id ?? ""}
            onSelectWorkflow={beginEdit}
          />
          <div key="selected-workflow-editor" style={workflowSelectedEditorStyle}>
            <div key="selected-workflow-header" style={{ ...workflowSelectedHeaderStyle, gridTemplateColumns: "1fr" }}>
              <div key="action-bar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <GraphModeTabs mode={editStepMode} onChange={switchEditingStepMode} />
                <div key="action-buttons" style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    style={editingWorkflowPending ? { ...primaryButtonStyle, ...buttonDisabledStyle } : primaryButtonStyle}
                    disabled={editingWorkflowPending || buildManualRunButtonState(editingWorkflow.status.trim().toLowerCase()).disabled}
                    onClick={() => { void onRunWorkflow(editingWorkflow); }}
                  >
                    {editingWorkflowPending ? "Running..." : "Run"}
                  </button>
                  <button
                    type="button"
                    style={editingWorkflowPending ? { ...primaryButtonStyle, ...buttonDisabledStyle } : primaryButtonStyle}
                    disabled={editingWorkflowPending}
                    onClick={() => { void onSaveEdit(editingWorkflow.id); }}
                  >
                    Save
                  </button>
                  <button type="button" style={buttonStyle} onClick={cancelEdit}>Close</button>
                  <button
                    type="button"
                    style={editingWorkflowPending ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
                    disabled={editingWorkflowPending || !["active", "paused"].includes(editingWorkflow.status.trim().toLowerCase())}
                    onClick={() => { void onToggleStatus(editingWorkflow); }}
                  >
                    {editingWorkflow.status.trim().toLowerCase() === "active" ? "Pause" : "Activate"}
                  </button>
                  <button
                    type="button"
                    style={editingWorkflowPending ? { ...dangerButtonStyle, ...buttonDisabledStyle } : dangerButtonStyle}
                    disabled={editingWorkflowPending}
                    onClick={() => { void onDeleteWorkflow(editingWorkflow); }}
                  >
                    보관
                  </button>
                </div>
              </div>
              <div key="workflow-main" style={workflowSelectedIdentityStyle}>
                <div key="name-field" style={workflowCreateFieldStyle}>
                  <FieldLabel help="Name shown in workflow lists, run history, and generated run labels.">Workflow name</FieldLabel>
                  <input style={inputStyle} value={editingName} onChange={(event) => setEditingName(event.target.value)} required />
                </div>
                <div key="description-field" style={workflowCreateFieldStyle}>
                  <FieldLabel help="Short operator-facing summary of what this workflow does.">Description</FieldLabel>
                  <textarea
                    style={{ ...textareaStyle, minHeight: "38px" }}
                    value={editingDescription}
                    onChange={(event) => setEditingDescription(event.target.value)}
                    rows={2}
                  />
                </div>
              </div>
              <div key="workflow-setup-strip" style={workflowSelectedSetupStripStyle}>
                <div key="status-field" style={workflowCreateFieldStyle}>
                  <FieldLabel help="Workflow availability. Active can run, paused stays saved, archived is hidden from active operation.">Status</FieldLabel>
                  <select style={selectStyle} value={editingStatus} onChange={(event) => setEditingStatus(event.target.value)}>
                    <option value="active">active</option>
                    <option value="paused">paused</option>
                    <option value="archived">archived</option>
                  </select>
                </div>
                <div key="schedule-field" style={workflowCreateFieldStyle}>
                  <FieldLabel help="Cron expression for scheduled runs. Leave blank for manual or label-triggered runs only.">Schedule (cron)</FieldLabel>
                  <input style={inputStyle} value={editingSchedule} onChange={(event) => setEditingSchedule(event.target.value)} placeholder="0 9 * * *" />
                </div>
                <div key="timezone-field" style={workflowCreateFieldStyle}>
                  <FieldLabel help="Timezone used to interpret the cron schedule.">Timezone</FieldLabel>
                  <input style={inputStyle} value={editingTimezone} onChange={(event) => setEditingTimezone(event.target.value)} placeholder="Asia/Seoul" />
                </div>
                <div key="project-field" style={workflowCreateFieldStyle}>
                  <FieldLabel help="Optional project that generated issues and runs should be associated with.">Project</FieldLabel>
                  <select style={selectStyle} value={editingProjectId} onChange={(event) => setEditingProjectId(event.target.value)}>
                    <option value="">— none —</option>
                    {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </select>
                </div>
                <div key="max-daily-runs-field" style={workflowCreateFieldStyle}>
                  <FieldLabel help="Daily run cap for scheduled or label-triggered execution. Blank uses the default limit.">Max Daily Runs</FieldLabel>
                  <input style={inputStyle} type="number" min={0} step={1} value={editingMaxDailyRuns} onChange={(event) => setEditingMaxDailyRuns(event.target.value)} placeholder="blank=1/day" />
                </div>
                <div key="trigger-labels-field" style={workflowCreateFieldStyle}>
                  <FieldLabel help="Comma-separated issue labels that can trigger this workflow.">Trigger Labels</FieldLabel>
                  <input style={inputStyle} value={editingTriggerLabels} onChange={(event) => setEditingTriggerLabels(event.target.value)} placeholder="daily-tech-research" />
                </div>
              </div>
              <WorkflowRunOverlayBanner
                runId={inspectedRunId}
                runSummary={inspectedRunSummary}
                runDetail={inspectedRunDetail}
                drawerMode={runDrawerMode}
                onCloseOverlay={() => setInspectedRunId(null)}
                onViewRunRow={() => setRunDrawerMode(inspectedRunSummary && editingWorkflowActiveRuns.some((run) => run.id === inspectedRunSummary.id) ? "active" : "recent")}
              />
              {editingWorkflowRunDebugSummary ? (
                <WorkflowRunDebugStrip key="run-debug" summary={editingWorkflowRunDebugSummary} />
              ) : (
                <Fragment key="run-debug-placeholder" />
              )}
            </div>
            <div key="selected-step-workspace" style={workflowSelectedWorkspaceStyle}>
              <StepWorkspaceEditor
                  renderGraphEditor={renderWorkflowGraphEditor}
                steps={editingSteps}
                baseSteps={jsonToSteps(editingWorkflow.steps)}
                onChange={setEditingSteps}
                mode={editStepMode}
                onModeChange={setEditStepMode}
                jsonText={editJsonText}
                onJsonTextChange={setEditJsonText}
                onJsonError={setTableError}
                runOverlaySteps={runOverlaySteps}
                triggerSummary={summarizeWorkflowGraphTriggers({
                  schedule: editingSchedule,
                  timezone: editingTimezone,
                  triggerLabels: editingTriggerLabels,
                  lastScheduledRunAt: editingWorkflow.lastScheduledRunAt,
                  lastScheduleError: editingWorkflow.lastScheduleError,
                  lastScheduleErrorAt: editingWorkflow.lastScheduleErrorAt,
                })}
                testInterfaceInput={{
                  graphFlowInputs: editingFlowInputsText,
                  graphFlowEnvVariables: editingFlowEnvVariablesText,
                  graphTestInputPresets: editingTestInputPresetsText,
                }}
                availableTools={availableTools}
                availableToolGrants={availableToolGrants}
                surface="focus"
              />
            </div>
          </div>
        </div>
      ) : (
        <Fragment key="selected-workflow-shell-placeholder" />
      )}
      {editingWorkflow ? (
        <Fragment key="definitions-table-hidden-while-editing" />
      ) : (
        <WorkflowDefinitionList
          key="definitions-flow-list"
          workflows={workflows}
          activeRuns={activeRuns}
          recentRuns={recentRuns}
          pendingWorkflowId={pendingWorkflowId}
          editingWorkflowId={editingWorkflowId}
          onOpenGraph={beginEdit}
          onRunWorkflow={(workflow) => { void onRunWorkflow(workflow); }}
          onRestoreWorkflow={(workflow) => setRestoreTarget(workflow)}
          onDeleteWorkflow={(workflow) => { void onDeleteWorkflow(workflow); }}
          onToggleStatus={(workflow) => { void onToggleStatus(workflow); }}
        />
      )}
    </div>
  );
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
  const [showNewWorkflowForm, setShowNewWorkflowForm] = useState(false);
  const [definitionsCollapsed, setDefinitionsCollapsed] = useState(false);
  const [definitionsHeight, setDefinitionsHeight] = useState<number | null>(null);
  const definitionsResizeRef = useRef<number>(0);
  const definitionsStartY = useRef<number>(0);
  const [newWorkflowName, setNewWorkflowName] = useState("");
  const [newWorkflowDescription, setNewWorkflowDescription] = useState("");
  const [newWorkflowSteps, setNewWorkflowSteps] = useState<StepDraft[]>([]);
  const [newStepMode, setNewStepMode] = useState<StepEditorMode>("graph");
  const [newJsonText, setNewJsonText] = useState("[]");
  const [newFlowInputsText, setNewFlowInputsText] = useState("[]");
  const [newFlowEnvVariablesText, setNewFlowEnvVariablesText] = useState("[]");
  const [newTestInputPresetsText, setNewTestInputPresetsText] = useState("[]");
  const [newTriggerLabels, setNewTriggerLabels] = useState("");
  const [newLabelIds, setNewLabelIds] = useState<string[]>([]);
  const [showNewLabelForm, setShowNewLabelForm] = useState<boolean>(false);
  const [newLabelName, setNewLabelName] = useState<string>("");
  const [newLabelColor, setNewLabelColor] = useState<string>("#6366f1");
  const [creatingLabel, setCreatingLabel] = useState<boolean>(false);
  const [newSchedule, setNewSchedule] = useState("");
  const [newMaxDailyRuns, setNewMaxDailyRuns] = useState("");
  const [newTimezone, setNewTimezone] = useState("Asia/Seoul");
  const [newProjectId, setNewProjectId] = useState("");
  const [newCreateParentIssuePolicy, setNewCreateParentIssuePolicy] = useState<CreateParentIssuePolicy>("when_multiple_steps");
  const [createError, setCreateError] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
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

  function resetCreateForm(): void {
    setNewWorkflowName("");
    setNewWorkflowDescription("");
    setNewWorkflowSteps([]);
    setNewStepMode("graph");
    setNewJsonText("[]");
    setNewFlowInputsText("[]");
    setNewFlowEnvVariablesText("[]");
    setNewTestInputPresetsText("[]");
    setNewTriggerLabels("");
    setNewLabelIds([]);
    setShowNewLabelForm(false);
    setNewLabelName("");
    setNewLabelColor("#6366f1");
    setNewSchedule("");
    setNewMaxDailyRuns("");
    setNewTimezone("Asia/Seoul");
    setNewProjectId("");
    setNewCreateParentIssuePolicy("when_multiple_steps");
    setCreateError("");
    setShowNewWorkflowForm(false);
  }

  async function onCreateWorkflow(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const name = newWorkflowName.trim();
    if (!name) {
      setCreateError("name은 필수입니다.");
      return;
    }

    let parsedSteps: unknown[];
    if (newStepMode === "json") {
      try {
        parsedSteps = JSON.parse(newJsonText);
        if (!Array.isArray(parsedSteps)) { setCreateError("steps는 JSON 배열이어야 합니다."); return; }
      } catch (e) { setCreateError(`JSON 파싱 실패: ${e instanceof Error ? e.message : String(e)}`); return; }
    } else {
      parsedSteps = stepsToJson(newWorkflowSteps);
    }
    const invalidStep = parsedSteps.find((s) => !(s as Record<string, unknown>).id);
    if (invalidStep) {
      setCreateError("모든 step에 ID가 필요합니다.");
      return;
    }

    setCreateError("");
    setIsCreating(true);
    try {
      const parsedMaxDailyRuns = normalizeMaxDailyRunsInput(newMaxDailyRuns);
      if (parsedMaxDailyRuns.error) {
        setCreateError(parsedMaxDailyRuns.error);
        return;
      }
      const description = newWorkflowDescription.trim();
      const triggerLabels = newTriggerLabels.split(",").map((l) => l.trim()).filter(Boolean);
      const labelIds = newLabelIds.map((l) => l.trim()).filter(Boolean);
      const legacyMetadata = buildWorkflowInterfaceMetadata({}, newFlowInputsText, newFlowEnvVariablesText, newTestInputPresetsText);
      if (legacyMetadata.error) {
        setCreateError(legacyMetadata.error);
        return;
      }
      const workflow = {
        name,
        description,
        status: "active",
        steps: parsedSteps,
        maxDailyRuns: parsedMaxDailyRuns.value,
        timezone: newTimezone.trim() || undefined,
        createParentIssuePolicy: newCreateParentIssuePolicy,
        legacyMetadata: legacyMetadata.value,
        ...(triggerLabels.length > 0 ? { triggerLabels } : {}),
        ...(labelIds.length > 0 ? { labelIds } : {}),
        ...(newSchedule.trim() ? { schedule: newSchedule.trim() } : {}),
        ...(newProjectId.trim() ? { projectId: newProjectId.trim() } : {}),
      };
      await createWorkflow({
        companyId,
        workflow,
        ...workflow,
      });
      resetCreateForm();
      await refreshOverview();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCreateError(`생성 실패: ${message}`);
    } finally {
      setIsCreating(false);
    }
  }

  async function onCreateLabelForCreateForm(): Promise<void> {
    const name = newLabelName.trim();
    if (!name) {
      setCreateError("새 레이블 이름을 입력하세요.");
      return;
    }
    if (!companyId.trim()) {
      setCreateError("companyId가 없어 레이블을 생성할 수 없습니다.");
      return;
    }

    setCreateError("");
    setCreatingLabel(true);
    try {
      const created = await createCompanyLabel(companyId, name, newLabelColor);
      const nextLabels = await refreshLabels();
      const createdId = nextLabels.find((label) => label.id === created.id)?.id ?? created.id;
      setNewLabelIds((prev) => (prev.includes(createdId) ? prev : [...prev, createdId]));
      setNewLabelName("");
      setNewLabelColor("#6366f1");
      setShowNewLabelForm(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCreateError(`레이블 생성 실패: ${message}`);
    } finally {
      setCreatingLabel(false);
    }
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
          <form key="new-workflow-form" style={workflowCreateShellStyle} onSubmit={(event) => void onCreateWorkflow(event)}>
            <div key="create-header" style={workflowCreateHeaderStyle}>
              <div key="identity" style={workflowCreateIdentityStyle}>
                <div key="name-field" style={workflowCreateFieldStyle}>
                  <FieldLabel help="Name shown in lists, editor headers, and run history.">Workflow name</FieldLabel>
                  <input
                    key="input"
                    style={inputStyle}
                    value={newWorkflowName}
                    onChange={(event) => setNewWorkflowName(event.target.value)}
                    placeholder="Daily market signal digest"
                    required
                  />
                </div>
                <div key="description-field" style={workflowCreateFieldStyle}>
                  <FieldLabel help="Short summary of what this workflow is intended to automate.">Description</FieldLabel>
                  <textarea
                    key="textarea"
                    style={{ ...textareaStyle, minHeight: "38px" }}
                    value={newWorkflowDescription}
                    onChange={(event) => setNewWorkflowDescription(event.target.value)}
                    rows={2}
                    placeholder="What this workflow does"
                  />
                </div>
              </div>
              <div key="create-actions" style={workflowCreateActionsStyle}>
                <GraphModeTabs key="mode-tabs" mode={newStepMode} onChange={setNewStepMode} />
                <button
                  type="submit"
                  style={isCreating ? { ...primaryButtonStyle, ...buttonDisabledStyle } : primaryButtonStyle}
                  disabled={isCreating}
                >
                  Save
                </button>
                <button
                  type="button"
                  style={isCreating ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
                  disabled={isCreating}
                  onClick={resetCreateForm}
                >
                  Cancel
                </button>
                <HelpIcon label="Save creates the workflow. Cancel clears this draft. Mode tabs choose graph, form, or raw JSON step editing." />
              </div>
            </div>

            <div key="create-setup-strip" style={workflowCreateSetupStripStyle}>
              <div key="schedule-field" style={workflowCreateFieldStyle}>
                <FieldLabel help="Cron expression for automatic scheduled runs. Leave blank if this workflow is only manual or label-triggered.">Schedule (cron)</FieldLabel>
                <input key="input" style={inputStyle} value={newSchedule} onChange={(e) => setNewSchedule(e.target.value)} placeholder="0 9 * * *" />
              </div>
              <div key="timezone-field" style={workflowCreateFieldStyle}>
                <FieldLabel help="Timezone used to interpret the cron schedule.">Timezone</FieldLabel>
                <input key="input" style={inputStyle} value={newTimezone} onChange={(e) => setNewTimezone(e.target.value)} placeholder="Asia/Seoul" />
              </div>
              <div key="project-field" style={workflowCreateFieldStyle}>
                <FieldLabel help="Optional project to attach generated issues and runs to.">Project</FieldLabel>
                <select key="select" style={selectStyle} value={newProjectId} onChange={(e) => setNewProjectId(e.target.value)}>
                  {[
                    <option key="none" value="">— none —</option>,
                    ...(data.projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>),
                  ]}
                </select>
              </div>
              <div key="max-daily-runs-field" style={workflowCreateFieldStyle}>
                <FieldLabel help="Daily execution cap for this workflow. Blank uses the server default.">Max Daily Runs</FieldLabel>
                <input key="input" style={inputStyle} type="number" min={0} step={1} value={newMaxDailyRuns} onChange={(e) => setNewMaxDailyRuns(e.target.value)} placeholder="blank=1/day" />
              </div>
              <div key="trigger-labels-field" style={workflowCreateFieldStyle}>
                <FieldLabel help="Comma-separated issue labels that should trigger this workflow.">Trigger labels</FieldLabel>
                <input
                  key="input"
                  style={inputStyle}
                  value={newTriggerLabels}
                  onChange={(event) => setNewTriggerLabels(event.target.value)}
                  placeholder="daily-tech-research"
                />
              </div>
            </div>

            {!toolSystem.available ? (
              <p key="tool-system-unavailable" style={{ ...mutedTextStyle, padding: "0 12px", fontSize: "12px" }}>
                Workflow tools inactive: {toolSystem.reason ?? "no workflow tools are available."}
              </p>
            ) : (
              <Fragment key="tool-system-available-placeholder" />
            )}

            <div key="create-workspace" style={workflowCreateWorkspaceStyle}>
              <StepWorkspaceEditor
                  renderGraphEditor={renderWorkflowGraphEditor}
                key="steps-editor"
                steps={newWorkflowSteps}
                onChange={setNewWorkflowSteps}
                mode={newStepMode}
                onModeChange={setNewStepMode}
                jsonText={newJsonText}
                onJsonTextChange={setNewJsonText}
                onJsonError={setCreateError}
                triggerSummary={summarizeWorkflowGraphTriggers({
                  schedule: newSchedule,
                  timezone: newTimezone,
                  triggerLabels: newTriggerLabels,
                })}
                testInterfaceInput={{
                  graphFlowInputs: newFlowInputsText,
                  graphFlowEnvVariables: newFlowEnvVariablesText,
                  graphTestInputPresets: newTestInputPresetsText,
                }}
                availableTools={availableTools}
                availableToolGrants={availableToolGrants}
                surface={newStepMode === "graph" ? "focus" : "stacked"}
              />
            </div>

            {createError ? <p key="create-error" style={{ ...mutedTextStyle, padding: "0 12px 12px" }}>{createError}</p> : <Fragment key="create-error-placeholder" />}
          </form>
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
