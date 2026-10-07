// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { GraphConnectionEffects } from "./GraphConnectionEffects.js";
import { GraphNodeHandles } from "./GraphNodeHandles.js";
import { buildWorkflowGraphModel } from "../workflow-graph.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
it("remeasures after a viewport commit and scroll without requiring another pointer move", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const canvas = createRef<HTMLDivElement>();
  const graph = buildWorkflowGraphModel([{ id: "source", type: "agent" }]);
  const connection = { sourceStepId: "source", when: "success" as const };
  const render = (pan: number) => <div ref={canvas} style={{ transform: `translateX(${pan}px)` }}>
    <GraphConnectionEffects graph={graph} pendingConnection={connection} canvasScale={1} graphCanvasRef={canvas} />
    <GraphNodeHandles step={{ id: "source" }} pendingConnection={connection}
      beginEdgeConnection={vi.fn()} completeEdgeConnection={vi.fn()} />
  </div>;
  try {
    await act(async () => root.render(render(0)));
    const svg = container.querySelector("svg")!;
    let scroll = 0;
    Object.defineProperty(svg, "getScreenCTM", { value: () => ({ a: 1, d: 1,
      e: Number.parseFloat(canvas.current!.style.transform.slice(11)) - scroll, f: 0 }) });
    await act(async () => window.dispatchEvent(new MouseEvent("pointermove", { clientX: 400, clientY: 200 })));
    const path = () => container.querySelector("[data-graph-connection-preview]")!.getAttribute("d");
    expect(path()).toMatch(/400 200$/);
    await act(async () => root.render(render(100)));
    expect(path()).toMatch(/300 200$/);
    scroll = 40;
    await act(async () => canvas.current!.dispatchEvent(new Event("scroll")));
    expect(path()).toMatch(/340 200$/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
