import { Fragment, type CSSProperties, type JSX } from "react";
import type { WorkflowGraphDefinitionNavigatorItem } from "./workflow-graph.js";
import type { WorkflowSummary } from "./workflow-page-types.js";
import { formatDateTime } from "./workflow-page-api.js";
import { graphPolicyBadgeStyle, mutedTextStyle } from "./workflow-page-styles.js";

const workflowDefinitionRailStyle: CSSProperties = {
  display: "grid",
  gridTemplateRows: "auto 1fr",
  gap: "10px",
  minWidth: 0,
  minHeight: 0,
  padding: "12px",
  borderRight: "1px solid var(--border, #334155)",
  background: "color-mix(in srgb, var(--card, #0f172a) 62%, var(--background, #020617))",
};

const workflowDefinitionRailListStyle: CSSProperties = {
  display: "grid",
  alignContent: "start",
  gap: "7px",
  minHeight: 0,
  overflow: "auto",
};

const workflowDefinitionRailButtonStyle = (selected: boolean): CSSProperties => ({
  display: "grid",
  gap: "5px",
  width: "100%",
  padding: "9px",
  border: `1px solid ${selected ? "color-mix(in srgb, #22c55e 54%, var(--border, #334155))" : "var(--border, #334155)"}`,
  borderRadius: "8px",
  background: selected
    ? "color-mix(in srgb, #22c55e 8%, var(--background, #020617))"
    : "var(--background, #020617)",
  color: "var(--foreground, #f8fafc)",
  textAlign: "left",
  cursor: "pointer",
});

export function WorkflowDefinitionRail({
  collapsed,
  onCollapsedChange,
  visibleItems,
  workflows,
  selectedWorkflowId,
  onSelectWorkflow,
}: {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  visibleItems: WorkflowGraphDefinitionNavigatorItem[];
  workflows: WorkflowSummary[];
  selectedWorkflowId: string;
  onSelectWorkflow: (workflow: WorkflowSummary) => void;
}): JSX.Element {
  return (
    <aside
      id="wf-rail"
      key="workflow-rail"
      style={collapsed ? { ...workflowDefinitionRailStyle, padding: "6px", gridTemplateRows: "auto" } : workflowDefinitionRailStyle}
    >
      {collapsed ? (
        <button
          key="rail-expand"
          type="button"
          title="Expand sidebar"
          aria-label="Expand sidebar"
          style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "none", color: "var(--muted-foreground, #94a3b8)", cursor: "pointer", padding: "4px", borderRadius: "6px" }}
          onClick={() => onCollapsedChange(false)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <rect width="18" height="18" x="3" y="3" rx="2" />
            <path d="M9 3v18" />
            <path d="m14 9 3 3-3 3" />
          </svg>
        </button>
      ) : (
        <Fragment key="rail-expanded">
          <div key="rail-header" style={{ display: "grid", gap: "5px" }}>
            <div key="title-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
              <span style={{ ...mutedTextStyle, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 800 }}>
                Workflows
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                <span style={graphPolicyBadgeStyle}>{visibleItems.length}</span>
                <button
                  type="button"
                  title="Collapse sidebar"
                  aria-label="Collapse sidebar"
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "none", color: "var(--muted-foreground, #94a3b8)", cursor: "pointer", padding: "4px", borderRadius: "6px" }}
                  onClick={() => onCollapsedChange(true)}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <rect width="18" height="18" x="3" y="3" rx="2" />
                    <path d="M9 3v18" />
                    <path d="m16 15-3-3 3-3" />
                  </svg>
                </button>
              </div>
            </div>
            <p key="description" style={{ ...mutedTextStyle, margin: 0, fontSize: "12px", lineHeight: 1.4 }}>
              Select a workflow. Details stay in the editor.
            </p>
          </div>
          <div key="rail-list" style={workflowDefinitionRailListStyle}>
            {visibleItems.length === 0 ? (
              <div style={{ padding: "10px", border: "1px solid var(--border, #334155)", borderRadius: "8px", background: "var(--background, #020617)" }}>
                <p style={{ ...mutedTextStyle, margin: 0 }}>No workflows match your search.</p>
              </div>
            ) : null}
            {visibleItems.map((item) => {
              const workflow = workflows.find((entry) => entry.id === item.id);
              if (!workflow) return null;
              const selected = workflow.id === selectedWorkflowId;
              const normalized = workflow.status.trim().toLowerCase();
              const activeLabel = normalized === "active" ? "active" : "inactive";
              const lastRunLabel = item.trigger.schedule.lastRunAt ? `last ${formatDateTime(item.trigger.schedule.lastRunAt)}` : "last run -";
              return (
                <button
                  key={workflow.id}
                  type="button"
                  style={workflowDefinitionRailButtonStyle(selected)}
                  onClick={() => onSelectWorkflow(workflow)}
                >
                  <span key="main" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", minWidth: 0 }}>
                    <strong style={{ fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{workflow.name}</strong>
                    <span style={{ ...graphPolicyBadgeStyle, color: normalized === "active" ? "#22c55e" : "var(--muted-foreground, #94a3b8)" }}>{activeLabel}</span>
                  </span>
                  <span key="description" style={{ color: "var(--muted-foreground, #94a3b8)", fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {workflow.description || "No description"}
                  </span>
                  <span key="runtime" style={{ color: "var(--muted-foreground, #94a3b8)", fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {lastRunLabel}
                  </span>
                </button>
              );
            })}
          </div>
        </Fragment>
      )}
    </aside>
  );
}
