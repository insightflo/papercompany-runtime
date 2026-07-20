import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GraphNodeHandles } from "./GraphNodeHandles.js";

describe("GraphNodeHandles", () => {
  it("renders labelled true and false outputs for IF", () => {
    const markup = renderToStaticMarkup(
      <GraphNodeHandles
        step={{ id: "if-1", type: "if" }}
        pendingConnection={null}
        beginEdgeConnection={vi.fn()}
        completeEdgeConnection={vi.fn()}
      />,
    );
    expect(markup).toContain('data-graph-handle-id="condition_true"');
    expect(markup).toContain('aria-label="Start true branch from if-1"');
    expect(markup).toContain('data-graph-handle-id="condition_false"');
    expect(markup).toContain('aria-label="Start false branch from if-1"');
    expect(markup).toContain("true");
    expect(markup).toContain("false");
  });

  it("renders no output handle for Complete and one success output for ordinary nodes", () => {
    const complete = renderToStaticMarkup(
      <GraphNodeHandles
        step={{ id: "done", type: "complete" }}
        pendingConnection={null}
        beginEdgeConnection={vi.fn()}
        completeEdgeConnection={vi.fn()}
      />,
    );
    const agent = renderToStaticMarkup(
      <GraphNodeHandles
        step={{ id: "agent", type: "agent" }}
        pendingConnection={null}
        beginEdgeConnection={vi.fn()}
        completeEdgeConnection={vi.fn()}
      />,
    );
    expect(complete).not.toContain('data-graph-handle-kind="output"');
    expect(agent).toContain('data-graph-handle-id="success"');
  });
});
