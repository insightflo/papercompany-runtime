import { Fragment, type JSX } from "react";
import type { WorkflowRunSummary } from "./workflow-page-types.js";
import type { WorkflowRunDrawerMode } from "./workflow-runs.js";
import { workflowRunDrawerActionsStyle, workflowRunOverlayBannerStyle } from "./workflow-runs.js";
import { buttonStyle, graphPolicyBadgeStyle, statusBadgeStyle } from "./workflow-page-styles.js";
import { formatDateTime } from "./workflow-page-api.js";

type InspectedRunDetail = {
  loading: boolean;
  error: unknown;
  data: { run: { status: string }; stepRuns?: Array<{ id: string }> } | null;
};

export function WorkflowRunOverlayBanner({
  runId,
  runSummary,
  runDetail,
  drawerMode,
  onCloseOverlay,
  onViewRunRow,
}: {
  runId: string | null;
  runSummary: WorkflowRunSummary | null;
  runDetail: InspectedRunDetail;
  drawerMode: WorkflowRunDrawerMode;
  onCloseOverlay: () => void;
  onViewRunRow: () => void;
}): JSX.Element {
  if (!runId) return <Fragment key="run-overlay-banner-placeholder" />;
  return (
                <div key="run-overlay-banner" style={workflowRunOverlayBannerStyle}>
                  <div key="run-overlay-main" style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0, flexWrap: "wrap" }}>
                    <strong style={{ fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "280px" }}>
                      Inspecting run
                    </strong>
                    <span style={statusBadgeStyle(runSummary?.status ?? runDetail.data?.run.status ?? "running")}>
                      {runSummary?.status ?? runDetail.data?.run.status ?? (runDetail.loading ? "loading" : "selected")}
                    </span>
                    <span style={graphPolicyBadgeStyle}>{runSummary?.runLabel || runId.slice(0, 8)}</span>
                    {runSummary?.startedAt ? <span style={graphPolicyBadgeStyle}>{formatDateTime(runSummary.startedAt)}</span> : null}
                    {runDetail.data?.stepRuns ? <span style={graphPolicyBadgeStyle}>{runDetail.data.stepRuns.length} step runs</span> : null}
                    {runDetail.error ? <span style={{ ...graphPolicyBadgeStyle, color: "var(--destructive, #ef4444)" }}>detail failed</span> : null}
                  </div>
                  <div key="run-overlay-actions" style={workflowRunDrawerActionsStyle}>
                    <button type="button" style={buttonStyle} onClick={() => onCloseOverlay()}>
                      Clear overlay
                    </button>
                    {runId && drawerMode === "closed" ? (
                      <button type="button" style={buttonStyle} onClick={onViewRunRow}>
                        View run row
                      </button>
                    ) : null}
                  </div>
                </div>
  );
}
