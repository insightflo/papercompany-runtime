import type { JSX } from "react";
import type { WorkflowGraphStepRunStatus } from "../workflow-graph.js";
import { formatDateTime } from "../workflow-page-api.js";
import { mutedTextStyle } from "../workflow-page-styles.js";

export function GraphRunRetryStatus({
  runStatus,
}: {
  runStatus: WorkflowGraphStepRunStatus;
}): JSX.Element | null {
  if (!runStatus.retryState) return null;
  return (
    <div style={{ display: "grid", gap: "2px" }}>
      <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Workflow retry</span>
      <span style={{ fontSize: "12px", color: "#f59e0b", overflowWrap: "anywhere", lineHeight: 1.35 }}>
        Attempt {1 + runStatus.retryCount} of {1 + runStatus.retryMaxRetries} · {runStatus.retryState}
        {runStatus.retryNextEligibleAt
          ? ` · scheduled ${formatDateTime(runStatus.retryNextEligibleAt)}`
          : ""}
      </span>
    </div>
  );
}
