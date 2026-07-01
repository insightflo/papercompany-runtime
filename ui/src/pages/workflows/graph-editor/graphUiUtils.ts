// [파일 목적] 워크플로우 그래프 에디터의 상태 타입 + 순수 UI 헬퍼 함수 모음.
// [주의] StepDraft(./step-draft.js)에 의존하는 graphEdgeMetadataFor는
// 허용된 import 목록 밖이므로 여기로 옮기지 않고 Workflows.tsx에 잔류시켰다.
import type { CSSProperties } from "react";
import type {
  WorkflowGraphContainerType,
  WorkflowGraphEdge,
  WorkflowGraphEdgeKind,
  WorkflowGraphIssueSeverity,
} from "../workflow-graph.js";

export type GraphContextMenuState = {
  kind: "canvas" | "node" | "edge";
  clientX: number;
  clientY: number;
  stepId?: string;
  edgeId?: string;
  sourceId?: string;
  targetId?: string;
};

export type GraphNodeDragState = {
  stepId: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  moved: boolean;
};

export type GraphCanvasPanState = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startPanX: number;
  startPanY: number;
};

export type GraphEdgeActionAnchor = {
  edge: WorkflowGraphEdge;
  x: number;
  y: number;
};

export function graphIssueBadgeStyle(severity: WorkflowGraphIssueSeverity): CSSProperties {
  const color = severity === "error"
    ? "#ef4444"
    : severity === "warning"
      ? "#f59e0b"
      : "#38bdf8";
  return {
    display: "inline-flex",
    alignItems: "center",
    width: "fit-content",
    padding: "2px 6px",
    borderRadius: "999px",
    background: `color-mix(in srgb, ${color} 18%, transparent)`,
    color,
    fontSize: "10px",
    fontWeight: 700,
    textTransform: "uppercase",
  };
}

export function containerColor(type: WorkflowGraphContainerType): string {
  return type === "loop" ? "#f59e0b" : "#8b5cf6";
}

export function graphEdgeColor(kind: WorkflowGraphEdgeKind): string {
  if (kind === "conditional") return "#38bdf8";
  if (kind === "failure") return "#f87171";
  if (kind === "early-stop") return "#fbbf24";
  return "var(--muted-foreground, #94a3b8)";
}

export function graphEdgeDashArray(kind: WorkflowGraphEdgeKind): string | undefined {
  if (kind === "conditional") return "6 4";
  if (kind === "failure") return "3 4";
  if (kind === "early-stop") return "8 3 2 3";
  return undefined;
}

export function graphEdgeDisplayLabel(edge: WorkflowGraphEdge): string {
  if (edge.label.trim()) return edge.label.trim();
  if (edge.kind !== "normal") return edge.kind;
  return edge.condition.trim();
}
