// [파일 목적] 워크플로우 그래프 에디터의 캔버스(노드/엣지 SVG, 팬/줌/드래그/클릭/컨텍스트 메뉴)를
// 렌더링하는 프레젠테이션 컴포넌트. 모든 상태와 핸들러는 부모(WorkflowGraphEditor 코디네이터)가
// 소유하며 이 컴포넌트는 props로 전달받은 값/콜백만 사용한다.
// [주요 흐름] graph-workbench-main 래퍼 안에 (1) 편집 툴 독, (2) 컨텍스트 메뉴, (3) 컨테이너/그룹/엣지/노드
// SVG 레이어, (4) 보기 툴 독, (5) 상태 스트립을 그린다.
// [외부 연결] ../workflow-graph.js(모델/타입), ./graphStyles.js, ./graphUiUtils.js, ./GraphToolbar.js,
// ../workflow-page-styles.js, react.
// [수정시 주의] 캔버스 전용 상태(pan/scale/drag)는 절대 여기서 만들지 말고 코디네이터에서 props로 넘길 것.
// 루트 Workflows.tsx를 역참조(import)하지 말 것.
import * as React from "react";
import { Fragment, type JSX } from "react";
import type { StepDraft } from "../step-draft.js";
import {
  type WorkflowGraphContainerSummary,
  type WorkflowGraphEdge,
  type WorkflowGraphModel,
  type WorkflowGraphWorkbenchSummary,
} from "../workflow-graph.js";
import { buttonDisabledStyle, graphPolicyBadgeStyle, statusBadgeStyle } from "../workflow-page-styles.js";
import {
  graphCanvasEditToolDockStyle,
  graphCanvasEditToolLayerStyle,
  graphCanvasStyle,
  graphCanvasToolButtonStyle,
  graphCanvasToolGroupStyle,
  graphCanvasToolLabelStyle,
  graphCanvasViewToolDockStyle,
  graphCanvasViewToolLayerStyle,
  graphContextMenuButtonStyle,
  graphContextMenuStyle,
  graphEdgeRemoveButtonStyle,
  graphNodeInputHandleStyle,
  graphNodeOutputHandleStyle,
  graphNodeStyle,
  graphStatusStripStyle,
  graphWorkbenchMainStyle,
} from "./graphStyles.js";
import {
  containerColor,
  graphEdgeColor,
  graphEdgeDashArray,
  graphEdgeDisplayLabel,
  type GraphContextMenuState,
  type GraphEdgeActionAnchor,
} from "./graphUiUtils.js";
import { GraphZoomIcon } from "./GraphToolbar.js";

export interface GraphCanvasProps {
  graph: WorkflowGraphModel;
  canvasWidth: number;
  canvasHeight: number;
  canvasScale: number;
  canvasPanX: number;
  canvasPanY: number;
  isCanvasPanning: boolean;
  draggingStepId: string | null;
  connectingFromStepId: string | null;
  graphCanvasRef: React.RefObject<HTMLDivElement | null>;
  selectedStep: StepDraft | null;
  selectedEdgeId: string | null;
  selectedEdgeActionAnchor: GraphEdgeActionAnchor | null;
  graphContextMenu: GraphContextMenuState | null;
  selectedContainerSummary: WorkflowGraphContainerSummary | null;
  selectedPathNodeIds: Set<string>;
  matchingNodeIds: Set<string>;
  availableTools: { name: string }[];
  workbenchSummary: WorkflowGraphWorkbenchSummary;
  // handlers
  beginCanvasPan: (event: React.PointerEvent<HTMLDivElement>) => void;
  handleCanvasPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  endCanvasPan: (event: React.PointerEvent<HTMLDivElement>) => void;
  handleCanvasClick: () => void;
  handleCanvasContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
  stopGraphControlEvent: (event: React.SyntheticEvent<HTMLElement>) => void;
  handleEdgeClick: (event: React.MouseEvent<Element>, edge: WorkflowGraphEdge) => void;
  handleEdgeContextMenu: (event: React.MouseEvent<Element>, edge: WorkflowGraphEdge) => void;
  beginNodeDrag: (event: React.PointerEvent<HTMLButtonElement>, stepId: string, x: number, y: number) => void;
  handleNodePointerMove: (event: React.PointerEvent<HTMLButtonElement>) => void;
  endNodeDrag: (event: React.PointerEvent<HTMLButtonElement>) => void;
  handleNodeClick: (event: React.MouseEvent<HTMLButtonElement>, stepId: string) => void;
  handleNodeContextMenu: (event: React.MouseEvent<HTMLElement>, stepId: string) => void;
  beginEdgeConnection: (event: React.PointerEvent<HTMLElement>, sourceId: string) => void;
  completeEdgeConnection: (event: React.PointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>, targetId: string) => void;
  disconnect: (sourceId: string, targetId: string) => void;
  setCanvasScaleFromPoint: (nextScale: number, clientX?: number, clientY?: number) => void;
  runWorkbenchAction: (actionId: string) => void;
  runNodeContextAction: (actionId: string, stepId: string) => void;
  runEdgeContextAction: (actionId: string, sourceId: string, targetId: string) => void;
  runCanvasContextAction: (actionId: string) => void;
  addAfter: (stepId: string | null) => void;
  handleDeleteGraphObjectPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
}

