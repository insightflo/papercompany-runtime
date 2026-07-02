import { Fragment, useEffect, useState, type JSX } from "react";
import { buildManualRunFeedback, findNewRunId, manualRunUnavailableMessage } from "./run-feedback.js";
import type { WorkflowRunDrawerMode } from "./workflow-runs.js";
import { jsonToSteps, stepsToJson, type StepDraft } from "./step-draft.js";
import { applyStepRunsToGraphSteps, buildWorkflowGraphDefinitionNavigator, buildWorkflowGraphRunDebugSummary, type WorkflowGraphNavigatorFilter } from "./workflow-graph.js";
import { normalizeCreateParentIssuePolicy, type CreateParentIssuePolicy } from "./workflow-parent-policy.js";
import type { StepEditorMode, ProjectOption, LabelOption, WorkflowToolOption, WorkflowToolGrant, WorkflowOverviewData, WorkflowRestoreKind, WorkflowRunSummary } from "./workflow-page-types.js";
import { mutedTextStyle, noticeStyle } from "./workflow-page-styles.js";
import { createCompanyLabel, usePluginAction, useWorkflowRunDetail } from "./workflow-page-api.js";
import { filterRunsForWorkflows } from "./workflow-filters.js";
import { WorkflowDefinitionList } from "./workflow-definition-list.js";
import { WorkflowRestoreDialog } from "./workflow-restore-dialog.js";
import { buildWorkflowInterfaceMetadata, formatJsonArrayForForm, normalizeMaxDailyRunsInput } from "./workflow-form-utils.js";
export { WorkflowDashboardWidget, WorkflowSidebarLink } from "./workflow-sidebar-and-widget.js";
import { WorkflowDefinitionEditorShell } from "./workflow-definition-editor-shell.js";
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
        <WorkflowDefinitionEditorShell
          railCollapsed={railCollapsed}
          onRailCollapsedChange={setRailCollapsed}
          visibleItems={navigatorSummary.visibleItems}
          workflows={workflows}
          editingWorkflow={editingWorkflow}
          editingWorkflowPending={editingWorkflowPending}
          editStepMode={editStepMode}
          onActionModeChange={switchEditingStepMode}
          editingName={editingName}
          onEditingNameChange={setEditingName}
          editingDescription={editingDescription}
          onEditingDescriptionChange={setEditingDescription}
          editingStatus={editingStatus}
          onEditingStatusChange={setEditingStatus}
          editingSchedule={editingSchedule}
          onEditingScheduleChange={setEditingSchedule}
          editingTimezone={editingTimezone}
          onEditingTimezoneChange={setEditingTimezone}
          editingProjectId={editingProjectId}
          onEditingProjectIdChange={setEditingProjectId}
          editingMaxDailyRuns={editingMaxDailyRuns}
          onEditingMaxDailyRunsChange={setEditingMaxDailyRuns}
          editingTriggerLabels={editingTriggerLabels}
          onEditingTriggerLabelsChange={setEditingTriggerLabels}
          projects={projects}
          inspectedRunId={inspectedRunId}
          inspectedRunSummary={inspectedRunSummary}
          inspectedRunDetail={inspectedRunDetail}
          runDrawerMode={runDrawerMode}
          onCloseRunOverlay={() => setInspectedRunId(null)}
          onViewRunRow={() => setRunDrawerMode(inspectedRunSummary && editingWorkflowActiveRuns.some((run) => run.id === inspectedRunSummary.id) ? "active" : "recent")}
          editingWorkflowRunDebugSummary={editingWorkflowRunDebugSummary}
          editingSteps={editingSteps}
          onEditingStepsChange={setEditingSteps}
          onWorkspaceModeChange={setEditStepMode}
          editJsonText={editJsonText}
          onEditJsonTextChange={setEditJsonText}
          onJsonError={setTableError}
          runOverlaySteps={runOverlaySteps}
          editingFlowInputsText={editingFlowInputsText}
          editingFlowEnvVariablesText={editingFlowEnvVariablesText}
          editingTestInputPresetsText={editingTestInputPresetsText}
          availableTools={availableTools}
          availableToolGrants={availableToolGrants}
          renderGraphEditor={renderWorkflowGraphEditor}
          onSelectWorkflow={beginEdit}
          onRunWorkflow={(workflow) => { void onRunWorkflow(workflow); }}
          onSaveEdit={(workflowId) => { void onSaveEdit(workflowId); }}
          onCancelEdit={cancelEdit}
          onToggleStatus={(workflow) => { void onToggleStatus(workflow); }}
          onDeleteWorkflow={(workflow) => { void onDeleteWorkflow(workflow); }}
        />
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
