// [파일 목적] 그래프 캔버스 툴바/팔레트 영역의 자체 완결형 서브 컴포넌트.
// [주의] GraphModeTabs는 HelpIcon(shared-controls.js)에 의존하여 허용 import 밖이므로
// Workflows.tsx에 잔류시켰다. 이 파일에는 의존성이 허용 범위 안인 컴포넌트만 둔다.
import { Fragment, type JSX } from "react";
import { graphPolicyBadgeStyle, mutedTextStyle } from "../workflow-page-styles.js";
import type {
  WorkflowGraphStructurePaletteActionId,
  WorkflowGraphStructurePaletteSummary,
} from "../workflow-graph.js";
import {
  workflowGraphFocusLensToneColor,
  workflowGraphStructureActionStyle,
  workflowGraphStructurePaletteStyle,
} from "./graphStyles.js";

export function GraphZoomIcon({ direction }: { direction: "in" | "out" }): JSX.Element {
  return (
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m16.5 16.5 4 4" />
      <path d="M8 11h6" />
      {direction === "in" ? <path d="M11 8v6" /> : null}
    </svg>
  );
}

export function WorkflowGraphStructurePalette({
  summary,
  onAction,
}: {
  summary: WorkflowGraphStructurePaletteSummary;
  onAction: (actionId: WorkflowGraphStructurePaletteActionId) => void;
}): JSX.Element {
  const visibleTransformActions = summary.transformActions.filter((action) => action.id !== "route-failure");
  const renderAction = (action: WorkflowGraphStructurePaletteSummary["addActions"][number]): JSX.Element => (
    <button
      key={action.id}
      type="button"
      style={workflowGraphStructureActionStyle(action.tone, action.disabled)}
      disabled={action.disabled}
      onClick={() => onAction(action.id)}
      title={action.description}
    >
      <strong key="label" style={{ fontSize: "12px", color: "var(--foreground, #f8fafc)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {action.label}
      </strong>
      <span key="description" style={{ color: "var(--muted-foreground, #94a3b8)", fontSize: "10px", lineHeight: 1.25, overflowWrap: "anywhere" }}>
        {action.description}
      </span>
    </button>
  );

  return (
    <div key="workflow-graph-structure-palette" style={workflowGraphStructurePaletteStyle(summary.tone)}>
      <div key="header" style={{ display: "flex", alignItems: "start", justifyContent: "space-between", gap: "8px", minWidth: 0 }}>
        <div style={{ display: "grid", gap: "4px", minWidth: 0 }}>
          <span style={{ ...mutedTextStyle, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 800 }}>
            Structure palette
          </span>
          <strong style={{ fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary.title}</strong>
          <span style={{ ...mutedTextStyle, fontSize: "11px", lineHeight: 1.35, overflowWrap: "anywhere" }}>{summary.summary}</span>
        </div>
        <span style={{ ...graphPolicyBadgeStyle, color: workflowGraphFocusLensToneColor(summary.tone) }}>
          {summary.selectedStepId || "start"}
        </span>
      </div>
      <div key="badges" style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
        {summary.badges.slice(0, 5).map((badge) => (
          <span key={badge} style={graphPolicyBadgeStyle}>{badge}</span>
        ))}
      </div>
      <div key="add-actions" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "6px" }}>
        {summary.addActions.map(renderAction)}
      </div>
      {visibleTransformActions.length > 0 ? (
      <div key="transform-actions" style={{ display: "grid", gap: "6px", paddingTop: "7px", borderTop: "1px solid var(--border, #334155)" }}>
        <span style={{ ...mutedTextStyle, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 800 }}>
          Path transforms
        </span>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "6px" }}>
          {visibleTransformActions.map(renderAction)}
        </div>
      </div>
      ) : (
        <Fragment key="transform-actions-placeholder" />
      )}
    </div>
  );
}
