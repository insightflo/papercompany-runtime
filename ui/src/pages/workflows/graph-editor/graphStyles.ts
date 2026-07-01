// [파일 목적] 워크플로우 그래프 에디터 전용 스타일 상수/팩토리 모음.
// Workflows.tsx에서 기계적 분리(phase 3 step 1)된 선언들을 모아둔다.
// [주의] 여기서는 비주얼 스타일만 다룬다. 상태 타입/헬퍼 함수는 graphUiUtils.ts 참고.
import type { CSSProperties } from "react";
import { buttonDisabledStyle, buttonStyle } from "../workflow-page-styles.js";
import type { WorkflowGraphFocusLensTone, WorkflowGraphPaletteNodeKind } from "../workflow-graph.js";

export const graphShellStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(620px, 1fr) 8px 420px",
  gap: "0",
  alignItems: "stretch",
  minHeight: 0,
  height: "100%",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  overflow: "hidden",
  background: "var(--background, #020617)",
};

export const graphWorkbenchMainStyle: CSSProperties = {
  display: "grid",
  gridTemplateRows: "minmax(360px, 1fr) auto",
  minWidth: 0,
  minHeight: 0,
};

export const graphInspectorResizeHandleStyle: CSSProperties = {
  width: "8px",
  minWidth: "8px",
  cursor: "col-resize",
  background: "color-mix(in srgb, var(--border, #334155) 72%, var(--background, #020617))",
  borderLeft: "1px solid var(--border, #334155)",
  borderRight: "1px solid var(--border, #334155)",
  touchAction: "none",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

export const graphStatusStripStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  alignItems: "center",
  gap: "10px",
  padding: "9px 10px",
  borderTop: "1px solid var(--border, #334155)",
  background: "color-mix(in srgb, var(--card, #0f172a) 72%, var(--background, #020617))",
};

export const graphCanvasStyle: CSSProperties = {
  position: "relative",
  minHeight: "360px",
  height: "100%",
  overflow: "hidden",
  background: "linear-gradient(90deg, color-mix(in srgb, var(--border, #334155) 22%, transparent) 1px, transparent 1px), linear-gradient(180deg, color-mix(in srgb, var(--border, #334155) 22%, transparent) 1px, transparent 1px), var(--background, #020617)",
  backgroundSize: "28px 28px",
};

export const graphCanvasToolDockBaseStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  width: "fit-content",
  padding: "4px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  background: "color-mix(in srgb, var(--card, #0f172a) 92%, transparent)",
  boxShadow: "0 6px 20px color-mix(in srgb, #000 22%, transparent)",
};

export const graphCanvasEditToolLayerStyle: CSSProperties = {
  position: "absolute",
  top: "10px",
  right: "10px",
  zIndex: 10,
  display: "flex",
  justifyContent: "flex-end",
  pointerEvents: "none",
};

export const graphCanvasViewToolLayerStyle: CSSProperties = {
  position: "absolute",
  right: "10px",
  bottom: "10px",
  zIndex: 10,
  display: "flex",
  justifyContent: "flex-end",
  pointerEvents: "none",
};

export const graphCanvasEditToolDockStyle: CSSProperties = {
  ...graphCanvasToolDockBaseStyle,
  pointerEvents: "auto",
};

export const graphCanvasViewToolDockStyle: CSSProperties = {
  ...graphCanvasToolDockBaseStyle,
  pointerEvents: "auto",
};

export const graphCanvasToolGroupStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  padding: "2px",
  border: "1px solid color-mix(in srgb, var(--border, #334155) 70%, transparent)",
  borderRadius: "7px",
  background: "color-mix(in srgb, var(--background, #020617) 76%, transparent)",
};

export const graphCanvasToolLabelStyle: CSSProperties = {
  padding: "0 5px",
  color: "var(--muted-foreground, #94a3b8)",
  fontSize: "10px",
  fontWeight: 800,
  textTransform: "uppercase",
  whiteSpace: "nowrap",
};

