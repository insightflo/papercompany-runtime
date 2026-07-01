import type { CSSProperties, JSX } from "react";
import { graphPolicyBadgeStyle, mutedTextStyle } from "./workflow-page-styles.js";
import type { WorkflowGraphRunDebugSummary, WorkflowGraphRunDebugTileTone } from "./workflow-graph.js";

const workflowRunDebugStripStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(188px, 0.9fr) repeat(4, minmax(116px, 1fr))",
  gap: "5px",
  gridColumn: "1 / -1",
  minWidth: 0,
  padding: "6px",
  borderBottom: "1px solid var(--border, #334155)",
  background: "color-mix(in srgb, #38bdf8 5%, var(--background, #020617))",
};

function workflowRunDebugToneColor(tone: WorkflowGraphRunDebugTileTone): string {
  if (tone === "success") return "#22c55e";
  if (tone === "warning") return "#f59e0b";
  if (tone === "danger") return "var(--destructive, #ef4444)";
  if (tone === "info") return "#38bdf8";
  return "var(--muted-foreground, #94a3b8)";
}

const workflowRunDebugDecisionStyle = (tone: WorkflowGraphRunDebugTileTone): CSSProperties => {
  const color = workflowRunDebugToneColor(tone);
  return {
    display: "grid",
    gap: "4px",
    minWidth: 0,
    padding: "8px",
    border: `1px solid color-mix(in srgb, ${color} 42%, var(--border, #334155))`,
    borderRadius: "8px",
    background: `color-mix(in srgb, ${color} 6%, var(--background, #020617))`,
  };
};

const workflowRunDebugTileStyle = (tone: WorkflowGraphRunDebugTileTone): CSSProperties => {
  const color = workflowRunDebugToneColor(tone);
  return {
    display: "grid",
    gridTemplateRows: "auto auto 1fr",
    gap: "4px",
    minWidth: 0,
    padding: "8px",
    border: `1px solid color-mix(in srgb, ${color} 28%, var(--border, #334155))`,
    borderRadius: "8px",
    background: `color-mix(in srgb, ${color} 4%, var(--card, #0f172a))`,
  };
};

export function WorkflowRunDebugStrip({ summary }: { summary: WorkflowGraphRunDebugSummary }): JSX.Element {
  return (
    <div key="workflow-run-debug-strip" style={workflowRunDebugStripStyle}>
      <div key="decision" style={workflowRunDebugDecisionStyle(summary.tone)} title={summary.summary}>
        <div key="decision-header" style={{ display: "flex", justifyContent: "space-between", gap: "8px", minWidth: 0 }}>
          <span style={{ ...mutedTextStyle, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 800 }}>
            Run debug
          </span>
          <span style={{ ...graphPolicyBadgeStyle, color: workflowRunDebugToneColor(summary.tone) }}>
            {summary.available ? summary.focusStepId || "run" : "loading"}
          </span>
        </div>
        <strong style={{ fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary.title}</strong>
        <span style={{ ...mutedTextStyle, fontSize: "10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {summary.summary}
        </span>
        <span key="badges" style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
          {summary.badges.slice(0, 4).map((badge) => (
            <span key={badge} style={graphPolicyBadgeStyle}>{badge}</span>
          ))}
        </span>
      </div>
      {summary.tiles.map((tile) => (
        <div key={tile.id} style={workflowRunDebugTileStyle(tile.tone)} title={tile.summary}>
          <div key="tile-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "7px", minWidth: 0 }}>
            <strong style={{ fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tile.title}</strong>
            <span style={{ ...graphPolicyBadgeStyle, color: workflowRunDebugToneColor(tile.tone) }}>{tile.status}</span>
          </div>
          <span style={{ ...mutedTextStyle, fontSize: "10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {tile.badges.slice(0, 2).join(" · ") || tile.summary}
          </span>
          <span style={{ ...mutedTextStyle, fontSize: "10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {tile.summary}
          </span>
        </div>
      ))}
    </div>
  );
}
