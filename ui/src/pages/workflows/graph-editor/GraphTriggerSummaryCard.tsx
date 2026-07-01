import { Fragment, type JSX } from "react";
import type { WorkflowGraphTriggerSummary } from "../workflow-graph.js";
import { graphPolicyBadgeStyle, mutedTextStyle, statusBadgeStyle } from "../workflow-page-styles.js";
import { formatDateTime } from "../workflow-page-api.js";

export function GraphTriggerSummaryCard({
  surface,
  graphTriggerSummary,
}: {
  surface: "stacked" | "focus";
  graphTriggerSummary: WorkflowGraphTriggerSummary;
}): JSX.Element {
  if (surface !== "stacked") return <Fragment />;
  return (
        <div
          key="graph-trigger-summary"
          style={{
            gridColumn: "1 / -1",
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) auto",
            gap: "10px",
            alignItems: "center",
            padding: "10px 12px",
            border: "1px solid var(--border, #334155)",
            borderRadius: "8px",
            background: "var(--background, #020617)",
          }}
        >
          <div key="trigger-copy" style={{ minWidth: 0 }}>
            <div key="trigger-title-row" style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <span key="title" style={{ fontSize: "12px", fontWeight: 800, color: "var(--foreground, #f8fafc)" }}>Flow triggers</span>
              <span key="status" style={{ ...statusBadgeStyle(graphTriggerSummary.status), fontSize: "10px" }}>{graphTriggerSummary.status}</span>
              {graphTriggerSummary.badges.map((badge) => (
                <span key={badge} style={graphPolicyBadgeStyle}>{badge}</span>
              ))}
            </div>
            <p key="description" style={{ margin: "5px 0 0", color: "var(--muted-foreground, #94a3b8)", fontSize: "12px", overflowWrap: "anywhere" }}>
              {graphTriggerSummary.description}
            </p>
            {graphTriggerSummary.schedule.error ? (
              <p key="error" style={{ margin: "5px 0 0", color: "var(--destructive, #ef4444)", fontSize: "12px", overflowWrap: "anywhere" }}>
                Last schedule error{graphTriggerSummary.schedule.errorAt ? ` (${formatDateTime(graphTriggerSummary.schedule.errorAt)})` : ""}: {graphTriggerSummary.schedule.error}
              </p>
            ) : (
              <Fragment key="error-placeholder" />
            )}
          </div>
          <div key="trigger-timing" style={{ display: "grid", gap: "2px", justifyItems: "end" }}>
            <span key="timezone" style={{ ...mutedTextStyle, fontSize: "11px" }}>
              {graphTriggerSummary.schedule.timezone || "Local timezone"}
            </span>
            <span key="last-run" style={{ fontSize: "12px", color: "var(--foreground, #f8fafc)", whiteSpace: "nowrap" }}>
              {graphTriggerSummary.schedule.lastRunAt ? `Last run ${formatDateTime(graphTriggerSummary.schedule.lastRunAt)}` : "No scheduled run yet"}
            </span>
          </div>
        </div>
  );
}
