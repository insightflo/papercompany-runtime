import { Fragment, type JSX } from "react";
import { buildManualRunButtonState } from "./run-feedback.js";
import { WorkflowRunDebugStrip, type WorkflowRunDrawerMode } from "./workflow-runs.js";
import { jsonToSteps, type StepDraft } from "./step-draft.js";
import type {
  ProjectOption,
  StepEditorMode,
  WorkflowOverviewData,
  WorkflowRunSummary,
  WorkflowToolGrant,
  WorkflowToolOption,
} from "./workflow-page-types.js";
import {
  buttonDisabledStyle,
  buttonStyle,
  dangerButtonStyle,
  inputStyle,
  primaryButtonStyle,
  selectStyle,
  textareaStyle,
} from "./workflow-page-styles.js";
import { FieldLabel } from "./shared-controls.js";
import { GraphModeTabs, StepWorkspaceEditor, type StepWorkspaceGraphEditorProps } from "./step-workspace-editor.js";
import { summarizeWorkflowGraphTriggers, type WorkflowGraphDefinitionNavigatorItem, type WorkflowGraphRunDebugSummary } from "./workflow-graph.js";
import { WorkflowRunOverlayBanner } from "./workflow-run-overlay-banner.js";
import {
  workflowCreateFieldStyle,
  workflowManagementShellStyle,
  workflowSelectedEditorStyle,
  workflowSelectedHeaderStyle,
  workflowSelectedIdentityStyle,
  workflowSelectedSetupStripStyle,
  workflowSelectedWorkspaceStyle,
} from "./workflow-layout-styles.js";
import { WorkflowDefinitionRail } from "./workflow-definition-rail.js";

type WorkflowRunOverlayBannerProps = Parameters<typeof WorkflowRunOverlayBanner>[0];