export const graphCanvasToolButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "28px",
  height: "28px",
  padding: 0,
  border: "1px solid color-mix(in srgb, var(--border, #334155) 82%, transparent)",
  borderRadius: "7px",
  background: "var(--background, #020617)",
  color: "var(--foreground, #f8fafc)",
  fontSize: "12px",
  fontWeight: 800,
  cursor: "pointer",
};

export const graphContextMenuStyle: CSSProperties = {
  position: "fixed",
  zIndex: 40,
  display: "grid",
  gap: "3px",
  minWidth: "176px",
  padding: "5px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  background: "var(--card, #0f172a)",
  boxShadow: "0 10px 28px color-mix(in srgb, #000 34%, transparent)",
};

export const graphContextMenuButtonStyle: CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "10px",
  padding: "7px 8px",
  border: "0",
  borderRadius: "6px",
  background: "transparent",
  color: "var(--foreground, #f8fafc)",
  fontSize: "12px",
  textAlign: "left",
  cursor: "pointer",
};

export const graphSidebarStyle: CSSProperties = {
  display: "grid",
  gap: "10px",
  alignContent: "start",
  padding: "12px",
  background: "var(--background, #020617)",
  overflow: "auto",
  minHeight: 0,
};

export const graphInspectorSectionStyle: CSSProperties = {
  display: "grid",
  gap: "8px",
  paddingBottom: "8px",
  borderBottom: "1px solid var(--border, #334155)",
};

// [주의] focus-lens 톤 색상 함수는 아래 여러 스타일 팩토리가 의존하므로 같은 파일에 둔다.
export function workflowGraphFocusLensToneColor(tone: WorkflowGraphFocusLensTone): string {
  if (tone === "success") return "#22c55e";
  if (tone === "warning") return "#f59e0b";
  if (tone === "danger") return "var(--destructive, #ef4444)";
  if (tone === "info") return "#38bdf8";
  return "var(--muted-foreground, #94a3b8)";
}

export const workflowGraphFocusLensMetricStyle = (tone: WorkflowGraphFocusLensTone): CSSProperties => {
  const color = workflowGraphFocusLensToneColor(tone);
  return {
    display: "grid",
    gap: "3px",
    minWidth: 0,
    padding: "7px",
    borderLeft: `2px solid ${color}`,
    background: `color-mix(in srgb, ${color} 5%, var(--background, #020617))`,
  };
};

export const workflowGraphTestDrawerStyle = (tone: WorkflowGraphFocusLensTone): CSSProperties => {
  const color = workflowGraphFocusLensToneColor(tone);
  return {
    display: "grid",
    gap: "9px",
    padding: "9px",
    border: `1px solid color-mix(in srgb, ${color} 34%, var(--border, #334155))`,
    borderRadius: "8px",
    background: `color-mix(in srgb, ${color} 5%, var(--background, #020617))`,
  };
};

export const workflowGraphTestDrawerModeStyle = (tone: WorkflowGraphFocusLensTone): CSSProperties => {
  const color = workflowGraphFocusLensToneColor(tone);
  return {
    display: "grid",
    gap: "4px",
    minWidth: 0,
    padding: "7px",
    border: `1px solid color-mix(in srgb, ${color} 28%, var(--border, #334155))`,
    borderRadius: "7px",
    background: `color-mix(in srgb, ${color} 4%, transparent)`,
  };
};

export const workflowGraphStructurePaletteStyle = (tone: WorkflowGraphFocusLensTone): CSSProperties => {
  const color = workflowGraphFocusLensToneColor(tone);
  return {
    display: "grid",
    gap: "8px",
    padding: "9px",
    border: `1px solid color-mix(in srgb, ${color} 32%, var(--border, #334155))`,
    borderRadius: "8px",
    background: `color-mix(in srgb, ${color} 5%, var(--background, #020617))`,
  };
};

export const workflowGraphStructureActionStyle = (tone: WorkflowGraphFocusLensTone, disabled = false): CSSProperties => {
  const color = workflowGraphFocusLensToneColor(tone);
  return {
    ...buttonStyle,
    display: "grid",
    gap: "3px",
    justifyContent: "stretch",
    alignContent: "start",
    minHeight: "54px",
    padding: "7px",
    textAlign: "left",
    borderColor: `color-mix(in srgb, ${color} 24%, var(--border, #334155))`,
    background: `color-mix(in srgb, ${color} 4%, var(--background, #020617))`,
    ...(disabled ? buttonDisabledStyle : {}),
  };
};

