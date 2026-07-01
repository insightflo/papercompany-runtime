import { Fragment, useEffect, useMemo, useState, type CSSProperties, type JSX } from "react";
import { buildIssueHref } from "./routes.js";
import { currentBrowserPathname, MissionRunLink } from "./shared-controls.js";
import { WorkflowRunGraphPreview } from "./graph-editor/GraphRunPreview.js";
import { formatDateTime, usePluginAction, useWorkflowRunDetail } from "./workflow-page-api.js";
import {
  buttonDisabledStyle,
  buttonStyle,
  dangerButtonStyle,
  graphPolicyBadgeStyle,
  mutedTextStyle,
  paginationBarStyle,
  paginationInfoStyle,
  primaryButtonStyle,
  statusBadgeStyle,
  tableStyle,
  tdStyle,
  thStyle,
} from "./workflow-page-styles.js";
import type { WorkflowOverviewData, WorkflowRunSummary } from "./workflow-page-types.js";
import { applyStepRunsToGraphSteps, type WorkflowGraphRunDebugSummary, type WorkflowGraphRunDebugTileTone } from "./workflow-graph.js";

export type WorkflowRunDrawerMode = "closed" | "active" | "recent";

const workflowRunDrawerStyle = (mode: WorkflowRunDrawerMode): CSSProperties => ({
  display: "grid",
  gridTemplateRows: mode === "closed" ? "auto" : "auto minmax(0, 1fr)",
  minHeight: mode === "closed" ? "46px" : "430px",
  maxHeight: mode === "closed" ? "46px" : "560px",
  borderTop: "1px solid var(--border, #334155)",
  background: "color-mix(in srgb, var(--background, #020617) 86%, var(--card, #0f172a))",
});

const workflowRunDrawerHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "10px",
  minWidth: 0,
  padding: "8px 10px",
  borderBottom: "1px solid var(--border, #334155)",
};

const workflowRunDrawerSummaryStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "10px",
  minWidth: 0,
  padding: "8px 10px",
};

const workflowRunDrawerBodyStyle: CSSProperties = {
  minHeight: 0,
  overflow: "auto",
};

const workflowRunTimelineStyle: CSSProperties = {
  display: "grid",
  gap: "7px",
  minHeight: 0,
  padding: "8px 10px",
};

const workflowRunTimelineRowStyle = (selected: boolean): CSSProperties => ({
  display: "grid",
  gridTemplateColumns: "14px minmax(170px, 1.2fr) minmax(110px, 0.7fr) minmax(150px, 1fr) auto",
  gap: "9px",
  alignItems: "center",
  minHeight: "48px",
  padding: "8px",
  border: `1px solid ${selected ? "color-mix(in srgb, #38bdf8 48%, var(--border, #334155))" : "var(--border, #334155)"}`,
  borderRadius: "8px",
  background: selected
    ? "color-mix(in srgb, #38bdf8 7%, var(--background, #020617))"
    : "var(--background, #020617)",
});

