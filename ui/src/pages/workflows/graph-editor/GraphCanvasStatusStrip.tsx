import { type JSX } from "react";
import type { WorkflowGraphWorkbenchSummary } from "../workflow-graph.js";
import { graphPolicyBadgeStyle } from "../workflow-page-styles.js";
import { graphStatusStripStyle } from "./graphStyles.js";

export function GraphCanvasStatusStrip({
  workbenchSummary,
  canvasScale,
}: {
  workbenchSummary: WorkflowGraphWorkbenchSummary;
  canvasScale: number;
}): JSX.Element {
  const statusStripAccentColor = "#38bdf8";
  return (
    <div key="graph-status-strip" style={graphStatusStripStyle}>
      <div key="path-summary" style={{ minWidth: 0, display: "flex", alignItems: "center", gap: "7px", color: "var(--muted-foreground, #94a3b8)", fontSize: "12px", overflow: "hidden" }}>
        <strong style={{ color: "var(--foreground, #f8fafc)", whiteSpace: "nowrap" }}>Selected path</strong>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{workbenchSummary.pathSummary}</span>
      </div>
      <div key="status-badges" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "5px", flexWrap: "wrap" }}>
        {workbenchSummary.statusBadges.map((badge) => (
          <span key={badge} style={{ ...graphPolicyBadgeStyle, color: badge.includes("error") && !badge.startsWith("0 ") ? "var(--destructive, #ef4444)" : statusStripAccentColor }}>{badge}</span>
        ))}
        <span key="canvas-scale" style={{ ...graphPolicyBadgeStyle, color: "#a78bfa" }}>{Math.round(canvasScale * 100)}%</span>
      </div>
    </div>
  );
}
