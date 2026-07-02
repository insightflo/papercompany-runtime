import { Fragment, useEffect, useState, type CSSProperties, type JSX } from "react";
import { buildIssueHref } from "./routes.js";
import { MissionRunLink, currentBrowserPathname } from "./shared-controls.js";
import { formatDateTime } from "./workflow-page-api.js";
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
} from "./workflow-page-styles.js";
import type { WorkflowOverviewData, WorkflowRunSummary } from "./workflow-page-types.js";
import { WorkflowRunDetailPanel } from "./workflow-run-detail-panel.js";
import { formatTriggerSource } from "./workflow-run-tables.js";

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
