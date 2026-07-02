import { type JSX, type PointerEvent, type SyntheticEvent } from "react";
import type { StepDraft } from "../step-draft.js";
import { buttonDisabledStyle } from "../workflow-page-styles.js";
import {
  graphCanvasEditToolDockStyle,
  graphCanvasEditToolLayerStyle,
  graphCanvasToolButtonStyle,
  graphCanvasToolGroupStyle,
  graphCanvasToolLabelStyle,
  graphCanvasViewToolDockStyle,
  graphCanvasViewToolLayerStyle,
} from "./graphStyles.js";
import type { GraphEdgeActionAnchor } from "./graphUiUtils.js";
import { GraphZoomIcon } from "./GraphToolbar.js";

export function GraphCanvasEditTools({
  selectedStep,
  selectedEdgeActionAnchor,
  addAfter,
  handleDeleteGraphObjectPointerDown,
  stopGraphControlEvent,
}: {
  selectedStep: StepDraft | null;
  selectedEdgeActionAnchor: GraphEdgeActionAnchor | null;
  addAfter: (stepId: string | null) => void;
  handleDeleteGraphObjectPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  stopGraphControlEvent: (event: SyntheticEvent<HTMLElement>) => void;
}): JSX.Element {
  return (
    <div key="graph-canvas-edit-tools-layer" style={graphCanvasEditToolLayerStyle}>
      <div
        key="graph-canvas-edit-tools"
        data-graph-toolbar="true"
        style={graphCanvasEditToolDockStyle}
        onPointerDown={stopGraphControlEvent}
        onPointerUp={stopGraphControlEvent}
        onClick={stopGraphControlEvent}
      >
        <div key="object-tools" aria-label="Object editing tools" style={graphCanvasToolGroupStyle}>
          <span style={graphCanvasToolLabelStyle}>Edit</span>
          <button type="button" style={graphCanvasToolButtonStyle} title="Add downstream step" aria-label="Add downstream step" onClick={() => addAfter(selectedStep?.id ?? null)}>
            +
          </button>
          <button
            type="button"
            style={selectedStep || selectedEdgeActionAnchor ? { ...graphCanvasToolButtonStyle, color: "var(--destructive, #ef4444)" } : { ...graphCanvasToolButtonStyle, ...buttonDisabledStyle }}
            title={selectedEdgeActionAnchor ? "Delete selected relationship" : "Delete selected step"}
            aria-label={selectedEdgeActionAnchor ? "Delete selected relationship" : "Delete selected step"}
            disabled={!selectedStep && !selectedEdgeActionAnchor}
            onPointerDown={handleDeleteGraphObjectPointerDown}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            -
          </button>
        </div>
      </div>
    </div>
  );
}

export function GraphCanvasViewTools({
  canvasScale,
  selectedStep,
  setCanvasScaleFromPoint,
  runWorkbenchAction,
}: {
  canvasScale: number;
  selectedStep: StepDraft | null;
  setCanvasScaleFromPoint: (nextScale: number, clientX?: number, clientY?: number) => void;
  runWorkbenchAction: (actionId: string) => void;
}): JSX.Element {
  return (
    <div key="graph-canvas-view-tools-layer" style={graphCanvasViewToolLayerStyle}>
      <div key="graph-canvas-view-tools" data-graph-toolbar="true" style={graphCanvasViewToolDockStyle}>
        <div key="view-tools" aria-label="Canvas view tools" style={graphCanvasToolGroupStyle}>
          <span style={graphCanvasToolLabelStyle}>View</span>
          <button type="button" style={graphCanvasToolButtonStyle} title="Zoom out" aria-label="Zoom out" onClick={() => setCanvasScaleFromPoint(canvasScale - 0.1)}>
            <GraphZoomIcon direction="out" />
          </button>
          <button type="button" style={graphCanvasToolButtonStyle} title="Zoom in" aria-label="Zoom in" onClick={() => setCanvasScaleFromPoint(canvasScale + 0.1)}>
            <GraphZoomIcon direction="in" />
          </button>
          <button type="button" style={graphCanvasToolButtonStyle} title="Fit canvas" aria-label="Fit canvas" onClick={() => runWorkbenchAction("fit-canvas")}>
            F
          </button>
          <button type="button" style={graphCanvasToolButtonStyle} title="Center selected" aria-label="Center selected" onClick={() => runWorkbenchAction("center-selected")} disabled={!selectedStep}>
            C
          </button>
        </div>
      </div>
    </div>
  );
}
