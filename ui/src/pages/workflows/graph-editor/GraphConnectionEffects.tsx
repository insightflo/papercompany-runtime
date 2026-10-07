import { useEffect, useRef, useState } from "react";
import type { GraphCanvasProps } from "./GraphCanvas.js";
import type { PendingWorkflowConnection } from "../workflow-control-nodes.js";
import { graphEdgeColor } from "./graphUiUtils.js";
import { useConnectionGeometry, type Point } from "./useConnectionGeometry.js";
import "./graphConnectionEffects.css";

type Props = Pick<GraphCanvasProps, "graph" | "pendingConnection" | "canvasScale" | "graphCanvasRef">;

function curve(start: Point, end: Point) {
  const bend = Math.max(34, Math.abs(end.x - start.x) / 2);
  return `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}`;
}

/** Decorations only: connection ownership and all input handlers remain in the editor. */
export function GraphConnectionEffects(props: Props) {
  const { graph, pendingConnection } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const [ripple, setRipple] = useState<{ target: string; color: string; key: number } | null>(null);
  const attempt = useRef<{ connection: PendingWorkflowConnection; edgeIds: Set<string> } | null>(null);
  const rippleSequence = useRef(0);
  const { start, end, nearby, ripplePoint } = useConnectionGeometry(props, svgRef, ripple?.target);

  useEffect(() => {
    if (pendingConnection) {
      if (attempt.current?.connection !== pendingConnection) {
        attempt.current = { connection: pendingConnection, edgeIds: new Set(graph.edges.map((edge) => edge.id)) };
      }
      return;
    }
    const previous = attempt.current;
    attempt.current = null;
    if (!previous) return;
    const added = graph.edges.find((edge) => !previous.edgeIds.has(edge.id)
      && edge.source === previous.connection.sourceStepId
      && (edge.when ?? "success") === previous.connection.when);
    if (added) setRipple({ target: added.target, color: graphEdgeColor(added.kind), key: ++rippleSequence.current });
  }, [pendingConnection, graph.edges]);

  useEffect(() => {
    if (!ripple) return;
    const timer = window.setTimeout(() => setRipple(null), 500);
    return () => window.clearTimeout(timer);
  }, [ripple]);

  const color = graphEdgeColor("normal");
  const sparkStart = nearby ? { x: nearby.x - 28, y: nearby.y } : null;
  return (
    <svg ref={svgRef} aria-hidden="true" width="100%" height="100%" data-graph-connection-effects="true"
      style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none", zIndex: 2 }}>
      {pendingConnection && start && end ? (
        <g fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path data-graph-connection-preview="true" d={curve(start, sparkStart ?? end)} stroke="#fff" strokeWidth="3"
            style={{ filter: "drop-shadow(0 0 3px #ffffff80)" }} />
          {nearby && sparkStart ? <>
            <path data-graph-connection-spark="true" className="graph-connection-spark" stroke={color} strokeWidth="3"
              d={`M ${sparkStart.x} ${nearby.y} l 6 -5 l 5 10 l 6 -10 l 5 8 L ${nearby.x} ${nearby.y}`} />
            <circle data-graph-connection-halo="true" cx={nearby.x} cy={nearby.y} r="11" stroke={color} strokeWidth="2"
              style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
          </> : null}
        </g>
      ) : null}
      {ripple && ripplePoint ? <circle key={ripple.key} data-graph-connection-ripple="true" className="graph-connection-ripple"
        cx={ripplePoint.x} cy={ripplePoint.y} r="8" fill="none" stroke={ripple.color} strokeWidth="2" /> : null}
    </svg>
  );
}
