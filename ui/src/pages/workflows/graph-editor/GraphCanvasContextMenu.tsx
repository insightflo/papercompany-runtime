import { Fragment, type JSX, type SyntheticEvent } from "react";
import { buttonDisabledStyle } from "../workflow-page-styles.js";
import { graphContextMenuButtonStyle, graphContextMenuStyle } from "./graphStyles.js";
import type { GraphContextMenuState } from "./graphUiUtils.js";

export function GraphCanvasContextMenu({
  graphContextMenu,
  availableTools,
  stopGraphControlEvent,
  runNodeContextAction,
  runEdgeContextAction,
  runCanvasContextAction,
}: {
  graphContextMenu: GraphContextMenuState | null;
  availableTools: { name: string }[];
  stopGraphControlEvent: (event: SyntheticEvent<HTMLElement>) => void;
  runNodeContextAction: (actionId: string, stepId: string) => void;
  runEdgeContextAction: (actionId: string, sourceId: string, targetId: string) => void;
  runCanvasContextAction: (actionId: string) => void;
}): JSX.Element {
  return graphContextMenu ? (
    <div
      key="graph-context-menu"
      data-graph-menu="true"
      style={{ ...graphContextMenuStyle, left: graphContextMenu.clientX, top: graphContextMenu.clientY }}
      onPointerDown={stopGraphControlEvent}
      onPointerUp={stopGraphControlEvent}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {graphContextMenu.kind === "node" && graphContextMenu.stepId ? (
        <Fragment key="node-menu">
          <button type="button" style={graphContextMenuButtonStyle} onClick={() => runNodeContextAction("add-downstream", graphContextMenu.stepId || "")}>Add downstream<span>+</span></button>
          <button type="button" style={graphContextMenuButtonStyle} onClick={() => runNodeContextAction("duplicate", graphContextMenu.stepId || "")}>Duplicate<span>2x</span></button>
          <button type="button" style={{ ...graphContextMenuButtonStyle, color: "var(--destructive, #ef4444)" }} onClick={() => runNodeContextAction("delete", graphContextMenu.stepId || "")}>Delete<span>Del</span></button>
          <button type="button" style={graphContextMenuButtonStyle} onClick={() => runNodeContextAction("center", graphContextMenu.stepId || "")}>Center<span>C</span></button>
          <button type="button" style={graphContextMenuButtonStyle} onClick={() => runNodeContextAction("select-upstream", graphContextMenu.stepId || "")}>Select upstream<span>U</span></button>
          <button type="button" style={graphContextMenuButtonStyle} onClick={() => runNodeContextAction("select-downstream", graphContextMenu.stepId || "")}>Select downstream<span>D</span></button>
          <button type="button" style={graphContextMenuButtonStyle} onClick={() => runNodeContextAction("select-connected", graphContextMenu.stepId || "")}>Select connected<span>A</span></button>
        </Fragment>
      ) : graphContextMenu.kind === "edge" && graphContextMenu.sourceId && graphContextMenu.targetId ? (
        <Fragment key="edge-menu">
          <button type="button" style={{ ...graphContextMenuButtonStyle, color: "var(--destructive, #ef4444)" }} onClick={() => runEdgeContextAction("remove-edge", graphContextMenu.sourceId || "", graphContextMenu.targetId || "")}>Remove relationship<span>-</span></button>
          <button type="button" style={graphContextMenuButtonStyle} onClick={() => runEdgeContextAction("select-source", graphContextMenu.sourceId || "", graphContextMenu.targetId || "")}>Select source<span>Src</span></button>
          <button type="button" style={graphContextMenuButtonStyle} onClick={() => runEdgeContextAction("select-target", graphContextMenu.sourceId || "", graphContextMenu.targetId || "")}>Select target<span>Tgt</span></button>
        </Fragment>
      ) : (
        <Fragment key="canvas-menu">
          <button type="button" style={graphContextMenuButtonStyle} onClick={() => runCanvasContextAction("agent")}>Add Agent<span>+</span></button>
          <button
            type="button"
            style={availableTools.length === 0 ? { ...graphContextMenuButtonStyle, ...buttonDisabledStyle } : graphContextMenuButtonStyle}
            disabled={availableTools.length === 0}
            onClick={() => runCanvasContextAction("tool")}
          >Add Tool<span>+</span></button>
          <button type="button" style={graphContextMenuButtonStyle} onClick={() => runCanvasContextAction("branch")}>Add Branch<span>B</span></button>
          <button type="button" style={graphContextMenuButtonStyle} onClick={() => runCanvasContextAction("loop")}>Add Loop<span>L</span></button>
          <button type="button" style={graphContextMenuButtonStyle} onClick={() => runCanvasContextAction("approval")}>Add Approval<span>A</span></button>
          <button type="button" style={graphContextMenuButtonStyle} onClick={() => runCanvasContextAction("fit-canvas")}>Fit canvas<span>F</span></button>
          <button type="button" style={graphContextMenuButtonStyle} onClick={() => runCanvasContextAction("actual-size")}>Actual size<span>1</span></button>
        </Fragment>
      )}
    </div>
  ) : (
    <Fragment key="graph-context-menu-placeholder" />
  );
}
