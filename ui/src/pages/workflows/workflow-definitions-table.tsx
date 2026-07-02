import { Fragment, useEffect, useState, type JSX } from "react";
import { buildManualRunFeedback, buildManualRunButtonState, findNewRunId, manualRunUnavailableMessage } from "./run-feedback.js";
import { WorkflowRunDebugStrip, type WorkflowRunDrawerMode } from "./workflow-runs.js";
import { jsonToSteps, stepsToJson, type StepDraft } from "./step-draft.js";
import { applyStepRunsToGraphSteps, buildWorkflowGraphDefinitionNavigator, buildWorkflowGraphRunDebugSummary, summarizeWorkflowGraphTriggers, type WorkflowGraphNavigatorFilter } from "./workflow-graph.js";
import { normalizeCreateParentIssuePolicy, type CreateParentIssuePolicy } from "./workflow-parent-policy.js";
import type { StepEditorMode, ProjectOption, LabelOption, WorkflowToolOption, WorkflowToolGrant, WorkflowOverviewData, WorkflowRestoreKind, WorkflowRunSummary } from "./workflow-page-types.js";
import { buttonDisabledStyle, buttonStyle, dangerButtonStyle, inputStyle, mutedTextStyle, noticeStyle, primaryButtonStyle, selectStyle, textareaStyle } from "./workflow-page-styles.js";
import { createCompanyLabel, usePluginAction, useWorkflowRunDetail } from "./workflow-page-api.js";
import { FieldLabel } from "./shared-controls.js";
import { GraphModeTabs, StepWorkspaceEditor } from "./step-workspace-editor.js";
import { filterRunsForWorkflows } from "./workflow-filters.js";
import { WorkflowDefinitionList } from "./workflow-definition-list.js";
import { WorkflowRestoreDialog } from "./workflow-restore-dialog.js";
import { buildWorkflowInterfaceMetadata, formatJsonArrayForForm, normalizeMaxDailyRunsInput } from "./workflow-form-utils.js";
import { WorkflowRunOverlayBanner } from "./workflow-run-overlay-banner.js";
export { WorkflowDashboardWidget, WorkflowSidebarLink } from "./workflow-sidebar-and-widget.js";
import { workflowCreateFieldStyle, workflowManagementShellStyle, workflowSelectedEditorStyle, workflowSelectedHeaderStyle, workflowSelectedIdentityStyle, workflowSelectedSetupStripStyle, workflowSelectedWorkspaceStyle } from "./workflow-layout-styles.js";
import { WorkflowDefinitionRail } from "./workflow-definition-rail.js";
import { renderWorkflowGraphEditor } from "./graph-editor/WorkflowGraphEditor.js";

export { jsonToSteps, stepsToJson };

export function DefinitionsTable({
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
