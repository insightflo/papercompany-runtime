// [파일 목적] 워크플로우 정의 목록 + 미니플로우 컴포넌트.
// Workflows.tsx에서 WorkflowDefinitionMiniFlow + WorkflowDefinitionList + 전용 styles 기계적 추출.
// [외부 연결] ./workflow-page-types.js, ./run-feedback.js, ./workflow-parent-policy.js, ./workflow-page-api.js, ./workflow-page-styles.js, ./shared-controls.js, ./workflow-filters.js, react.
// [주의] 동작 변경 없이. 루트 Workflows.tsx 역참조 금지.
import { Fragment, type CSSProperties, type JSX } from "react";
import type { WorkflowOverviewData, WorkflowSummary } from "./workflow-page-types.js";
import { buildManualRunButtonState } from "./run-feedback.js";
import { normalizeCreateParentIssuePolicy } from "./workflow-parent-policy.js";
import { formatDateTime } from "./workflow-page-api.js";
import { buttonDisabledStyle, buttonStyle, dangerButtonStyle, graphPolicyBadgeStyle, mutedTextStyle, primaryButtonStyle, statusBadgeStyle } from "./workflow-page-styles.js";
import { HelpIcon } from "./shared-controls.js";
import { filterRunsForWorkflows, isManualMissionPlanWorkflow } from "./workflow-filters.js";

const workflowDefinitionListStyle: CSSProperties = {
  display: "grid",
  gap: "8px",
};

const workflowDefinitionListRowStyle = (highlighted: boolean): CSSProperties => ({
  display: "grid",
  gridTemplateColumns: "minmax(220px, 0.95fr) minmax(320px, 1.25fr) minmax(230px, auto)",
  gap: "12px",
  alignItems: "center",
  padding: "10px",
  border: `1px solid ${highlighted ? "color-mix(in srgb, #22c55e 46%, var(--border, #334155))" : "var(--border, #334155)"}`,
  borderRadius: "8px",
  background: highlighted
    ? "color-mix(in srgb, #22c55e 8%, var(--background, #020617))"
    : "color-mix(in srgb, var(--background, #020617) 84%, var(--card, #0f172a))",
});

const workflowDefinitionListIdentityStyle: CSSProperties = {
  display: "grid",
  gap: "5px",
  minWidth: 0,
};

const workflowDefinitionListTitleStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "7px",
  minWidth: 0,
  flexWrap: "wrap",
};

const workflowDefinitionMiniFlowStyle: CSSProperties = {
  display: "grid",
  gap: "6px",
  minWidth: 0,
};

const workflowDefinitionMiniFlowNodesStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(58px, 1fr))",
  gap: "6px",
  alignItems: "center",
  minWidth: 0,
};

const workflowDefinitionMiniFlowNodeStyle = (type?: string): CSSProperties => ({
  minWidth: 0,
  padding: "5px 6px",
  border: `1px solid ${type === "tool" ? "color-mix(in srgb, #38bdf8 45%, var(--border, #334155))" : "var(--border, #334155)"}`,
  borderRadius: "7px",
  background: "var(--background, #020617)",
  color: "var(--foreground, #f8fafc)",
  fontSize: "11px",
  lineHeight: 1.2,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const workflowDefinitionListMetricsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "9px",
  minWidth: 0,
  color: "var(--muted-foreground, #94a3b8)",
  fontSize: "11px",
  overflow: "hidden",
  whiteSpace: "nowrap",
};

const workflowDefinitionListActionsStyle: CSSProperties = {
  display: "grid",
  justifyItems: "end",
  gap: "6px",
  minWidth: 0,
};

const workflowDefinitionListActionRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "6px",
  flexWrap: "wrap",
};


