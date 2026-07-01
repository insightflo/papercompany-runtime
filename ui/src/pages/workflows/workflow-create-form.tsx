import { Fragment, useState, type FormEvent, type JSX } from "react";
import type { LabelOption, ProjectOption, StepEditorMode, WorkflowToolGrant, WorkflowToolOption } from "./workflow-page-types.js";
import type { CreateParentIssuePolicy } from "./workflow-parent-policy.js";
import type { StepDraft } from "./step-draft.js";
import { stepsToJson } from "./step-draft.js";
import { buildWorkflowInterfaceMetadata, normalizeMaxDailyRunsInput } from "./workflow-form-utils.js";
import { createCompanyLabel, usePluginAction } from "./workflow-page-api.js";
import { buttonDisabledStyle, buttonStyle, inputStyle, mutedTextStyle, primaryButtonStyle, selectStyle, textareaStyle } from "./workflow-page-styles.js";
import { workflowCreateActionsStyle, workflowCreateFieldStyle, workflowCreateHeaderStyle, workflowCreateIdentityStyle, workflowCreateSetupStripStyle, workflowCreateShellStyle, workflowCreateWorkspaceStyle } from "./workflow-layout-styles.js";
import { FieldLabel, HelpIcon } from "./shared-controls.js";
import { GraphModeTabs, StepWorkspaceEditor, type StepWorkspaceGraphEditorProps } from "./step-workspace-editor.js";

type WorkflowToolSystemState = { available: boolean; reason?: string };

export function WorkflowCreateForm({
  companyId,
  projects,
  toolSystem,
  availableTools,
  availableToolGrants,
  renderGraphEditor,
  onCreated,
  onCancel,
  onLabelsRefresh,
}: {
  companyId: string;
  projects: ProjectOption[];
  toolSystem: WorkflowToolSystemState;
  availableTools: WorkflowToolOption[];
  availableToolGrants: WorkflowToolGrant[];
  renderGraphEditor: (props: StepWorkspaceGraphEditorProps) => JSX.Element;
  onCreated: () => Promise<void> | void;
  onCancel: () => void;
  onLabelsRefresh: () => Promise<LabelOption[]>;
}) {
  const createWorkflow = usePluginAction("create-workflow");
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
    onCancel();
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
      await onCreated();
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
      const nextLabels = await onLabelsRefresh();
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

  return (
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
                    ...(projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>),
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
                  renderGraphEditor={renderGraphEditor}
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
  );
}
