import { useMemo, useState, type JSX } from "react";
import { buildIssueHref } from "./routes.js";
import { currentBrowserPathname } from "./shared-controls.js";
import { WorkflowRunGraphPreview } from "./graph-editor/GraphRunPreview.js";
import { usePluginAction, useWorkflowRunDetail } from "./workflow-page-api.js";
import {
  buttonDisabledStyle,
  buttonStyle,
  mutedTextStyle,
  statusBadgeStyle,
  tableStyle,
  tdStyle,
  thStyle,
} from "./workflow-page-styles.js";
import { applyStepRunsToGraphSteps } from "./workflow-graph.js";

export function WorkflowRunDetailPanel({
  companyId,
  runId,
  onRefreshOverview,
}: {
  companyId: string;
  runId: string;
  onRefreshOverview: () => Promise<void>;
}): JSX.Element {
  const detail = useWorkflowRunDetail(runId);
  const rerunStep = usePluginAction("rerun-step");
  const [pendingStepId, setPendingStepId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string>("");
  const runGraphSteps = useMemo(() => {
    const workflowSteps = detail.data?.workflow?.steps ?? [];
    const stepRuns = detail.data?.stepRuns ?? [];
    return applyStepRunsToGraphSteps(workflowSteps, stepRuns);
  }, [detail.data]);

  async function handleRerunStep(input: { stepRunId: string; issueId?: string | null }): Promise<void> {
    setPendingStepId(input.stepRunId);
    setActionError("");
    try {
      await rerunStep({
        companyId,
        stepRunId: input.stepRunId,
        issueId: input.issueId || undefined,
      });
      await Promise.all([detail.refresh(), onRefreshOverview()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(`Step rerun 실패: ${message}`);
    } finally {
      setPendingStepId(null);
    }
  }

  if (detail.loading) {
    return <p style={mutedTextStyle}>Loading step details...</p>;
  }

  if (detail.error) {
    return <p style={mutedTextStyle}>Failed to load step details: {detail.error.message}</p>;
  }

  if (!detail.data) {
    return <p style={mutedTextStyle}>No step details available.</p>;
  }

  return (
    <div style={{ display: "grid", gap: "8px" }}>
      {actionError ? <p style={mutedTextStyle}>{actionError}</p> : null}
      <WorkflowRunGraphPreview
        steps={runGraphSteps}
        pendingStepRunId={pendingStepId}
        onRerunStep={(input) => {
          void handleRerunStep({ stepRunId: input.stepRunId, issueId: input.issueId });
        }}
      />
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Step</th>
            <th style={thStyle}>Issue</th>
            <th style={thStyle}>Type</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {detail.data.stepRuns.map((step) => {
            const canRerun = Boolean(step.id && companyId.trim() && (step.issueId || step.id));
            const isPending = pendingStepId === step.id;
            return (
              <tr key={step.id}>
                <td style={tdStyle}>
                  <div style={{ display: "grid", gap: "2px" }}>
                    <span style={{ fontWeight: 600, fontSize: "13px" }}>{step.stepTitle || step.stepId}</span>
                    <span style={{ ...mutedTextStyle, fontSize: "11px" }}>{step.stepId}</span>
                  </div>
                </td>
                <td style={tdStyle}>
                  {step.issueId ? (
                    <a
                      href={buildIssueHref({
                        issueId: step.issueId,
                        issueIdentifier: step.issueIdentifier,
                        currentPathname: currentBrowserPathname(),
                      })}
                      style={{ color: "var(--link, #60a5fa)", fontSize: "12px", textDecoration: "none" }}
                      title={step.issueId}
                    >
                      {step.issueIdentifier || step.issueId.slice(0, 8)}
                    </a>
                  ) : (
                    <span style={mutedTextStyle}>-</span>
                  )}
                </td>
                <td style={tdStyle}>{step.stepType || "-"}</td>
                <td style={tdStyle}>
                  <span style={statusBadgeStyle(step.status)}>{step.status}</span>
                </td>
                <td style={tdStyle}>
                  <button
                    type="button"
                    style={!canRerun || isPending ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
                    disabled={!canRerun || isPending}
                    onClick={() => {
                      void handleRerunStep({ stepRunId: step.id, issueId: step.issueId });
                    }}
                  >
                    {isPending ? "Rerunning..." : "Rerun Step"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
