import { type JSX } from "react";
import { buttonDisabledStyle, buttonStyle, headerRowStyle, primaryButtonStyle, titleStyle } from "./workflow-page-styles.js";
import { HelpIcon } from "./shared-controls.js";

export function WorkflowPageHeader({
  showHelp,
  onToggleHelp,
  showNewWorkflowForm,
  onNewWorkflow,
  isRefreshing,
  refreshButtonLabel,
  onRefresh,
}: {
  showHelp: boolean;
  onToggleHelp: () => void;
  showNewWorkflowForm: boolean;
  onNewWorkflow: () => void;
  isRefreshing: boolean;
  refreshButtonLabel: string;
  onRefresh: () => void;
}): JSX.Element {
  return (
      <div id="wf-header" key="workflow-page-header" style={{ ...headerRowStyle, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <h1 key="title" style={titleStyle}>Workflows</h1>
          <button
            type="button"
            title={showHelp ? "도움말 닫기" : "도움말"}
            aria-label="Help"
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: "20px", height: "20px", borderRadius: "50%", border: "1px solid var(--muted-foreground, #94a3b8)", background: "transparent", color: "var(--muted-foreground, #94a3b8)", cursor: "pointer", fontSize: "12px", fontWeight: 700, padding: 0, lineHeight: 1 }}
            onClick={onToggleHelp}
          >
            ?
          </button>
        </div>
        <div key="header-actions" style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <button
            key="new-workflow"
            type="button"
            style={showNewWorkflowForm ? { ...buttonStyle, ...buttonDisabledStyle } : primaryButtonStyle}
            disabled={showNewWorkflowForm}
            onClick={onNewWorkflow}
          >
            + New Workflow
          </button>
          <button
            key="refresh"
            type="button"
            onClick={() => {
              void onRefresh();
            }}
            disabled={isRefreshing}
            style={isRefreshing ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
          >
            {refreshButtonLabel}
          </button>
          <HelpIcon label="New Workflow opens the creation form. Refresh reloads workflow definitions and run status from the server." />
        </div>
      </div>

  );
}
