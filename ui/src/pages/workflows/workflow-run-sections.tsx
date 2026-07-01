import { Fragment, type CSSProperties, type JSX } from "react";
import type { WorkflowRunSummary, WorkflowSummary } from "./workflow-page-types.js";
import { buttonDisabledStyle, filterTabStyle, mutedTextStyle, sectionTitleStyle } from "./workflow-page-styles.js";
import { HelpIcon } from "./shared-controls.js";
import { ActiveRunsTable, RecentRunsTable } from "./workflow-runs.js";
import { workflowFocusSectionStyle, workflowFocusToolbarGroupStyle, workflowFocusToolbarStyle } from "./workflow-layout-styles.js";

export type WorkflowRunHistoryScope = "all" | "selected";

const workflowRunHistorySectionStyle: CSSProperties = {
  ...workflowFocusSectionStyle,
  minHeight: "430px",
};

export function WorkflowRunSections({
  activeRunsScope,
  runHistoryScope,
  onActiveRunsScopeChange,
  onRunHistoryScopeChange,
  selectedHistoryWorkflow,
  scopedActiveRuns,
  selectedActiveRuns,
  displayActiveRuns,
  canFilterSelectedHistory,
  scopedRecentRuns,
  selectedHistoryRuns,
  historyRuns,
  companyId,
  onAbortRun,
  onRefreshOverview,
  highlightedRunId,
}: {
  activeRunsScope: WorkflowRunHistoryScope;
  runHistoryScope: WorkflowRunHistoryScope;
  onActiveRunsScopeChange: (scope: WorkflowRunHistoryScope) => void;
  onRunHistoryScopeChange: (scope: WorkflowRunHistoryScope) => void;
  selectedHistoryWorkflow: WorkflowSummary | null;
  scopedActiveRuns: WorkflowRunSummary[];
  selectedActiveRuns: WorkflowRunSummary[];
  displayActiveRuns: WorkflowRunSummary[];
  canFilterSelectedHistory: boolean;
  scopedRecentRuns: WorkflowRunSummary[];
  selectedHistoryRuns: WorkflowRunSummary[];
  historyRuns: WorkflowRunSummary[];
  companyId: string;
  onAbortRun: (runId: string) => void;
  onRefreshOverview: () => void;
  highlightedRunId: string | null;
}): JSX.Element {
  return (
    <Fragment>
      <section id="wf-active-runs" key="active-runs-section" style={workflowFocusSectionStyle}>
        <div key="active-runs-toolbar" style={workflowFocusToolbarStyle}>
          <div key="active-runs-title" style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
            <h2 key="title" style={{ ...sectionTitleStyle, fontSize: "14px" }}>Active Runs</h2>
            {activeRunsScope === "selected" && selectedHistoryWorkflow ? (
              <span key="selected-name" style={{ ...mutedTextStyle, fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {selectedHistoryWorkflow.name}
              </span>
            ) : (
              <Fragment key="active-selected-name-placeholder" />
            )}
          </div>
          <div key="active-runs-filters" style={workflowFocusToolbarGroupStyle}>
            <button key="all" type="button" style={filterTabStyle(activeRunsScope === "all")} onClick={() => onActiveRunsScopeChange("all")}>
              All ({scopedActiveRuns.length})
            </button>
            <button
              key="selected"
              type="button"
              style={canFilterSelectedHistory ? filterTabStyle(activeRunsScope === "selected") : { ...filterTabStyle(activeRunsScope === "selected"), ...buttonDisabledStyle }}
              disabled={!canFilterSelectedHistory}
              onClick={() => onActiveRunsScopeChange("selected")}
            >
              Selected ({selectedActiveRuns.length})
            </button>
            <HelpIcon label="Switches active runs between all visible workflows and the workflow selected in the definitions list." />
          </div>
        </div>
        <ActiveRunsTable
          activeRuns={displayActiveRuns}
          companyId={companyId}
          onAbort={onAbortRun}
          onRefreshOverview={() => Promise.resolve(onRefreshOverview())}
          highlightedRunId={highlightedRunId}
        />
      </section>

      <section id="wf-run-history" key="run-history-section" style={workflowRunHistorySectionStyle}>
        <div key="run-history-toolbar" style={workflowFocusToolbarStyle}>
          <div key="run-history-title" style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
            <h2 key="title" style={{ ...sectionTitleStyle, fontSize: "14px" }}>Run History</h2>
            {runHistoryScope === "selected" && selectedHistoryWorkflow ? (
              <span key="selected-name" style={{ ...mutedTextStyle, fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {selectedHistoryWorkflow.name}
              </span>
            ) : (
              <Fragment key="selected-name-placeholder" />
            )}
          </div>
          <div key="run-history-filters" style={workflowFocusToolbarGroupStyle}>
            <button key="all" type="button" style={filterTabStyle(runHistoryScope === "all")} onClick={() => onRunHistoryScopeChange("all")}>
              All ({scopedRecentRuns.length})
            </button>
            <button
              key="selected"
              type="button"
              style={canFilterSelectedHistory ? filterTabStyle(runHistoryScope === "selected") : { ...filterTabStyle(runHistoryScope === "selected"), ...buttonDisabledStyle }}
              disabled={!canFilterSelectedHistory}
              onClick={() => onRunHistoryScopeChange("selected")}
            >
              Selected ({selectedHistoryRuns.length})
            </button>
            <HelpIcon label="Switches run history between all visible workflows and the workflow selected in the definitions list." />
          </div>
        </div>
        <RecentRunsTable
          recentRuns={historyRuns}
          companyId={companyId}
          onRefreshOverview={() => Promise.resolve(onRefreshOverview())}
          highlightedRunId={highlightedRunId}
        />
      </section>

    </Fragment>
  );
}