export function WorkflowDefinitionEditorShell({
  railCollapsed,
  onRailCollapsedChange,
  visibleItems,
  workflows,
  editingWorkflow,
  editingWorkflowPending,
  editStepMode,
  onActionModeChange,
  editingName,
  onEditingNameChange,
  editingDescription,
  onEditingDescriptionChange,
  editingStatus,
  onEditingStatusChange,
  editingSchedule,
  onEditingScheduleChange,
  editingTimezone,
  onEditingTimezoneChange,
  editingProjectId,
  onEditingProjectIdChange,
  editingMaxDailyRuns,
  onEditingMaxDailyRunsChange,
  editingTriggerLabels,
  onEditingTriggerLabelsChange,
  projects,
  inspectedRunId,
  inspectedRunSummary,
  inspectedRunDetail,
  runDrawerMode,
  onCloseRunOverlay,
  onViewRunRow,
  editingWorkflowRunDebugSummary,
  editingSteps,
  onEditingStepsChange,
  onWorkspaceModeChange,
  editJsonText,
  onEditJsonTextChange,
  onJsonError,
  runOverlaySteps,
  editingFlowInputsText,
  editingFlowEnvVariablesText,
  editingTestInputPresetsText,
  availableTools,
  availableToolGrants,
  renderGraphEditor,
  onSelectWorkflow,
  onRunWorkflow,
  onSaveEdit,
  onCancelEdit,
  onToggleStatus,
  onDeleteWorkflow,
}: {
  railCollapsed: boolean;
  onRailCollapsedChange: (collapsed: boolean) => void;
  visibleItems: WorkflowGraphDefinitionNavigatorItem[];
  workflows: WorkflowOverviewData["workflows"];
  editingWorkflow: WorkflowOverviewData["workflows"][number];
  editingWorkflowPending: boolean;
  editStepMode: StepEditorMode;
  onActionModeChange: (mode: StepEditorMode) => void;
  editingName: string;
  onEditingNameChange: (value: string) => void;
  editingDescription: string;
  onEditingDescriptionChange: (value: string) => void;
  editingStatus: string;
  onEditingStatusChange: (value: string) => void;
  editingSchedule: string;
  onEditingScheduleChange: (value: string) => void;
  editingTimezone: string;
  onEditingTimezoneChange: (value: string) => void;
  editingProjectId: string;
  onEditingProjectIdChange: (value: string) => void;
  editingMaxDailyRuns: string;
  onEditingMaxDailyRunsChange: (value: string) => void;
  editingTriggerLabels: string;
  onEditingTriggerLabelsChange: (value: string) => void;
  projects: ProjectOption[];
  inspectedRunId: string | null;
  inspectedRunSummary: WorkflowRunSummary | null;
  inspectedRunDetail: WorkflowRunOverlayBannerProps["runDetail"];
  runDrawerMode: WorkflowRunDrawerMode;
  onCloseRunOverlay: () => void;
  onViewRunRow: () => void;
  editingWorkflowRunDebugSummary: WorkflowGraphRunDebugSummary | null;
  editingSteps: StepDraft[];
  onEditingStepsChange: (steps: StepDraft[]) => void;
  onWorkspaceModeChange: (mode: StepEditorMode) => void;
  editJsonText: string;
  onEditJsonTextChange: (value: string) => void;
  onJsonError: (message: string) => void;
  runOverlaySteps: StepDraft[] | undefined;
  editingFlowInputsText: string;
  editingFlowEnvVariablesText: string;
  editingTestInputPresetsText: string;
  availableTools: WorkflowToolOption[];
  availableToolGrants: WorkflowToolGrant[];
  renderGraphEditor: (props: StepWorkspaceGraphEditorProps) => JSX.Element;
  onSelectWorkflow: (workflow: WorkflowOverviewData["workflows"][number]) => void;
  onRunWorkflow: (workflow: WorkflowOverviewData["workflows"][number]) => void;
  onSaveEdit: (workflowId: string) => void;
  onCancelEdit: () => void;
  onToggleStatus: (workflow: WorkflowOverviewData["workflows"][number]) => void;
  onDeleteWorkflow: (workflow: WorkflowOverviewData["workflows"][number]) => void;
}): JSX.Element {
  return (
    <div id="wf-editor" key="selected-workflow-shell" style={{ ...workflowManagementShellStyle, gridTemplateColumns: railCollapsed ? "36px minmax(640px, 1fr)" : "280px minmax(640px, 1fr)" }}>
      <WorkflowDefinitionRail
        collapsed={railCollapsed}
        onCollapsedChange={onRailCollapsedChange}
        visibleItems={visibleItems}
        workflows={workflows}
        selectedWorkflowId={editingWorkflow.id}
        onSelectWorkflow={onSelectWorkflow}
      />
      <div key="selected-workflow-editor" style={workflowSelectedEditorStyle}>
        <div key="selected-workflow-header" style={{ ...workflowSelectedHeaderStyle, gridTemplateColumns: "1fr" }}>
          <div key="action-bar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <GraphModeTabs mode={editStepMode} onChange={onActionModeChange} />
            <div key="action-buttons" style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
              <button
                type="button"
                style={editingWorkflowPending ? { ...primaryButtonStyle, ...buttonDisabledStyle } : primaryButtonStyle}
                disabled={editingWorkflowPending || buildManualRunButtonState(editingWorkflow.status.trim().toLowerCase()).disabled}
                onClick={() => { onRunWorkflow(editingWorkflow); }}
              >
                {editingWorkflowPending ? "Running..." : "Run"}
              </button>
              <button
                type="button"
                style={editingWorkflowPending ? { ...primaryButtonStyle, ...buttonDisabledStyle } : primaryButtonStyle}
                disabled={editingWorkflowPending}
                onClick={() => { onSaveEdit(editingWorkflow.id); }}
              >
                Save
              </button>
              <button type="button" style={buttonStyle} onClick={onCancelEdit}>Close</button>
              <button
                type="button"
                style={editingWorkflowPending ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
                disabled={editingWorkflowPending || !["active", "paused"].includes(editingWorkflow.status.trim().toLowerCase())}
                onClick={() => { onToggleStatus(editingWorkflow); }}
              >
                {editingWorkflow.status.trim().toLowerCase() === "active" ? "Pause" : "Activate"}
              </button>
              <button
                type="button"
                style={editingWorkflowPending ? { ...dangerButtonStyle, ...buttonDisabledStyle } : dangerButtonStyle}
                disabled={editingWorkflowPending}
                onClick={() => { onDeleteWorkflow(editingWorkflow); }}
              >
                보관
              </button>
            </div>
          </div>
          <div key="workflow-main" style={workflowSelectedIdentityStyle}>
            <div key="name-field" style={workflowCreateFieldStyle}>
              <FieldLabel help="Name shown in workflow lists, run history, and generated run labels.">Workflow name</FieldLabel>
              <input style={inputStyle} value={editingName} onChange={(event) => onEditingNameChange(event.target.value)} required />
            </div>
            <div key="description-field" style={workflowCreateFieldStyle}>
              <FieldLabel help="Short operator-facing summary of what this workflow does.">Description</FieldLabel>
              <textarea
                style={{ ...textareaStyle, minHeight: "38px" }}
                value={editingDescription}
                onChange={(event) => onEditingDescriptionChange(event.target.value)}
                rows={2}
              />
            </div>
          </div>
          <div key="workflow-setup-strip" style={workflowSelectedSetupStripStyle}>
            <div key="status-field" style={workflowCreateFieldStyle}>
              <FieldLabel help="Workflow availability. Active can run, paused stays saved, archived is hidden from active operation.">Status</FieldLabel>
              <select style={selectStyle} value={editingStatus} onChange={(event) => onEditingStatusChange(event.target.value)}>
                <option value="active">active</option>
                <option value="paused">paused</option>
                <option value="archived">archived</option>
              </select>
            </div>
            <div key="schedule-field" style={workflowCreateFieldStyle}>
              <FieldLabel help="Cron expression for scheduled runs. Leave blank for manual or label-triggered runs only.">Schedule (cron)</FieldLabel>
              <input style={inputStyle} value={editingSchedule} onChange={(event) => onEditingScheduleChange(event.target.value)} placeholder="0 9 * * *" />
            </div>
            <div key="timezone-field" style={workflowCreateFieldStyle}>
              <FieldLabel help="Timezone used to interpret the cron schedule.">Timezone</FieldLabel>
              <input style={inputStyle} value={editingTimezone} onChange={(event) => onEditingTimezoneChange(event.target.value)} placeholder="Asia/Seoul" />
            </div>
            <div key="project-field" style={workflowCreateFieldStyle}>
              <FieldLabel help="Optional project that generated issues and runs should be associated with.">Project</FieldLabel>
              <select style={selectStyle} value={editingProjectId} onChange={(event) => onEditingProjectIdChange(event.target.value)}>
                <option value="">— none —</option>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </div>
            <div key="max-daily-runs-field" style={workflowCreateFieldStyle}>
              <FieldLabel help="Daily run cap for scheduled or label-triggered execution. Blank uses the default limit.">Max Daily Runs</FieldLabel>
              <input style={inputStyle} type="number" min={0} step={1} value={editingMaxDailyRuns} onChange={(event) => onEditingMaxDailyRunsChange(event.target.value)} placeholder="blank=1/day" />
            </div>
            <div key="trigger-labels-field" style={workflowCreateFieldStyle}>
              <FieldLabel help="Comma-separated issue labels that can trigger this workflow.">Trigger Labels</FieldLabel>
              <input style={inputStyle} value={editingTriggerLabels} onChange={(event) => onEditingTriggerLabelsChange(event.target.value)} placeholder="daily-tech-research" />
            </div>
          </div>
          <WorkflowRunOverlayBanner
            runId={inspectedRunId}
            runSummary={inspectedRunSummary}
            runDetail={inspectedRunDetail}
            drawerMode={runDrawerMode}
            onCloseOverlay={onCloseRunOverlay}
            onViewRunRow={onViewRunRow}
          />
          {editingWorkflowRunDebugSummary ? (
            <WorkflowRunDebugStrip key="run-debug" summary={editingWorkflowRunDebugSummary} />
          ) : (
            <Fragment key="run-debug-placeholder" />
          )}
        </div>
        <div key="selected-step-workspace" style={workflowSelectedWorkspaceStyle}>
          <StepWorkspaceEditor
            renderGraphEditor={renderGraphEditor}
            steps={editingSteps}
            baseSteps={jsonToSteps(editingWorkflow.steps)}
            onChange={onEditingStepsChange}
            mode={editStepMode}
            onModeChange={onWorkspaceModeChange}
            jsonText={editJsonText}
            onJsonTextChange={onEditJsonTextChange}
            onJsonError={onJsonError}
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
  );
}