// [목적] 워크플로우 그래프 캔버스(노드/엣지/팬/줌/컨텍스트 메뉴) 렌더.
// [입력] GraphCanvasProps — 코디네이터가 소유한 상태/파생값/핸들러.
// [출력] JSX.Element (graph-workbench-main 래퍼).
// [연결] WorkflowGraphEditor 코디네이터가 렌더.
// [주의] 상태를 직접 생성하지 말 것. 동작 변경 없이 props 기반 렌더만 수행.
export function GraphCanvas({
  graph,
  canvasWidth,
  canvasHeight,
  canvasScale,
  canvasPanX,
  canvasPanY,
  isCanvasPanning,
  draggingStepId,
  connectingFromStepId,
  graphCanvasRef,
  selectedStep,
  selectedEdgeId,
  selectedEdgeActionAnchor,
  graphContextMenu,
  selectedContainerSummary,
  selectedPathNodeIds,
  matchingNodeIds,
  availableTools,
  workbenchSummary,
  beginCanvasPan,
  handleCanvasPointerMove,
  endCanvasPan,
  handleCanvasClick,
  handleCanvasContextMenu,
  stopGraphControlEvent,
  handleEdgeClick,
  handleEdgeContextMenu,
  beginNodeDrag,
  handleNodePointerMove,
  endNodeDrag,
  handleNodeClick,
  handleNodeContextMenu,
  beginEdgeConnection,
  completeEdgeConnection,
  disconnect,
  setCanvasScaleFromPoint,
  runWorkbenchAction,
  runNodeContextAction,
  runEdgeContextAction,
  runCanvasContextAction,
  addAfter,
  handleDeleteGraphObjectPointerDown,
}: GraphCanvasProps): JSX.Element {
  const statusStripAccentColor = "#38bdf8";
  return (
    <div key="graph-workbench-main" style={graphWorkbenchMainStyle}>
      <div
        key="graph-canvas"
        ref={graphCanvasRef}
        style={{ ...graphCanvasStyle, cursor: isCanvasPanning ? "grabbing" : "grab" }}
        onPointerDown={beginCanvasPan}
        onPointerMove={handleCanvasPointerMove}
        onPointerUp={endCanvasPan}
        onPointerCancel={endCanvasPan}
        onContextMenu={handleCanvasContextMenu}
        onClick={handleCanvasClick}
      >
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
        {graphContextMenu ? (
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
        )}
        <div
          key="graph-canvas-inner"
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
          }}
        >
        <div
          key="graph-canvas-content"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: `${canvasWidth}px`,
            height: `${canvasHeight}px`,
            overflow: "visible",
            transform: `translate(${canvasPanX}px, ${canvasPanY}px) scale(${canvasScale})`,
            transformOrigin: "0 0",
            transition: draggingStepId || isCanvasPanning ? "none" : "transform 140ms ease",
            pointerEvents: "none",
          }}
        >
          <div key="graph-containers" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            {graph.containers.map((container) => {
              const color = containerColor(container.type);
              const selected = selectedContainerSummary?.id === container.id;
              return (
                <button
                  key={container.id}
                  type="button"
                  aria-label={`Select ${container.type} container ${container.title}`}
                  style={{
                    position: "absolute",
                    left: container.x,
                    top: container.y,
                    width: container.width,
                    height: container.height,
                    padding: 0,
                    border: `${selected ? "2px solid" : "1px dashed"} ${color}`,
                    borderRadius: "8px",
                    background: `color-mix(in srgb, ${color} 8%, transparent)`,
                    boxShadow: selected ? `0 0 0 2px color-mix(in srgb, ${color} 24%, transparent)` : "none",
                    cursor: "pointer",
                    pointerEvents: "auto",
                    textAlign: "left",
                  }}
                >
                  <div
                    key="container-label"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      maxWidth: "calc(100% - 16px)",
                      margin: "6px",
                      padding: "3px 7px",
                      borderRadius: "6px",
                      background: "var(--background, #020617)",
                      color,
                      fontSize: "11px",
                      fontWeight: 700,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span key="type" style={{ textTransform: "uppercase" }}>{container.type}</span>
                    <span key="title">{container.title}</span>
                  </div>
                  {container.description ? (
                    <div
                      key="description"
                      style={{
                        margin: "0 8px",
                        maxWidth: "calc(100% - 16px)",
                        color: "var(--muted-foreground, #94a3b8)",
                        fontSize: "11px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {container.description}
                    </div>
                  ) : (
                    <Fragment key="description-placeholder" />
                  )}
                  {container.badges.length > 0 ? (
                    <div key="badges" style={{ display: "flex", flexWrap: "wrap", gap: "4px", margin: "6px 8px 0" }}>
                      {container.badges.map((badge) => (
                        <span key={badge} style={{ ...graphPolicyBadgeStyle, color }}>{badge}</span>
                      ))}
                    </div>
                  ) : (
                    <Fragment key="badges-placeholder" />
                  )}
                </button>
              );
            })}
          </div>
          <div key="graph-groups" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            {graph.groups.filter((group) => !group.collapsed).map((group) => (
              <div
                key={group.id}
                style={{
                  position: "absolute",
                  left: group.x,
                  top: group.y,
                  width: group.width,
                  height: group.height,
                  border: `1px solid ${group.color}`,
                  borderRadius: "8px",
                  background: `color-mix(in srgb, ${group.color} 10%, transparent)`,
                  pointerEvents: "none",
                }}
              >
                <div
                  style={{
                    display: "inline-flex",
                    maxWidth: "calc(100% - 16px)",
                    margin: "6px",
                    padding: "3px 7px",
                    borderRadius: "6px",
                    background: "var(--background, #020617)",
                    color: group.color,
                    fontSize: "11px",
                    fontWeight: 700,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {group.title}
                </div>
              </div>
            ))}
          </div>
          <svg
            key="graph-edges"
            aria-hidden="true"
            width={canvasWidth}
            height={canvasHeight}
            style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "auto" }}
          >
            <defs>
              <marker id="workflow-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 Z" fill="var(--muted-foreground, #94a3b8)" />
              </marker>
            </defs>
            <g key="edge-paths">
              {graph.edges.map((edge) => {
                const source = graph.nodes.find((node) => node.id === edge.source);
                const target = graph.nodes.find((node) => node.id === edge.target);
                if (!source || !target) return null;
                const startX = source.x + 172;
                const startY = source.y + 38;
                const endX = target.x;
                const endY = target.y + 38;
                const midX = startX + Math.max(34, (endX - startX) / 2);
                const edgePath = `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX - 8} ${endY}`;
                const selected = selectedEdgeId === edge.id;
                return (
                  <g key={edge.id}>
                    <path
                      data-graph-edge="true"
                      data-edge-id={edge.id}
                      d={edgePath}
                      fill="none"
                      stroke="transparent"
                      strokeWidth="16"
                      pointerEvents="stroke"
                      style={{ cursor: "pointer" }}
                      onClick={(event) => handleEdgeClick(event, edge)}
                      onContextMenu={(event) => handleEdgeContextMenu(event, edge)}
                    />
                    <path
                      d={edgePath}
                      fill="none"
                      stroke={graphEdgeColor(edge.kind)}
                      strokeWidth={selected ? "3" : edge.kind === "failure" ? "2" : "1.5"}
                      strokeDasharray={graphEdgeDashArray(edge.kind)}
                      markerEnd="url(#workflow-arrow)"
                      pointerEvents="none"
                    />
                    {graphEdgeDisplayLabel(edge) ? (
                      <text
                        x={midX}
                        y={(startY + endY) / 2 - 6}
                        fill={graphEdgeColor(edge.kind)}
                        fontSize="11"
                        fontWeight="700"
                        textAnchor="middle"
                        pointerEvents="none"
                      >
                        {graphEdgeDisplayLabel(edge)}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </g>
          </svg>
          {selectedEdgeActionAnchor ? (
            <button
              key="graph-edge-remove"
              type="button"
              data-graph-edge-remove="true"
              aria-label={`Remove relationship from ${selectedEdgeActionAnchor.edge.source} to ${selectedEdgeActionAnchor.edge.target}`}
              title="Remove relationship"
              style={{
                ...graphEdgeRemoveButtonStyle,
                left: selectedEdgeActionAnchor.x - 11,
                top: selectedEdgeActionAnchor.y - 11,
              }}
              onPointerDown={stopGraphControlEvent}
              onPointerUp={stopGraphControlEvent}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                disconnect(selectedEdgeActionAnchor.edge.source, selectedEdgeActionAnchor.edge.target);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                handleEdgeContextMenu(event, selectedEdgeActionAnchor.edge);
              }}
            >
              -
            </button>
          ) : (
            <Fragment key="graph-edge-remove-placeholder" />
          )}
          <div key="graph-nodes" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            {graph.nodes.map((node) => {
              const selected = selectedStep?.id === node.step.id;
              const matched = matchingNodeIds.has(node.id);
              const inSelection = !selected && selectedPathNodeIds.has(node.id);
              const showNodeMetadata = selected || matched || inSelection;
              return (
                <button
                  key={node.id || node.order}
                  type="button"
                  data-graph-node="true"
                  style={{
                    ...graphNodeStyle(selected, node.kind, matched, inSelection),
                    left: node.x,
                    top: node.y,
                    cursor: draggingStepId === node.step.id ? "grabbing" : "grab",
                    touchAction: "none",
                    pointerEvents: "auto",
                  }}
                  onPointerDown={(event) => beginNodeDrag(event, node.step.id, node.x, node.y)}
                  onPointerMove={handleNodePointerMove}
                  onPointerUp={endNodeDrag}
                  onPointerCancel={endNodeDrag}
                  onContextMenu={(event) => handleNodeContextMenu(event, node.step.id)}
                  onClick={(event) => handleNodeClick(event, node.step.id)}
                >
                  <span
                    key="input-handle"
                    data-graph-handle="true"
                    data-graph-handle-kind="input"
                    data-step-id={node.step.id}
                    title={connectingFromStepId ? `Connect to ${node.step.id}` : `Input: ${node.step.id}`}
                    aria-hidden="true"
                    style={graphNodeInputHandleStyle(Boolean(connectingFromStepId && connectingFromStepId !== node.step.id))}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onPointerUp={(event) => completeEdgeConnection(event, node.step.id)}
                    onClick={(event) => completeEdgeConnection(event, node.step.id)}
                  />
                  <span
                    key="output-handle"
                    data-graph-handle="true"
                    data-graph-handle-kind="output"
                    data-step-id={node.step.id}
                    title={`Start relationship from ${node.step.id}`}
                    aria-hidden="true"
                    style={graphNodeOutputHandleStyle(connectingFromStepId === node.step.id)}
                    onPointerDown={(event) => beginEdgeConnection(event, node.step.id)}
                    onPointerUp={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                  />
                  <span key="meta-row" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                    <span key="kind" style={{ fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", textTransform: "uppercase" }}>
                      {node.kind}
                    </span>
                    <span key="status" style={{ ...statusBadgeStyle(node.runStatus.status), fontSize: "10px" }}>
                      {node.runStatus.status}
                    </span>
                  </span>
                  <span key="label" style={{ display: "block", marginTop: "6px", fontSize: "13px", fontWeight: 700, overflowWrap: "anywhere" }}>
                    {node.label}
                  </span>
                  <span key="location" style={{ display: "block", marginTop: "4px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", overflowWrap: "anywhere" }}>
                    L{node.layer} · {node.id || "(no id)"}
                  </span>
                  {matched ? (
                    <span key="match" style={{ display: "block", marginTop: "5px", fontSize: "11px", color: "#fbbf24", fontWeight: 700 }}>
                      Search match
                    </span>
                  ) : (
                    <Fragment key="match-placeholder" />
                  )}
                  {inSelection ? (
                    <span key="selection" style={{ display: "block", marginTop: "5px", fontSize: "11px", color: "#22c55e", fontWeight: 700 }}>
                      Selected path
                    </span>
                  ) : (
                    <Fragment key="selection-placeholder" />
                  )}
                  {showNodeMetadata && node.advanced.badges.length > 0 ? (
                    <span key="badges" style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
                      {node.advanced.badges.map((badge) => (
                        <span key={badge} style={graphPolicyBadgeStyle}>{badge}</span>
                      ))}
                    </span>
                  ) : (
                    <Fragment key="badges-placeholder" />
                  )}
                  {showNodeMetadata && node.testing.badges.length > 0 ? (
                    <span key="testing-badges" style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
                      {node.testing.badges.map((badge) => (
                        <span key={badge} style={{ ...graphPolicyBadgeStyle, color: "#fbbf24" }}>{badge}</span>
                      ))}
                    </span>
                  ) : (
                    <Fragment key="testing-badges-placeholder" />
                  )}
                  {showNodeMetadata && node.execution.badges.length > 0 ? (
                    <span key="execution-badges" style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
                      {node.execution.badges.map((badge) => (
                        <span key={badge} style={{ ...graphPolicyBadgeStyle, color: "#38bdf8" }}>{badge}</span>
                      ))}
                    </span>
                  ) : (
                    <Fragment key="execution-badges-placeholder" />
                  )}
                  {showNodeMetadata && node.dataFlow.badges.length > 0 ? (
                    <span key="data-flow-badges" style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
                      {node.dataFlow.badges.map((badge) => (
                        <span key={badge} style={{ ...graphPolicyBadgeStyle, color: "#a78bfa" }}>{badge}</span>
                      ))}
                    </span>
                  ) : (
                    <Fragment key="data-flow-badges-placeholder" />
                  )}
                  {showNodeMetadata && node.resources.badges.length > 0 ? (
                    <span key="resource-badges" style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
                      {node.resources.badges.map((badge) => (
                        <span key={badge} style={{ ...graphPolicyBadgeStyle, color: "#34d399" }}>{badge}</span>
                      ))}
                    </span>
                  ) : (
                    <Fragment key="resource-badges-placeholder" />
                  )}
                  {showNodeMetadata && node.runStatus.runtimeBadges.length > 0 ? (
                    <span key="runtime-badges" style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
                      {node.runStatus.runtimeBadges.map((badge) => (
                        <span key={badge} style={{ ...graphPolicyBadgeStyle, color: "#f97316" }}>{badge}</span>
                      ))}
                    </span>
                  ) : (
                    <Fragment key="runtime-badges-placeholder" />
                  )}
                  {showNodeMetadata && node.runStatus.issueIdentifier ? (
                    <span key="issue" style={{ display: "block", marginTop: "5px", fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", overflowWrap: "anywhere" }}>
                      Issue: {node.runStatus.issueIdentifier}
                    </span>
                  ) : (
                    <Fragment key="issue-placeholder" />
                  )}
                  {showNodeMetadata && node.runStatus.summary ? (
                    <span key="summary" style={{ display: "block", marginTop: "5px", fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", overflowWrap: "anywhere" }}>
                      {node.runStatus.summary}
                    </span>
                  ) : (
                    <Fragment key="summary-placeholder" />
                  )}
                  {showNodeMetadata && typeof node.step.graphNote === "string" && node.step.graphNote.trim() ? (
                    <span key="note" style={{ display: "block", marginTop: "6px", fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", overflowWrap: "anywhere" }}>
                      Note: {node.step.graphNote.trim()}
                    </span>
                  ) : (
                    <Fragment key="note-placeholder" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
        </div>
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
      </div>
        <div key="graph-status-strip" style={graphStatusStripStyle}>
          <div key="path-summary" style={{ minWidth: 0, display: "flex", alignItems: "center", gap: "7px", color: "var(--muted-foreground, #94a3b8)", fontSize: "12px", overflow: "hidden" }}>
            <strong style={{ color: "var(--foreground, #f8fafc)", whiteSpace: "nowrap" }}>Selected path</strong>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{workbenchSummary.pathSummary}</span>
          </div>
          <div key="status-badges" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "5px", flexWrap: "wrap" }}>
            {workbenchSummary.statusBadges.map((badge) => (
              <span key={badge} style={{ ...graphPolicyBadgeStyle, color: badge.includes("error") && !badge.startsWith("0 ") ? "var(--destructive, #ef4444)" : statusStripAccentColor }}>{badge}</span>
            ))}
            <span key="canvas-scale" style={{ ...graphPolicyBadgeStyle, color: "#a78bfa" }}>{Math.round(canvasScale * 100)}%</span>
          </div>
        </div>
    </div>
  );
}