export const graphNodeStyle = (selected: boolean, kind: string, matched = false, inSelection = false): CSSProperties => ({
  position: "absolute",
  width: "172px",
  minHeight: "76px",
  padding: "10px",
  border: selected
    ? "2px solid color-mix(in srgb, var(--foreground, #f8fafc) 62%, transparent)"
    : matched
      ? "2px solid #fbbf24"
      : inSelection
        ? "2px solid #22c55e"
      : "1px solid var(--border, #334155)",
  borderRadius: "8px",
  background: kind === "tool"
    ? "color-mix(in srgb, #0891b2 18%, var(--card, #0f172a))"
    : kind === "group"
      ? "color-mix(in srgb, #0ea5e9 16%, var(--card, #0f172a))"
    : "var(--card, #0f172a)",
  color: "var(--foreground, #f8fafc)",
  boxShadow: selected
    ? "0 0 0 3px color-mix(in srgb, var(--foreground, #f8fafc) 10%, transparent)"
    : matched
      ? "0 0 0 3px color-mix(in srgb, #fbbf24 18%, transparent)"
      : inSelection
        ? "0 0 0 3px color-mix(in srgb, #22c55e 14%, transparent)"
      : "none",
  cursor: "pointer",
  textAlign: "left",
});

export const graphNodeHandleBaseStyle: CSSProperties = {
  position: "absolute",
  top: "50%",
  width: "14px",
  height: "14px",
  border: "2px solid var(--background, #020617)",
  borderRadius: "999px",
  transform: "translateY(-50%)",
  boxShadow: "0 0 0 1px color-mix(in srgb, #38bdf8 55%, transparent)",
  cursor: "crosshair",
  zIndex: 4,
};

export const graphNodeInputHandleStyle = (active: boolean): CSSProperties => ({
  ...graphNodeHandleBaseStyle,
  left: "-8px",
  background: active ? "#22c55e" : "#64748b",
  boxShadow: active
    ? "0 0 0 3px color-mix(in srgb, #22c55e 24%, transparent)"
    : graphNodeHandleBaseStyle.boxShadow,
});

export const graphNodeOutputHandleStyle = (active: boolean): CSSProperties => ({
  ...graphNodeHandleBaseStyle,
  right: "-8px",
  background: active ? "#22c55e" : "#38bdf8",
  boxShadow: active
    ? "0 0 0 3px color-mix(in srgb, #22c55e 24%, transparent)"
    : graphNodeHandleBaseStyle.boxShadow,
});

export const graphEdgeRemoveButtonStyle: CSSProperties = {
  position: "absolute",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "22px",
  height: "22px",
  padding: 0,
  border: "1px solid color-mix(in srgb, var(--destructive, #ef4444) 48%, var(--border, #334155))",
  borderRadius: "999px",
  background: "var(--background, #020617)",
  color: "var(--destructive, #ef4444)",
  fontSize: "16px",
  fontWeight: 800,
  lineHeight: 1,
  cursor: "pointer",
  zIndex: 6,
  boxShadow: "0 6px 18px rgba(0, 0, 0, 0.35)",
};

export const graphDiagnosticRowStyle: CSSProperties = {
  display: "grid",
  gap: "5px",
  padding: "8px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  background: "var(--card, #0f172a)",
};

export const graphPaletteItems: Array<{ kind: WorkflowGraphPaletteNodeKind; label: string; description: string }> = [
  { kind: "agent", label: "Agent", description: "Papercompany assignee step" },
  { kind: "tool", label: "Tool", description: "System tool execution" },
  { kind: "branch", label: "Branch", description: "Conditional flow container" },
  { kind: "loop", label: "Loop", description: "For-each container" },
  { kind: "approval", label: "Approval", description: "Suspend until approved" },
  { kind: "failure-handler", label: "Failure", description: "Failure edge handler" },
];