const workflowRunTimelineDotStyle = (status: string): CSSProperties => {
  const normalized = status.trim().toLowerCase();
  const color = normalized === "failed" || normalized === "aborted" || normalized === "error"
    ? "var(--destructive, #ef4444)"
    : normalized === "running" || normalized === "in_progress"
      ? "#38bdf8"
      : normalized === "completed" || normalized === "succeeded" || normalized === "success" || normalized === "done"
        ? "#22c55e"
        : "#94a3b8";
  return {
    width: "9px",
    height: "9px",
    borderRadius: "999px",
    background: color,
    boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 16%, transparent)`,
  };
};

const workflowRunTimelineActionsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: "6px",
  flexWrap: "wrap",
};

const workflowRunTimelineDetailStyle: CSSProperties = {
  padding: "8px",
  border: "1px dashed color-mix(in srgb, #38bdf8 36%, var(--border, #334155))",
  borderRadius: "8px",
  background: "color-mix(in srgb, #38bdf8 5%, var(--background, #020617))",
};

export const workflowRunDrawerActionsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: "6px",
  flexWrap: "wrap",
};

export const workflowRunOverlayBannerStyle: CSSProperties = {
  gridColumn: "1 / -1",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "10px",
  minWidth: 0,
  padding: "8px 9px",
  borderTop: "1px solid color-mix(in srgb, #38bdf8 24%, var(--border, #334155))",
  background: "color-mix(in srgb, #38bdf8 7%, var(--background, #020617))",
};

const workflowRunDebugStripStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(188px, 0.9fr) repeat(4, minmax(116px, 1fr))",
  gap: "5px",
  gridColumn: "1 / -1",
  minWidth: 0,
  padding: "6px",
  borderBottom: "1px solid var(--border, #334155)",
  background: "color-mix(in srgb, #38bdf8 5%, var(--background, #020617))",
};

function workflowRunDebugToneColor(tone: WorkflowGraphRunDebugTileTone): string {
  if (tone === "success") return "#22c55e";
  if (tone === "warning") return "#f59e0b";
  if (tone === "danger") return "var(--destructive, #ef4444)";
  if (tone === "info") return "#38bdf8";
  return "var(--muted-foreground, #94a3b8)";
}

const workflowRunDebugDecisionStyle = (tone: WorkflowGraphRunDebugTileTone): CSSProperties => {
  const color = workflowRunDebugToneColor(tone);
  return {
    display: "grid",
    gap: "4px",
    minWidth: 0,
    padding: "8px",
    border: `1px solid color-mix(in srgb, ${color} 42%, var(--border, #334155))`,
    borderRadius: "8px",
    background: `color-mix(in srgb, ${color} 6%, var(--background, #020617))`,
  };
};

const workflowRunDebugTileStyle = (tone: WorkflowGraphRunDebugTileTone): CSSProperties => {
  const color = workflowRunDebugToneColor(tone);
  return {
    display: "grid",
    gridTemplateRows: "auto auto 1fr",
    gap: "4px",
    minWidth: 0,
    padding: "8px",
    border: `1px solid color-mix(in srgb, ${color} 28%, var(--border, #334155))`,
    borderRadius: "8px",
    background: `color-mix(in srgb, ${color} 4%, var(--card, #0f172a))`,
  };
};

export function WorkflowRunDebugStrip({ summary }: { summary: WorkflowGraphRunDebugSummary }): JSX.Element {
  return (
    <div key="workflow-run-debug-strip" style={workflowRunDebugStripStyle}>
      <div key="decision" style={workflowRunDebugDecisionStyle(summary.tone)} title={summary.summary}>
        <div key="decision-header" style={{ display: "flex", justifyContent: "space-between", gap: "8px", minWidth: 0 }}>
          <span style={{ ...mutedTextStyle, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 800 }}>
            Run debug
          </span>
          <span style={{ ...graphPolicyBadgeStyle, color: workflowRunDebugToneColor(summary.tone) }}>
            {summary.available ? summary.focusStepId || "run" : "loading"}
          </span>
        </div>
        <strong style={{ fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary.title}</strong>
        <span style={{ ...mutedTextStyle, fontSize: "10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {summary.summary}
        </span>
        <span key="badges" style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
          {summary.badges.slice(0, 4).map((badge) => (
            <span key={badge} style={graphPolicyBadgeStyle}>{badge}</span>
          ))}
        </span>
      </div>
      {summary.tiles.map((tile) => (
        <div key={tile.id} style={workflowRunDebugTileStyle(tile.tone)} title={tile.summary}>
          <div key="tile-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "7px", minWidth: 0 }}>
            <strong style={{ fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tile.title}</strong>
            <span style={{ ...graphPolicyBadgeStyle, color: workflowRunDebugToneColor(tile.tone) }}>{tile.status}</span>
          </div>
          <span style={{ ...mutedTextStyle, fontSize: "10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {tile.badges.slice(0, 2).join(" · ") || tile.summary}
          </span>
          <span style={{ ...mutedTextStyle, fontSize: "10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {tile.summary}
          </span>
        </div>
      ))}
    </div>
  );
}

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

function WorkflowRunTimeline({
  runs,
  mode,
  companyId,
  highlightedRunId,
  inspectedRunId,
  onRefreshOverview,
  onAbortRun,
  onInspectRun,
}: {
  runs: WorkflowRunSummary[];
  mode: Exclude<WorkflowRunDrawerMode, "closed">;
  companyId: string;
  highlightedRunId: string | null;
  inspectedRunId: string | null;
  onRefreshOverview: () => Promise<void>;
  onAbortRun?: (runId: string) => void;
  onInspectRun: (runId: string) => void;
}): JSX.Element {
  const pageSize = 8;
  const [page, setPage] = useState(1);
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(() => new Set());
  const totalPages = Math.max(1, Math.ceil(runs.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const visibleRuns = runs.slice(pageStart, pageStart + pageSize);

  useEffect(() => {
    setPage(1);
  }, [runs.length, mode]);

  if (!Array.isArray(runs) || runs.length === 0) {
    return <p style={{ ...mutedTextStyle, padding: "8px 10px" }}>{mode === "active" ? "No active runs." : "No recent runs."}</p>;
  }

  return (
    <div style={workflowRunTimelineStyle}>
      {visibleRuns.map((run, runIndex) => {
        const isExpanded = expandedRunIds.has(run.id);
        const isHighlighted = highlightedRunId === run.id;
        const isInspected = inspectedRunId === run.id;
        const runKey = `${run.id || run.runLabel || run.workflowName}:${pageStart + runIndex}`;
        const runLabel = run.runLabel?.trim() || run.id.slice(0, 8);
        return (
          <Fragment key={runKey}>
            <div key={`${runKey}:summary`} style={workflowRunTimelineRowStyle(isInspected)}>
              <span key="dot" style={workflowRunTimelineDotStyle(run.status)} />
              <div key="main" style={{ display: "grid", gap: "3px", minWidth: 0 }}>
                <strong style={{ fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {runLabel}
                </strong>
                <span style={{ color: "var(--muted-foreground, #94a3b8)", fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {formatTriggerSource(run.triggerSource)} · {run.workflowName}
                </span>
              </div>
              <div key="status" style={{ display: "flex", alignItems: "center", gap: "5px", flexWrap: "wrap" }}>
                <span style={{ ...statusBadgeStyle(run.status), fontSize: "10px" }}>{run.status}</span>
                {isHighlighted ? <span style={{ ...statusBadgeStyle("running"), fontSize: "10px" }}>new</span> : null}
                {isInspected ? <span style={{ ...graphPolicyBadgeStyle, color: "#38bdf8" }}>overlay</span> : null}
              </div>
              <div key="time" style={{ display: "grid", gap: "2px", minWidth: 0 }}>
                <span style={{ color: "var(--muted-foreground, #94a3b8)", fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  Started {formatDateTime(run.startedAt)}
                </span>
                <span style={{ color: "var(--muted-foreground, #94a3b8)", fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {run.completedAt ? `Completed ${formatDateTime(run.completedAt)}` : run.parentIssueIdentifier || run.parentIssueId || "in progress"}
                </span>
              </div>
              <div key="actions" style={workflowRunTimelineActionsStyle}>
                <MissionRunLink missionId={run.missionId} />
                {run.parentIssueId ? (
                  <a
                    href={buildIssueHref({
                      issueId: run.parentIssueId,
                      issueIdentifier: run.parentIssueIdentifier,
                      currentPathname: currentBrowserPathname(),
                    })}
                    style={{ color: "var(--link, #60a5fa)", fontSize: "12px", textDecoration: "none" }}
                    title={run.parentIssueId}
                  >
                    {run.parentIssueIdentifier || run.parentIssueId.slice(0, 8)}
                  </a>
                ) : null}
                <button type="button" style={isInspected ? primaryButtonStyle : buttonStyle} onClick={() => onInspectRun(run.id)}>
                  Inspect
                </button>
                <button
                  type="button"
                  style={buttonStyle}
                  onClick={() => {
                    setExpandedRunIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(run.id)) next.delete(run.id);
                      else next.add(run.id);
                      return next;
                    });
                  }}
                >
                  {isExpanded ? "Hide Steps" : "View Steps"}
                </button>
                {mode === "active" && onAbortRun ? (
                  <button type="button" style={dangerButtonStyle} onClick={() => onAbortRun(run.id)}>Abort</button>
                ) : null}
              </div>
            </div>
            {isExpanded ? (
              <div key={`${runKey}:detail`} style={workflowRunTimelineDetailStyle}>
                <WorkflowRunDetailPanel
                  companyId={companyId}
                  runId={run.id}
                  onRefreshOverview={onRefreshOverview}
                />
              </div>
            ) : null}
          </Fragment>
        );
      })}
      {totalPages > 1 ? (
        <div key="run-timeline-pagination" style={paginationBarStyle}>
          <span key="page-info" style={paginationInfoStyle}>
            {pageStart + 1}-{Math.min(pageStart + pageSize, runs.length)} / {runs.length}
          </span>
          <div key="page-actions" style={{ display: "flex", gap: "8px" }}>
            <button type="button" style={currentPage <= 1 ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle} disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Prev</button>
            <button type="button" style={currentPage >= totalPages ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle} disabled={currentPage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>Next</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function WorkflowRunDrawer({
  mode,
  onModeChange,
  workflowName,
  activeRuns,
  recentRuns,
  companyId,
  highlightedRunId,
  inspectedRunId,
  onRefreshOverview,
  onAbortRun,
  onInspectRun,
}: {
  mode: WorkflowRunDrawerMode;
  onModeChange: (mode: WorkflowRunDrawerMode) => void;
  workflowName: string;
  activeRuns: WorkflowOverviewData["activeRuns"];
  recentRuns: WorkflowOverviewData["recentRuns"];
  companyId: string;
  highlightedRunId: string | null;
  inspectedRunId: string | null;
  onRefreshOverview: () => Promise<void>;
  onAbortRun: (runId: string) => void;
  onInspectRun: (runId: string) => void;
}): JSX.Element {
  const failedRecentRuns = recentRuns.filter((run) => run.status.trim().toLowerCase() === "failed").length;
  const drawerTitle = mode === "active"
    ? `Active Runs for ${workflowName}`
    : mode === "recent"
      ? `Recent Runs for ${workflowName}`
      : `Runs for ${workflowName}`;
  const activeButtonStyle = mode === "active" ? primaryButtonStyle : buttonStyle;
  const recentButtonStyle = mode === "recent" ? primaryButtonStyle : buttonStyle;

  return (
    <div key="workflow-run-drawer" style={workflowRunDrawerStyle(mode)}>
      <div key="run-drawer-summary" style={mode === "closed" ? workflowRunDrawerSummaryStyle : workflowRunDrawerHeaderStyle}>
        <div key="summary-main" style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0, flexWrap: "wrap" }}>
          <strong style={{ fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "320px" }}>
            {drawerTitle}
          </strong>
          <span style={graphPolicyBadgeStyle}>scoped</span>
          <span style={graphPolicyBadgeStyle}>{activeRuns.length} active</span>
          <span style={graphPolicyBadgeStyle}>{recentRuns.length} recent</span>
          {failedRecentRuns > 0 ? <span style={{ ...graphPolicyBadgeStyle, color: "var(--destructive, #ef4444)" }}>{failedRecentRuns} failed</span> : null}
        </div>
        <div key="summary-actions" style={workflowRunDrawerActionsStyle}>
          <button type="button" style={activeButtonStyle} onClick={() => onModeChange(mode === "active" ? "closed" : "active")}>
            Runs
          </button>
          <button type="button" style={recentButtonStyle} onClick={() => onModeChange(mode === "recent" ? "closed" : "recent")}>
            History
          </button>
          {mode !== "closed" ? (
            <button type="button" style={buttonStyle} onClick={() => onModeChange("closed")}>
              Collapse
            </button>
          ) : (
            <Fragment key="collapse-placeholder" />
          )}
        </div>
      </div>
      {mode === "closed" ? (
        <Fragment key="run-drawer-body-placeholder" />
      ) : (
        <div key="run-drawer-body" style={workflowRunDrawerBodyStyle}>
          <WorkflowRunTimeline
            runs={mode === "active" ? activeRuns : recentRuns}
            mode={mode}
            companyId={companyId}
            highlightedRunId={highlightedRunId}
            inspectedRunId={inspectedRunId}
            onRefreshOverview={onRefreshOverview}
            onAbortRun={mode === "active" ? onAbortRun : undefined}
            onInspectRun={onInspectRun}
          />
        </div>
      )}
    </div>
  );
}

export function formatTriggerSource(triggerSource?: string): string {
  switch ((triggerSource ?? "").trim().toLowerCase()) {
    case "schedule":
      return "cron";
    case "label":
      return "label";
    case "api":
      return "api";
    case "manual":
      return "manual";
    default:
      return triggerSource?.trim() || "unknown";
  }
}
