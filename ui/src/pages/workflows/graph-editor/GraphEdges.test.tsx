// @vitest-environment jsdom
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { buildWorkflowGraphModel } from "../workflow-graph.js";
import { GraphEdges } from "./GraphEdges.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const cases = [
  ["normal", "var(--muted-foreground, #94a3b8)", null],
  ["conditional", "#38bdf8", "6 4"],
  ["failure", "#f87171", "3 4"],
  ["early-stop", "#fbbf24", "8 3 2 3"],
] as const;
const graph = buildWorkflowGraphModel([
  { id: "source", type: "agent" },
  ...cases.map(([kind]) => ({ id: kind, type: "agent", dependsOn: ["source"],
    graphEdgeMetadata: { source: { kind } } })),
]);

describe("GraphEdges", () => {
  it("preserves every semantic color/dash, uses matching arrows and retains non-interactive rounded glow paths", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(<GraphEdges graph={graph} selectedEdgeId={graph.edges[0].id}
      handleEdgeClick={vi.fn()} handleEdgeDoubleClick={vi.fn()} handleEdgeContextMenu={vi.fn()} />);
    expect(container.querySelectorAll("[data-graph-edge-line]")).toHaveLength(4);
    for (const [kind, color, dash] of cases) {
      const edge = graph.edges.find((item) => item.target === kind)!;
      const hit = Array.from(container.querySelectorAll("[data-graph-edge]")).find((item) => item.getAttribute("data-edge-id") === edge.id)!;
      const line = hit.parentElement!.querySelector("[data-graph-edge-line]")!;
      const glow = hit.parentElement!.querySelector("[data-graph-edge-glow]")!;
      expect(line.getAttribute("stroke")).toBe(color);
      expect(line.getAttribute("stroke-dasharray")).toBe(dash);
      expect(line.getAttribute("stroke-linecap")).toBe("round");
      expect(line.getAttribute("stroke-width")).toBe(edge.id === graph.edges[0].id ? "4" : "3");
      expect(line.getAttribute("pointer-events")).toBe("none");
      expect(glow.getAttribute("stroke")).toBe(color);
      expect(glow.getAttribute("stroke-dasharray")).toBe(dash);
      expect(glow.getAttribute("pointer-events")).toBe("none");
      const markerId = line.getAttribute("marker-end")!.slice(5, -1);
      const marker = Array.from(container.querySelectorAll("marker")).find((item) => item.id === markerId)!;
      expect(marker.querySelector("path")!.getAttribute("fill")).toBe(color);
      expect(hit.getAttribute("stroke-width")).toBe("16");
      expect(hit.getAttribute("pointer-events")).toBe("stroke");
    }
  });

  it("keeps click, double-click and context-menu callbacks on the wide hit path", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const click = vi.fn(), doubleClick = vi.fn(), contextMenu = vi.fn();
    try {
      await act(async () => root.render(<GraphEdges graph={graph} selectedEdgeId={null}
        handleEdgeClick={click} handleEdgeDoubleClick={doubleClick} handleEdgeContextMenu={contextMenu} />));
      const hit = container.querySelector("[data-graph-edge]")!;
      for (const name of ["click", "dblclick", "contextmenu"]) {
        await act(async () => hit.dispatchEvent(new MouseEvent(name, { bubbles: true })));
      }
      for (const handler of [click, doubleClick, contextMenu]) {
        expect(handler).toHaveBeenCalledOnce();
        expect(handler.mock.calls[0][1]).toBe(graph.edges[0]);
      }
    } finally {
      await act(async () => root.unmount());
    }
  });
});
