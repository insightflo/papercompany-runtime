import { Fragment, useEffect, useState, type JSX } from "react";
import { buildIssueHref } from "./routes.js";
import { MissionRunLink, currentBrowserPathname } from "./shared-controls.js";
import { formatDateTime } from "./workflow-page-api.js";
import {
  buttonDisabledStyle,
  buttonStyle,
  dangerButtonStyle,
  graphPolicyBadgeStyle,
  highlightedRunRowStyle,
  mutedTextStyle,
  paginationBarStyle,
  paginationInfoStyle,
  primaryButtonStyle,
  statusBadgeStyle,
  tableStyle,
  tdStyle,
  thStyle,
} from "./workflow-page-styles.js";
import type { WorkflowOverviewData } from "./workflow-page-types.js";
import { WorkflowRunDetailPanel } from "./workflow-run-detail-panel.js";

export function ActiveRunsTable({
  activeRuns,
  companyId,
  onAbort,
  onRefreshOverview,
  highlightedRunId,
  inspectedRunId,
  onInspectRun,
}: {
  activeRuns: WorkflowOverviewData["activeRuns"];
  companyId: string;
  onAbort: (runId: string) => void;
  onRefreshOverview: () => Promise<void>;
  highlightedRunId: string | null;
  inspectedRunId?: string | null;
  onInspectRun?: (runId: string) => void;
}): JSX.Element {
  if (!Array.isArray(activeRuns) || activeRuns.length === 0) {
    return <p style={mutedTextStyle}>No active runs.</p>;
  }

  const pageSize = 10;
  const [page, setPage] = useState(1);
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(() => new Set());
  const totalPages = Math.max(1, Math.ceil(activeRuns.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const visibleRuns = activeRuns.slice(pageStart, pageStart + pageSize);

  useEffect(() => {
    setPage(1);
  }, [activeRuns.length]);

  return (
    <div>
      <table key="active-runs-table" style={tableStyle}>
        <thead key="active-runs-head">
          <tr key="active-runs-head-row">
            <th key="workflow" style={thStyle}>Workflow</th>
            <th key="run" style={thStyle}>Run</th>
            <th key="issue" style={thStyle}>Issue</th>
            <th key="status" style={thStyle}>Status</th>
            <th key="started" style={thStyle}>Started</th>
            <th key="actions" style={thStyle}>Actions</th>
          </tr>
        </thead>
        <tbody key="active-runs-body">
          {visibleRuns.map((run, runIndex) => {
            const isExpanded = expandedRunIds.has(run.id);
            const isHighlighted = highlightedRunId === run.id;
            const isInspected = inspectedRunId === run.id;
            const runKey = `${run.id || run.runLabel || run.workflowName}:${pageStart + runIndex}`;
            return (
              <Fragment key={runKey}>
              <tr key={`${runKey}:summary`} style={isHighlighted ? highlightedRunRowStyle : undefined}>
                <td key="workflow" style={tdStyle}>{run.workflowName}</td>
                <td key="run" style={tdStyle}>
                    {run.runLabel && <span key="label" style={{ fontSize: "12px", fontWeight: 600 }}>{run.runLabel}</span>}
                    {isHighlighted ? <span key="highlight" style={{ ...statusBadgeStyle("running"), marginLeft: "6px" }}>new</span> : null}
                    {isInspected ? <span key="inspected" style={{ ...graphPolicyBadgeStyle, marginLeft: "6px", color: "#38bdf8" }}>overlay</span> : null}
                  </td>
                <td key="issue" style={tdStyle}>
                  {run.parentIssueId && (
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
                  )}
                </td>
                <td key="status" style={tdStyle}>
                  <span style={statusBadgeStyle(run.status)}>{run.status}</span>
                </td>
                <td key="started" style={tdStyle}>{formatDateTime(run.startedAt)}</td>
                <td key="actions" style={tdStyle}>
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    <MissionRunLink missionId={run.missionId} />
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
                      {onInspectRun ? (
                        <button type="button" style={isInspected ? primaryButtonStyle : buttonStyle} onClick={() => onInspectRun(run.id)}>
                          Inspect
                        </button>
                      ) : null}
                      <button type="button" style={dangerButtonStyle} onClick={() => onAbort(run.id)}>Abort</button>
                    </div>
                </td>
              </tr>
              {isExpanded ? (
                <tr key={`${runKey}:detail`}>
                  <td key="detail" style={tdStyle} colSpan={6}>
                    <WorkflowRunDetailPanel
                      companyId={companyId}
                      runId={run.id}
                      onRefreshOverview={onRefreshOverview}
                    />
                  </td>
                </tr>
              ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {totalPages > 1 ? (
        <div key="active-runs-pagination" style={paginationBarStyle}>
          <span key="page-info" style={paginationInfoStyle}>
            {pageStart + 1}-{Math.min(pageStart + pageSize, activeRuns.length)} / {activeRuns.length}
          </span>
          <div key="page-actions" style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              style={currentPage <= 1 ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
              disabled={currentPage <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >Prev</button>
            <button
              type="button"
              style={currentPage >= totalPages ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
              disabled={currentPage >= totalPages}
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
            >Next</button>
          </div>
        </div>
      ) : (
        <Fragment key="active-runs-pagination-placeholder" />
      )}
    </div>
  );
}

export function RecentRunsTable({
  recentRuns,
  companyId,
  onRefreshOverview,
  highlightedRunId,
  inspectedRunId,
  onInspectRun,
}: {
  recentRuns: WorkflowOverviewData["recentRuns"];
  companyId: string;
  onRefreshOverview: () => Promise<void>;
  highlightedRunId: string | null;
  inspectedRunId?: string | null;
  onInspectRun?: (runId: string) => void;
}): JSX.Element {
  if (!Array.isArray(recentRuns) || recentRuns.length === 0) {
    return <p style={mutedTextStyle}>No recent runs.</p>;
  }

  const pageSize = 10;
  const [page, setPage] = useState(1);
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(() => new Set());
  const totalPages = Math.max(1, Math.ceil(recentRuns.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const visibleRuns = recentRuns.slice(pageStart, pageStart + pageSize);

  useEffect(() => {
    setPage(1);
  }, [recentRuns.length]);

  return (
    <div>
      <table key="recent-runs-table" style={tableStyle}>
        <thead key="recent-runs-head">
          <tr key="recent-runs-head-row">
            <th key="workflow" style={thStyle}>Workflow</th>
            <th key="run" style={thStyle}>Run</th>
            <th key="trigger" style={thStyle}>Trigger</th>
            <th key="issue" style={thStyle}>Issue</th>
            <th key="status" style={thStyle}>Status</th>
            <th key="started" style={thStyle}>Started</th>
            <th key="completed" style={thStyle}>Completed</th>
            <th key="actions" style={thStyle}>Actions</th>
          </tr>
        </thead>
        <tbody key="recent-runs-body">
          {visibleRuns.map((run, runIndex) => {
            const isExpanded = expandedRunIds.has(run.id);
            const isHighlighted = highlightedRunId === run.id;
            const isInspected = inspectedRunId === run.id;
            const runKey = `${run.id || run.runLabel || run.workflowName}:${pageStart + runIndex}`;
            return (
              <Fragment key={runKey}>
              <tr key={`${runKey}:summary`} style={isHighlighted ? highlightedRunRowStyle : undefined}>
                <td key="workflow" style={tdStyle}>{run.workflowName}</td>
                <td key="run" style={tdStyle}>
                    {run.runLabel && <span key="label" style={{ fontSize: "12px", fontWeight: 600 }}>{run.runLabel}</span>}
                    {isHighlighted ? <span key="highlight" style={{ ...statusBadgeStyle("running"), marginLeft: "6px" }}>new</span> : null}
                    {isInspected ? <span key="inspected" style={{ ...graphPolicyBadgeStyle, marginLeft: "6px", color: "#38bdf8" }}>overlay</span> : null}
                  </td>
                <td key="trigger" style={tdStyle}>{formatTriggerSource(run.triggerSource)}</td>
                <td key="issue" style={tdStyle}>
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
                  ) : (
                    <span style={mutedTextStyle}>-</span>
                  )}
                </td>
                <td key="status" style={tdStyle}>
                  <span style={statusBadgeStyle(run.status)}>{run.status}</span>
                </td>
                <td key="started" style={tdStyle}>{formatDateTime(run.startedAt)}</td>
                <td key="completed" style={tdStyle}>{run.completedAt ? formatDateTime(run.completedAt) : "-"}</td>
                <td key="actions" style={tdStyle}>
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    <MissionRunLink missionId={run.missionId} />
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
                      {onInspectRun ? (
                        <button type="button" style={isInspected ? primaryButtonStyle : buttonStyle} onClick={() => onInspectRun(run.id)}>
                          Inspect
                        </button>
                      ) : null}
                    </div>
                  </td>
              </tr>
              {isExpanded ? (
                <tr key={`${runKey}:detail`}>
                  <td key="detail" style={tdStyle} colSpan={8}>
                    <WorkflowRunDetailPanel
                      companyId={companyId}
                      runId={run.id}
                      onRefreshOverview={onRefreshOverview}
                    />
                  </td>
                </tr>
              ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {totalPages > 1 ? (
        <div key="recent-runs-pagination" style={paginationBarStyle}>
          <span key="page-info" style={paginationInfoStyle}>
            {pageStart + 1}-{Math.min(pageStart + pageSize, recentRuns.length)} / {recentRuns.length}
          </span>
          <div key="page-actions" style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              style={currentPage <= 1 ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
              disabled={currentPage <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >Prev</button>
            <button
              type="button"
              style={currentPage >= totalPages ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
              disabled={currentPage >= totalPages}
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
            >Next</button>
          </div>
        </div>
      ) : (
        <Fragment key="recent-runs-pagination-placeholder" />
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