export function WorkflowDefinitionMiniFlow({ workflow }: { workflow: WorkflowSummary }): JSX.Element {
  const visibleSteps = workflow.steps.slice(0, 4);
  const remainingCount = Math.max(0, workflow.steps.length - visibleSteps.length);

  if (workflow.steps.length === 0) {
    return (
      <div style={workflowDefinitionMiniFlowStyle}>
        <div style={workflowDefinitionMiniFlowNodesStyle}>
          <span style={{ ...workflowDefinitionMiniFlowNodeStyle(), color: "var(--muted-foreground, #94a3b8)" }}>No steps</span>
        </div>
        <div style={workflowDefinitionListMetricsStyle}>
          <span>0 steps</span>
          <span>Manual draft</span>
        </div>
      </div>
    );
  }

  return (
    <div style={workflowDefinitionMiniFlowStyle}>
      <div style={workflowDefinitionMiniFlowNodesStyle}>
        {visibleSteps.map((step) => (
          <span key={step.id} style={workflowDefinitionMiniFlowNodeStyle(step.type)} title={step.title || step.id}>
            {step.title || step.id}
          </span>
        ))}
      </div>
      <div style={workflowDefinitionListMetricsStyle}>
        <span>{workflow.steps.length} steps</span>
        <span>{workflow.schedule?.trim() ? "cron" : "manual"}</span>
        {(workflow.triggerLabels ?? []).length > 0 ? <span>{workflow.triggerLabels!.length} labels</span> : null}
        {remainingCount > 0 ? <span>+{remainingCount} more</span> : null}
      </div>
    </div>
  );
}


