import { type JSX } from "react";
import type { WorkflowGraphPaletteNodeKind } from "../workflow-graph.js";
import { buttonStyle, mutedTextStyle, primaryButtonStyle } from "../workflow-page-styles.js";
import { formPanelStyle } from "../workflow-layout-styles.js";
import { graphPaletteItems } from "./graphStyles.js";

export function GraphEmptyState({
  onAddEntry,
  onInsertPaletteNode,
}: {
  onAddEntry: () => void;
  onInsertPaletteNode: (kind: WorkflowGraphPaletteNodeKind) => void;
}): JSX.Element {
  return (
    <div style={formPanelStyle}>
      <p key="empty-message" style={mutedTextStyle}>No steps yet. Start with an entry node.</p>
      <div key="empty-actions" style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
        <button key="add-entry" type="button" style={primaryButtonStyle} onClick={onAddEntry}>
          Add Entry Step
        </button>
        <div key="starter-palette" style={{ display: "contents" }}>
          {graphPaletteItems.slice(0, 2).map((item) => (
            <button key={item.kind} type="button" style={buttonStyle} onClick={() => onInsertPaletteNode(item.kind)}>
              Start with {item.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
