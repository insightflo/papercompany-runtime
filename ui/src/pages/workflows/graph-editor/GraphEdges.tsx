import { useId } from "react";
import type { GraphCanvasProps } from "./GraphCanvas.js";
import { graphEdgeColor, graphEdgeDashArray, graphEdgeDisplayLabel } from "./graphUiUtils.js";

type Props = Pick<GraphCanvasProps, "graph" | "selectedEdgeId" | "handleEdgeClick" | "handleEdgeDoubleClick" | "handleEdgeContextMenu">;
const kinds = ["normal", "conditional", "failure", "early-stop"] as const;

export function GraphEdges({ graph, selectedEdgeId, handleEdgeClick, handleEdgeDoubleClick, handleEdgeContextMenu }: Props) {
  const id = useId();
  return (
    <svg aria-hidden="true" width="100%" height="100%"
      style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "auto" }}>
      <defs>
        {kinds.map((kind) => (
          <marker key={kind} id={`${id}-${kind}`} markerWidth="8" markerHeight="8"
            refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0,0 L8,4 L0,8 Z" fill={graphEdgeColor(kind)} />
          </marker>
        ))}
      </defs>
      <g>
        {graph.edges.map((edge) => {
          const source = graph.nodes.find((node) => node.id === edge.source);
          const target = graph.nodes.find((node) => node.id === edge.target);
          if (!source || !target) return null;
          const startX = source.x + 172;
          const startY = source.y + (edge.when === "condition_true" ? 24 : edge.when === "condition_false" ? 54 : 38);
          const endX = target.x;
          const endY = target.y + 38;
          const midX = startX + Math.max(34, (endX - startX) / 2);
          const edgePath = `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX - 8} ${endY}`;
          const selected = selectedEdgeId === edge.id;
          const color = graphEdgeColor(edge.kind);
          return (
            <g key={edge.id}>
              <path data-graph-edge="true" data-edge-id={edge.id} d={edgePath} fill="none"
                stroke="transparent" strokeWidth="16" pointerEvents="stroke" style={{ cursor: "pointer" }}
                onClick={(event) => handleEdgeClick(event, edge)}
                onDoubleClick={(event) => handleEdgeDoubleClick(event, edge)}
                onContextMenu={(event) => handleEdgeContextMenu(event, edge)} />
              <path data-graph-edge-glow="true" d={edgePath} fill="none" stroke={color}
                strokeWidth={selected ? 10 : 8} strokeLinecap="round" opacity="0.25"
                strokeDasharray={graphEdgeDashArray(edge.kind)} pointerEvents="none" style={{ filter: "blur(3px)" }} />
              <path data-graph-edge-line="true" d={edgePath} fill="none" stroke={color}
                strokeWidth={selected ? 4 : 3} strokeLinecap="round"
                strokeDasharray={graphEdgeDashArray(edge.kind)} markerEnd={`url(#${id}-${edge.kind})`} pointerEvents="none" />
              {graphEdgeDisplayLabel(edge) ? (
                <text x={midX} y={(startY + endY) / 2 - 6} fill={color} fontSize="11" fontWeight="700"
                  textAnchor="middle" pointerEvents="none">{graphEdgeDisplayLabel(edge)}</text>
              ) : null}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