export function WorkflowDefinitionList({
  workflows,
  activeRuns,
  recentRuns,
  pendingWorkflowId,
  editingWorkflowId,
  onOpenGraph,
  onRunWorkflow,
  onRestoreWorkflow,
  onDeleteWorkflow,
  onToggleStatus,
}: {
  workflows: WorkflowOverviewData["workflows"];
  activeRuns: WorkflowOverviewData["activeRuns"];
  recentRuns: WorkflowOverviewData["recentRuns"];
  pendingWorkflowId: string | null;
  editingWorkflowId: string | null;
  onOpenGraph: (workflow: WorkflowSummary) => void;
  onRunWorkflow: (workflow: WorkflowSummary) => void;
  onRestoreWorkflow: (workflow: WorkflowSummary) => void;
  onDeleteWorkflow: (workflow: WorkflowSummary) => void;
  onToggleStatus: (workflow: WorkflowSummary) => void;
}): JSX.Element {
  if (workflows.length === 0) {
    return (
      <div style={{ padding: "14px", border: "1px solid var(--border, #334155)", borderRadius: "8px", background: "var(--background, #020617)" }}>
        <p style={mutedTextStyle}>No workflows defined yet.</p>
      </div>
    );
  }

  return (
    <div style={workflowDefinitionListStyle}>
      {workflows.map((workflow) => {
        const normalizedStatus = workflow.status.trim().toLowerCase();
        const isPending = pendingWorkflowId === workflow.id;
        const runButtonState = buildManualRunButtonState(normalizedStatus);
        const runButtonDisabled = isPending || runButtonState.disabled;
        const workflowActiveRuns = filterRunsForWorkflows(activeRuns, [workflow]);
        const workflowRecentRuns = filterRunsForWorkflows(recentRuns, [workflow]);
        const failedRecentRuns = workflowRecentRuns.filter((run) => run.status.trim().toLowerCase() === "failed").length;
        const isSelected = editingWorkflowId === workflow.id;

        return (
          <div key={`${workflow.id}:definition-row`} style={workflowDefinitionListRowStyle(isSelected)}>
            <div key="identity" style={workflowDefinitionListIdentityStyle}>
              <div key="title" style={workflowDefinitionListTitleStyle}>
                <strong style={{ fontSize: "13px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {workflow.name}
                </strong>
                <span style={{ ...statusBadgeStyle(workflow.status), fontSize: "10px" }}>{workflow.status}</span>
                {isManualMissionPlanWorkflow(workflow) ? (
                  <span style={{ ...statusBadgeStyle("planned"), fontSize: "10px" }}>manual mission plan</span>
                ) : null}
              </div>
              <span key="description" style={{ ...mutedTextStyle, fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {workflow.description || "No description"}
              </span>
              <div key="badges" style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
                <span style={{ ...graphPolicyBadgeStyle, color: workflow.schedule?.trim() ? "#38bdf8" : graphPolicyBadgeStyle.color }}>
                  {workflow.schedule?.trim() || "manual"}
                </span>
                <span style={graphPolicyBadgeStyle}>{workflow.timezone || "Local timezone"}</span>
                <span style={graphPolicyBadgeStyle}>parent {normalizeCreateParentIssuePolicy(workflow.createParentIssuePolicy)}</span>
              </div>
            </div>
            <div key="flow" style={workflowDefinitionMiniFlowStyle}>
              <WorkflowDefinitionMiniFlow workflow={workflow} />
              <div key="runtime-metrics" style={workflowDefinitionListMetricsStyle}>
                {workflowActiveRuns.length > 0 ? <span>{workflowActiveRuns.length} active run{workflowActiveRuns.length === 1 ? "" : "s"}</span> : <span>0 active</span>}
                {workflowRecentRuns.length > 0 ? <span>{workflowRecentRuns.length} recent</span> : <span>0 recent</span>}
                {failedRecentRuns > 0 ? <span style={{ color: "var(--destructive, #ef4444)" }}>{failedRecentRuns} failed</span> : null}
                {workflow.lastScheduledRunAt ? <span>last {formatDateTime(workflow.lastScheduledRunAt)}</span> : null}
                {workflow.lastScheduleError ? <span style={{ color: "var(--destructive, #ef4444)" }}>schedule error</span> : null}
              </div>
            </div>
            <div key="actions" style={workflowDefinitionListActionsStyle}>
              <div key="action-row" style={workflowDefinitionListActionRowStyle}>
                {normalizedStatus === "archived" ? (
                  <button
                    type="button"
                    style={isPending ? { ...primaryButtonStyle, ...buttonDisabledStyle } : primaryButtonStyle}
                    disabled={isPending}
                    onClick={() => onRestoreWorkflow(workflow)}
                  >
                    복원
                  </button>
                ) : (
                  <Fragment>
                    <button
                      type="button"
                      style={isPending ? { ...primaryButtonStyle, ...buttonDisabledStyle } : primaryButtonStyle}
                      disabled={isPending}
                      onClick={() => onOpenGraph(workflow)}
                    >
                      {isSelected ? "Graph Open" : "Open Graph"}
                    </button>
                    <button
                      type="button"
                      style={runButtonDisabled ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
                      disabled={runButtonDisabled}
                      title={runButtonState.title}
                      onClick={() => onRunWorkflow(workflow)}
                    >
                      {isPending ? "Running..." : runButtonState.label}
                    </button>
                    <button
                      type="button"
                      style={isPending ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
                      disabled={isPending || (normalizedStatus !== "active" && normalizedStatus !== "paused")}
                      onClick={() => onToggleStatus(workflow)}
                    >
                      {normalizedStatus === "active" ? "Pause" : "Activate"}
                    </button>
                    <button
                      type="button"
                      style={isPending ? { ...dangerButtonStyle, ...buttonDisabledStyle } : dangerButtonStyle}
                      disabled={isPending}
                      onClick={() => onDeleteWorkflow(workflow)}
                    >
                      보관
                    </button>
                  </Fragment>
                )}
                <HelpIcon label={normalizedStatus === "archived"
                  ? "Restores this archived workflow and asks whether it should return as reusable or manual."
                  : "Open Graph edits this workflow. Run starts it. Pause/Activate changes status. Archive moves it out of active lists."}
                />
              </div>
              {runButtonState.notice && normalizedStatus !== "archived" ? (
                <span style={{ ...mutedTextStyle, color: "#fbbf24", fontSize: "11px", textAlign: "right" }}>
                  {runButtonState.notice}
                </span>
              ) : (
                <span style={{ ...mutedTextStyle, fontSize: "11px", textAlign: "right" }}>
                  {isManualMissionPlanWorkflow(workflow) ? "One-off plan" : "Reusable procedure"}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
