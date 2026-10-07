import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { GraphCanvasProps } from "./GraphCanvas.js";

export type Point = { x: number; y: number };
type Geometry = { start: Point | null; end: Point | null; nearby: Point | null; ripplePoint: Point | null };
type Props = Pick<GraphCanvasProps, "graph" | "pendingConnection" | "canvasScale" | "graphCanvasRef">;
const samePoint = (a: Point | null, b: Point | null) => a === b || Boolean(a && b && a.x === b.x && a.y === b.y);

export function useConnectionGeometry(
  { graph, pendingConnection, canvasScale, graphCanvasRef }: Props,
  svgRef: RefObject<SVGSVGElement | null>,
  rippleTarget: string | undefined,
): Geometry {
  const pointer = useRef<Point | null>(null);
  const previousConnection = useRef(pendingConnection);
  const [geometry, setGeometry] = useState<Geometry>({ start: null, end: null, nearby: null, ripplePoint: null });

  // Measure after DOM commits, not during render: pan/zoom transforms must already be applied.
  useLayoutEffect(() => {
    if (previousConnection.current !== pendingConnection) pointer.current = null;
    previousConnection.current = pendingConnection;
    const measure = () => {
      const matrix = svgRef.current?.getScreenCTM?.();
      const rect = svgRef.current?.getBoundingClientRect();
      const scale = matrix?.a ?? canvasScale;
      const toCanvas = (point: Point): Point => ({
        x: (point.x - (matrix?.e ?? rect?.left ?? 0)) / scale,
        y: (point.y - (matrix?.f ?? rect?.top ?? 0)) / (matrix?.d ?? canvasScale),
      });
      const handles = Array.from(graphCanvasRef.current?.querySelectorAll<HTMLElement>("[data-graph-handle-kind]") ?? []);
      const portPoint = (stepId: string, kind: "input" | "output", when = "success"): Point | null => {
        const handle = handles.find((element) => element.dataset.stepId === stepId
          && element.dataset.graphHandleKind === kind
          && (kind === "input" || element.dataset.graphHandleId === when));
        if (!handle) return null;
        const portRect = handle.getBoundingClientRect();
        if (portRect.width || portRect.height) {
          return toCanvas({ x: portRect.left + portRect.width / 2, y: portRect.top + portRect.height / 2 });
        }
        const node = graph.nodes.find((item) => item.id === stepId);
        if (!node) return null;
        return { x: node.x + (kind === "output" ? 172 : 0),
          y: node.y + (kind === "output" && when === "condition_true" ? 24 : kind === "output" && when === "condition_false" ? 54 : 38) };
      };
      const start = pendingConnection ? portPoint(pendingConnection.sourceStepId, "output", pendingConnection.when) : null;
      const end = pointer.current ? toCanvas(pointer.current) : start;
      let nearby: Point | null = null;
      if (pendingConnection && end && pointer.current) {
        let distance = 22 / scale;
        for (const node of graph.nodes) {
          if (node.id === pendingConnection.sourceStepId) continue;
          const point = portPoint(node.id, "input");
          if (!point) continue;
          const next = Math.hypot(point.x - end.x, point.y - end.y);
          if (next < distance) { nearby = point; distance = next; }
        }
      }
      const next = { start, end, nearby, ripplePoint: rippleTarget ? portPoint(rippleTarget, "input") : null };
      setGeometry((current) => samePoint(current.start, next.start) && samePoint(current.end, next.end)
        && samePoint(current.nearby, next.nearby) && samePoint(current.ripplePoint, next.ripplePoint) ? current : next);
    };
    measure();
    if (!pendingConnection && !rippleTarget) return;
    const move = (event: PointerEvent) => { pointer.current = { x: event.clientX, y: event.clientY }; measure(); };
    const cancel = () => { pointer.current = null; measure(); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    // Follow the existing 140ms viewport transition too, even with a stationary pointer.
    let frame: number;
    const tick = () => { measure(); frame = window.requestAnimationFrame(tick); };
    frame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  });
  return geometry;
}
