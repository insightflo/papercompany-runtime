import { type CSSProperties, type JSX } from "react";
import type { WorkflowRestoreKind, WorkflowSummary } from "./workflow-page-types.js";
import { buttonStyle, mutedTextStyle, primaryButtonStyle } from "./workflow-page-styles.js";

const workflowConfirmOverlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 60,
  display: "grid",
  placeItems: "center",
  padding: "24px",
  background: "rgba(2, 6, 23, 0.62)",
};

const workflowConfirmDialogStyle: CSSProperties = {
  display: "grid",
  gap: "12px",
  width: "min(520px, 100%)",
  padding: "16px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "10px",
  background: "var(--card, #0f172a)",
  boxShadow: "0 18px 48px rgba(0, 0, 0, 0.36)",
};

const workflowConfirmActionsStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "8px",
};

export function WorkflowRestoreDialog({
  workflow,
  onCancel,
  onConfirm,
}: {
  workflow: WorkflowSummary;
  onCancel: () => void;
  onConfirm: (kind: WorkflowRestoreKind) => void;
}): JSX.Element {
  return (
    <div
      key="restore-workflow-confirm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="restore-workflow-title"
      style={workflowConfirmOverlayStyle}
      onClick={() => onCancel()}
    >
      <div style={workflowConfirmDialogStyle} onClick={(event) => event.stopPropagation()}>
        <div style={{ display: "grid", gap: "4px" }}>
          <strong id="restore-workflow-title" style={{ fontSize: "15px", color: "var(--foreground, #f8fafc)" }}>
            Restore archived workflow
          </strong>
          <span style={{ ...mutedTextStyle, fontSize: "12px", lineHeight: 1.45 }}>
            Choose how to classify "{workflow.name}" when it becomes active again.
          </span>
        </div>
        <div style={{ display: "grid", gap: "6px" }}>
          <span style={{ ...mutedTextStyle, fontSize: "12px" }}>
            Reusable workflows appear with normal saved procedures. Manual workflows stay grouped with one-off mission plans.
          </span>
        </div>
        <div style={workflowConfirmActionsStyle}>
          <button type="button" style={buttonStyle} onClick={() => onCancel()}>
            Cancel
          </button>
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={() => onConfirm("reusable")}
          >
            Restore as reusable
          </button>
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={() => onConfirm("manual")}
          >
            Restore as manual
          </button>
        </div>
      </div>
    </div>
  );
}
