import * as React from "react";
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { openWorkProductInBrowser } from "../../../lib/workProductOpen.js";
import { buildIssueHref } from "../routes.js";
import { currentBrowserPathname } from "../shared-controls.js";
import { buildWorkflowGraphModel, getWorkflowGraphStepContext, type WorkflowGraphStep, type WorkflowGraphWorkProduct } from "../workflow-graph.js";
import { buttonDisabledStyle, buttonStyle, graphPolicyBadgeStyle, mutedTextStyle, statusBadgeStyle } from "../workflow-page-styles.js";
import { formatDateTime } from "../workflow-page-api.js";
import { graphCanvasStyle, graphCanvasToolButtonStyle, graphCanvasToolGroupStyle, graphCanvasToolLabelStyle, graphCanvasViewToolDockStyle, graphCanvasViewToolLayerStyle, graphNodeStyle, graphSidebarStyle } from "./graphStyles.js";
import { containerColor, graphEdgeColor, graphEdgeDashArray, graphEdgeDisplayLabel, type GraphCanvasPanState } from "./graphUiUtils.js";

function clampGraphCanvasScale(value: number): number {
  return Math.min(1.8, Math.max(0.45, value));
}

export function WorkflowRunGraphPreview({
  steps,
  pendingStepRunId,
  onRerunStep,
}: {
  steps: WorkflowGraphStep[];
  pendingStepRunId?: string | null;
  onRerunStep?: (input: { stepId: string; stepRunId: string; issueId: string }) => void;
}): JSX.Element | null {
  const graph = useMemo(() => buildWorkflowGraphModel(steps), [steps]);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [canvasScale, setCanvasScale] = useState(1);
  const [isCanvasPanning, setIsCanvasPanning] = useState(false);
  const [canvasPanX, setCanvasPanX] = useState(0);
  const [canvasPanY, setCanvasPanY] = useState(0);
  const [nodeDragOffsets, setNodeDragOffsets] = useState<Record<string, { dx: number; dy: number }>>({});
  const [draggingStepId, setDraggingStepId] = useState<string | null>(null);
  const [openingWorkProductId, setOpeningWorkProductId] = useState<string | null>(null);
  const [openedWorkProductId, setOpenedWorkProductId] = useState<string | null>(null);
  const [workProductOpenError, setWorkProductOpenError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const canvasPanRef = useRef<GraphCanvasPanState | null>(null);
  const nodeDragRef = useRef<{ stepId: string; pointerId: number; startClientX: number; startClientY: number; startDx: number; startDy: number; moved: boolean } | null>(null);
  const suppressNodeClickRef = useRef<string | null>(null);
  if (steps.length === 0 || graph.nodes.length === 0) return null;

  const selectedNode = graph.nodes.find((node) => node.step.id === selectedStepId)
    ?? graph.nodes.find((node) => node.runStatus.status === "failed")
    ?? graph.nodes.find((node) => node.runStatus.status === "running")
    ?? graph.nodes[0];
  const selectedGraphContext = selectedNode ? getWorkflowGraphStepContext(steps, selectedNode.step.id) : null;
  const canRerunSelected = Boolean(onRerunStep && selectedNode?.runStatus.stepRunId);
  const selectedPending = Boolean(selectedNode?.runStatus.stepRunId && pendingStepRunId === selectedNode.runStatus.stepRunId);
  const canvasWidth = Math.max(620, ...graph.nodes.map((node) => {
    const off = nodeDragOffsets[node.step.id];
    return node.x + (off?.dx ?? 0) + 230;
  }), 620);
  const canvasHeight = Math.max(260, ...graph.nodes.map((node) => {
    const off = nodeDragOffsets[node.step.id];
    return node.y + (off?.dy ?? 0) + 132;
  }), 260);

  async function handleOpenWorkProduct(product: WorkflowGraphWorkProduct): Promise<void> {
    setOpeningWorkProductId(product.id);
    setOpenedWorkProductId(null);
    setWorkProductOpenError(null);
    try {
      await openWorkProductInBrowser(product.id);
      setOpenedWorkProductId(product.id);
    } catch (error) {
      setWorkProductOpenError(error instanceof Error ? error.message : "Failed to open work product");
    } finally {
      setOpeningWorkProductId(null);
    }
  }

  function getNodeOffset(stepId: string): { dx: number; dy: number } {
    return nodeDragOffsets[stepId] ?? { dx: 0, dy: 0 };
  }

  function beginRunNodeDrag(event: React.PointerEvent<HTMLButtonElement>, stepId: string): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const current = getNodeOffset(stepId);
    nodeDragRef.current = {
      stepId,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startDx: current.dx,
      startDy: current.dy,
      moved: false,
    };
    setDraggingStepId(stepId);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleRunNodePointerMove(event: React.PointerEvent<HTMLButtonElement>): void {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = (event.clientX - drag.startClientX) / canvasScale;
    const deltaY = (event.clientY - drag.startClientY) / canvasScale;
    if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) drag.moved = true;
    setNodeDragOffsets((prev) => ({
      ...prev,
      [drag.stepId]: { dx: drag.startDx + deltaX, dy: drag.startDy + deltaY },
    }));
  }

  function endRunNodeDrag(event: React.PointerEvent<HTMLButtonElement>): void {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) suppressNodeClickRef.current = drag.stepId;
    nodeDragRef.current = null;
    setDraggingStepId(null);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* noop */ }
  }

  function handleRunNodeClick(event: React.MouseEvent<HTMLButtonElement>, stepId: string): void {
    if (suppressNodeClickRef.current === stepId) {
      suppressNodeClickRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    setSelectedStepId(stepId);
  }

  useEffect(() => {
    const container = canvasRef.current;
    if (!container) return undefined;
    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const direction = event.deltaY > 0 ? -1 : 1;
      const nextScale = clampGraphCanvasScale(canvasScale + direction * 0.1);
      const rect = container.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      const graphX = (-canvasPanX + offsetX) / canvasScale;
      const graphY = (-canvasPanY + offsetY) / canvasScale;
      setCanvasScale(nextScale);
      setCanvasPanX(offsetX - graphX * nextScale);
      setCanvasPanY(offsetY - graphY * nextScale);
    };
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [canvasScale, canvasPanX, canvasPanY]);

  function beginCanvasPan(event: React.PointerEvent<HTMLDivElement>): void {
    const target = event.target as HTMLElement;
    if (target.closest("[data-graph-node='true'], [data-graph-toolbar='true'], [data-graph-menu='true'], [data-graph-edge='true'], [data-graph-handle='true'], [data-graph-edge-remove='true']")) return;
    if (event.button !== 0 && event.button !== 1) return;
    canvasPanRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPanX: canvasPanX,
      startPanY: canvasPanY,
    };
    setIsCanvasPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleCanvasPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const pan = canvasPanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    setCanvasPanX(pan.startPanX + (event.clientX - pan.startClientX));
    setCanvasPanY(pan.startPanY + (event.clientY - pan.startClientY));
  }

  function endCanvasPan(event: React.PointerEvent<HTMLDivElement>): void {
    const pan = canvasPanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    canvasPanRef.current = null;
    setIsCanvasPanning(false);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* noop */ }
  }

  return (
    <div style={{ display: "grid", gap: "8px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
        <span style={{ ...mutedTextStyle, fontWeight: 600 }}>Run graph</span>
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          {(["planned", "running", "succeeded", "failed", "skipped", "paused"] as const).map((status) => (
            <span key={status} style={{ ...statusBadgeStyle(status), fontSize: "10px" }}>{status}</span>
          ))}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(420px, 1fr) 260px", gap: "10px", alignItems: "stretch" }}>
        <div
          ref={canvasRef}
          style={{ ...graphCanvasStyle, minHeight: "260px", cursor: isCanvasPanning ? "grabbing" : "grab" }}
          onPointerDown={beginCanvasPan}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={endCanvasPan}
          onPointerCancel={endCanvasPan}
        >
          <div key="run-graph-view-tools-layer" style={graphCanvasViewToolLayerStyle}>
            <div key="run-graph-view-tools" data-graph-toolbar="true" style={graphCanvasViewToolDockStyle}>
              <div key="view-tools" aria-label="Canvas view tools" style={graphCanvasToolGroupStyle}>
                <span style={graphCanvasToolLabelStyle}>View</span>
                <button type="button" style={graphCanvasToolButtonStyle} title="Zoom out" aria-label="Zoom out" onClick={() => setCanvasScale(clampGraphCanvasScale(canvasScale - 0.1))}>&minus;</button>
                <span style={{ fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", minWidth: "32px", textAlign: "center" }}>{Math.round(canvasScale * 100)}%</span>
                <button type="button" style={graphCanvasToolButtonStyle} title="Zoom in" aria-label="Zoom in" onClick={() => setCanvasScale(clampGraphCanvasScale(canvasScale + 0.1))}>+</button>
                <button type="button" style={graphCanvasToolButtonStyle} title="Reset zoom" aria-label="Reset zoom" onClick={() => { setCanvasScale(1); setCanvasPanX(0); setCanvasPanY(0); }}>&#8634;</button>
              </div>
            </div>
          </div>
          <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          <div style={{ position: "absolute", top: 0, left: 0, width: `${canvasWidth}px`, height: `${canvasHeight}px`, overflow: "visible", transform: `translate(${canvasPanX}px, ${canvasPanY}px) scale(${canvasScale})`, transformOrigin: "0 0", transition: isCanvasPanning ? "none" : "transform 140ms ease", pointerEvents: "none" }}>
          {graph.containers.map((container) => {
            const color = containerColor(container.type);
            return (
              <div
                key={container.id}
                style={{
                  position: "absolute",
                  left: container.x,
                  top: container.y,
                  width: container.width,
                  height: container.height,
                  border: `1px dashed ${color}`,
                  borderRadius: "8px",
                  background: `color-mix(in srgb, ${color} 8%, transparent)`,
                  pointerEvents: "none",
                }}
              >
                <div
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
                  <span style={{ textTransform: "uppercase" }}>{container.type}</span>
                  <span>{container.title}</span>
                </div>
                {container.badges.length > 0 ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", margin: "0 8px" }}>
                    {container.badges.map((badge) => (
                      <span key={badge} style={{ ...graphPolicyBadgeStyle, color }}>{badge}</span>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
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
          <svg
            aria-hidden="true"
            width={canvasWidth}
            height={canvasHeight}
            style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }}
          >
            <defs>
              <marker id="workflow-run-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 Z" fill="var(--muted-foreground, #94a3b8)" />
              </marker>
            </defs>
            {graph.edges.map((edge) => {
              const source = graph.nodes.find((node) => node.id === edge.source);
              const target = graph.nodes.find((node) => node.id === edge.target);
              if (!source || !target) return null;
              const sOff = getNodeOffset(source.step.id);
              const tOff = getNodeOffset(target.step.id);
              const startX = source.x + sOff.dx + 172;
              const startY = source.y + sOff.dy + 38;
              const endX = target.x + tOff.dx;
              const endY = target.y + tOff.dy + 38;
              const midX = startX + Math.max(34, (endX - startX) / 2);
              return (
                <g key={edge.id}>
                  <path
                    d={`M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX - 8} ${endY}`}
                    fill="none"
                    stroke={graphEdgeColor(edge.kind)}
                    strokeWidth={edge.kind === "failure" ? "2" : "1.5"}
                    strokeDasharray={graphEdgeDashArray(edge.kind)}
                    markerEnd="url(#workflow-run-arrow)"
                  />
                  {graphEdgeDisplayLabel(edge) ? (
                    <text
                      x={midX}
                      y={(startY + endY) / 2 - 6}
                      fill={graphEdgeColor(edge.kind)}
                      fontSize="11"
                      fontWeight="700"
                      textAnchor="middle"
                    >
                      {graphEdgeDisplayLabel(edge)}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
            {graph.nodes.map((node) => {
              const selected = selectedNode?.step.id === node.step.id;
              const off = getNodeOffset(node.step.id);
              return (
            <button
              key={node.id || node.order}
              type="button"
              style={{ ...graphNodeStyle(selected, node.kind), left: node.x + off.dx, top: node.y + off.dy, cursor: draggingStepId === node.step.id ? "grabbing" : "grab", touchAction: "none", pointerEvents: "auto" }}
              onPointerDown={(event) => beginRunNodeDrag(event, node.step.id)}
              onPointerMove={handleRunNodePointerMove}
              onPointerUp={endRunNodeDrag}
              onPointerCancel={endRunNodeDrag}
              onClick={(event) => handleRunNodeClick(event, node.step.id)}
            >
              <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                <span style={{ fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", textTransform: "uppercase" }}>
                  {node.kind}
                </span>
                <span style={{ ...statusBadgeStyle(node.runStatus.status), fontSize: "10px" }}>
                  {node.runStatus.status}
                </span>
              </span>
              <span style={{ display: "block", marginTop: "6px", fontSize: "13px", fontWeight: 700, overflowWrap: "anywhere" }}>
                {node.label}
              </span>
              <span style={{ display: "block", marginTop: "4px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", overflowWrap: "anywhere" }}>
                L{node.layer} · {node.id || "(no id)"}
              </span>
              {node.advanced.badges.length > 0 ? (
                <span style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
                  {node.advanced.badges.map((badge) => (
                    <span key={badge} style={graphPolicyBadgeStyle}>{badge}</span>
                  ))}
                </span>
              ) : null}
              {node.dataFlow.badges.length > 0 ? (
                <span style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
                  {node.dataFlow.badges.map((badge) => (
                    <span key={badge} style={{ ...graphPolicyBadgeStyle, color: "#a78bfa" }}>{badge}</span>
                  ))}
                </span>
              ) : null}
              {node.resources.badges.length > 0 ? (
                <span style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
                  {node.resources.badges.map((badge) => (
                    <span key={badge} style={{ ...graphPolicyBadgeStyle, color: "#34d399" }}>{badge}</span>
                  ))}
                </span>
              ) : null}
              {node.runStatus.runtimeBadges.length > 0 ? (
                <span style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
                  {node.runStatus.runtimeBadges.map((badge) => (
                    <span key={badge} style={{ ...graphPolicyBadgeStyle, color: "#f97316" }}>{badge}</span>
                  ))}
                </span>
              ) : null}
              {node.runStatus.issueIdentifier ? (
                <span style={{ display: "block", marginTop: "5px", fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", overflowWrap: "anywhere" }}>
                  Issue: {node.runStatus.issueIdentifier}
                </span>
              ) : null}
              {node.runStatus.workProducts.length > 0 ? (
                <span style={{ display: "block", marginTop: "5px", fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", overflowWrap: "anywhere" }}>
                  Outputs: {node.runStatus.workProducts.length}
                </span>
              ) : null}
              {node.runStatus.updatedAt ? (
                <span style={{ display: "block", marginTop: "5px", fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", overflowWrap: "anywhere" }}>
                  {formatDateTime(node.runStatus.updatedAt)}
                </span>
              ) : null}
              {node.runStatus.summary ? (
                <span style={{ display: "block", marginTop: "5px", fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", overflowWrap: "anywhere" }}>
                  {node.runStatus.summary}
                </span>
              ) : null}
            </button>
              );
            })}
          </div>
          </div>
        </div>
        <div style={{ ...graphSidebarStyle, minHeight: "260px" }}>
          <div>
            <p style={{ ...mutedTextStyle, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Run graph actions
            </p>
            <p style={{ margin: "4px 0 0", fontSize: "14px", fontWeight: 700 }}>{selectedNode?.label ?? "none"}</p>
          </div>
          {selectedNode ? (
            <>
              <div style={{ display: "grid", gap: "5px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                  <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Status</span>
                  <span style={{ ...statusBadgeStyle(selectedNode.runStatus.status), fontSize: "10px" }}>
                    {selectedNode.runStatus.status}
                  </span>
                </div>
                <div style={{ display: "grid", gap: "2px" }}>
                  <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Step run</span>
                  <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", overflowWrap: "anywhere" }}>
                    {selectedNode.runStatus.stepRunId || "-"}
                  </span>
                </div>
                <div style={{ display: "grid", gap: "2px" }}>
                  <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Issue</span>
                  {selectedNode.runStatus.issueId ? (
                    <a
                      href={buildIssueHref({
                        issueId: selectedNode.runStatus.issueId,
                        issueIdentifier: selectedNode.runStatus.issueIdentifier,
                        currentPathname: currentBrowserPathname(),
                      })}
                      style={{ color: "var(--link, #60a5fa)", fontSize: "12px", textDecoration: "none", overflowWrap: "anywhere" }}
                      title={selectedNode.runStatus.issueId}
                    >
                      {selectedNode.runStatus.issueIdentifier || selectedNode.runStatus.issueId.slice(0, 8)}
                    </a>
                  ) : (
                    <span style={mutedTextStyle}>-</span>
                  )}
                </div>
              </div>
              {selectedNode.dataFlow.badges.length > 0 ? (
                <div style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
                  <span style={{ ...mutedTextStyle, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    Data flow
                  </span>
                  {selectedNode.dataFlow.inputExpression ? (
                    <div style={{ display: "grid", gap: "2px" }}>
                      <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Input transform</span>
                      <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11px", color: "var(--foreground, #f8fafc)", overflowWrap: "anywhere" }}>
                        {selectedNode.dataFlow.inputExpression}
                      </span>
                    </div>
                  ) : null}
                  {selectedNode.dataFlow.outputSchema ? (
                    <div style={{ display: "grid", gap: "2px" }}>
                      <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Output schema</span>
                      <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11px", color: "var(--foreground, #f8fafc)", overflowWrap: "anywhere" }}>
                        {selectedNode.dataFlow.outputSchema}
                      </span>
                    </div>
                  ) : null}
                  {selectedNode.dataFlow.workProductRequired || selectedNode.dataFlow.workProductPattern ? (
                    <div style={{ display: "grid", gap: "2px" }}>
                      <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Work product</span>
                      <span style={{ fontSize: "12px", color: "var(--foreground, #f8fafc)", overflowWrap: "anywhere" }}>
                        {selectedNode.dataFlow.workProductRequired ? "Required" : "Optional"}
                        {selectedNode.dataFlow.workProductPattern ? ` · ${selectedNode.dataFlow.workProductPattern}` : ""}
                      </span>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {selectedNode.runStatus.resultPreview || selectedNode.runStatus.logPreview ? (
                <div style={{ display: "grid", gap: "8px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
                  <span style={{ ...mutedTextStyle, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    Step preview
                  </span>
                  {selectedNode.runStatus.resultPreview ? (
                    <div style={{ display: "grid", gap: "3px" }}>
                      <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Result preview</span>
                      <pre style={{ margin: 0, maxHeight: "120px", overflow: "auto", padding: "8px", border: "1px solid var(--border, #334155)", borderRadius: "8px", background: "var(--card, #0f172a)", color: "var(--foreground, #f8fafc)", fontSize: "11px", lineHeight: 1.35, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                        {selectedNode.runStatus.resultPreview}
                      </pre>
                    </div>
                  ) : null}
                  {selectedNode.runStatus.logPreview ? (
                    <div style={{ display: "grid", gap: "3px" }}>
                      <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Log preview</span>
                      <pre style={{ margin: 0, maxHeight: "120px", overflow: "auto", padding: "8px", border: "1px solid var(--border, #334155)", borderRadius: "8px", background: "var(--card, #0f172a)", color: "var(--muted-foreground, #94a3b8)", fontSize: "11px", lineHeight: 1.35, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                        {selectedNode.runStatus.logPreview}
                      </pre>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
                <span style={{ ...mutedTextStyle, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  Work products
                </span>
                {selectedNode.runStatus.workProducts.length > 0 ? (
                  <div style={{ display: "grid", gap: "6px" }}>
                    {selectedNode.runStatus.workProducts.map((product) => (
                      <div
                        key={product.id}
                        style={{
                          display: "grid",
                          gap: "4px",
                          padding: "8px",
                          border: "1px solid var(--border, #334155)",
                          borderRadius: "8px",
                          background: "var(--card, #0f172a)",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "8px" }}>
                          <div style={{ display: "grid", gap: "4px", minWidth: 0 }}>
                            {product.url ? (
                              <a
                                href={product.url}
                                target="_blank"
                                rel="noreferrer"
                                style={{ color: "var(--link, #60a5fa)", fontSize: "12px", fontWeight: 700, textDecoration: "none", overflowWrap: "anywhere" }}
                              >
                                {product.title}
                              </a>
                            ) : (
                              <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--foreground, #f8fafc)", overflowWrap: "anywhere" }}>
                                {product.title}
                              </span>
                            )}
                            {openedWorkProductId === product.id ? (
                              <span style={{ ...mutedTextStyle, fontSize: "11px", color: "#34d399" }}>Opened</span>
                            ) : null}
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: "6px", flex: "0 0 auto" }}>
                            {product.isPrimary ? (
                              <span style={{ ...graphPolicyBadgeStyle, flex: "0 0 auto" }}>Primary</span>
                            ) : null}
                            <button
                              type="button"
                              onClick={() => void handleOpenWorkProduct(product)}
                              disabled={openingWorkProductId === product.id}
                              style={{ ...buttonStyle, padding: "4px 8px", fontSize: "11px", lineHeight: 1.2 }}
                              title="Open in your browser"
                            >
                              {openingWorkProductId === product.id ? "Opening" : "Open"}
                            </button>
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
                          {product.type ? <span style={graphPolicyBadgeStyle}>{product.type}</span> : null}
                          {product.status ? <span style={graphPolicyBadgeStyle}>{product.status}</span> : null}
                        </div>
                        {product.summary ? (
                          <p style={{ margin: 0, color: "var(--muted-foreground, #94a3b8)", fontSize: "11px", lineHeight: 1.35, overflowWrap: "anywhere" }}>
                            {product.summary}
                          </p>
                        ) : null}
                      </div>
                    ))}
                    {workProductOpenError ? (
                      <p style={{ margin: 0, color: "var(--destructive, #ef4444)", fontSize: "11px", lineHeight: 1.35, overflowWrap: "anywhere" }}>
                        {workProductOpenError}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <span style={mutedTextStyle}>No registered outputs for this step.</span>
                )}
              </div>
              <div style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
                <span style={{ ...mutedTextStyle, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  Execution details
                </span>
                <div style={{ display: "grid", gap: "5px" }}>
                  <div style={{ display: "grid", gap: "2px" }}>
                    <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Started</span>
                    <span style={{ fontSize: "12px", color: "var(--foreground, #f8fafc)", overflowWrap: "anywhere" }}>
                      {selectedNode.runStatus.startedAt ? formatDateTime(selectedNode.runStatus.startedAt) : "-"}
                    </span>
                  </div>
                  <div style={{ display: "grid", gap: "2px" }}>
                    <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Completed</span>
                    <span style={{ fontSize: "12px", color: "var(--foreground, #f8fafc)", overflowWrap: "anywhere" }}>
                      {selectedNode.runStatus.completedAt ? formatDateTime(selectedNode.runStatus.completedAt) : "-"}
                    </span>
                  </div>
                  <div style={{ display: "grid", gap: "2px" }}>
                    <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Dispatch attempt</span>
                    <span style={{ fontSize: "12px", color: "var(--foreground, #f8fafc)", overflowWrap: "anywhere" }}>
                      {selectedNode.runStatus.lastDispatchAttemptAt ? formatDateTime(selectedNode.runStatus.lastDispatchAttemptAt) : "-"}
                    </span>
                  </div>
                  <div style={{ display: "grid", gap: "2px" }}>
                    <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Dispatch accepted</span>
                    <span style={{ fontSize: "12px", color: "var(--foreground, #f8fafc)", overflowWrap: "anywhere" }}>
                      {selectedNode.runStatus.lastDispatchAcceptedAt ? formatDateTime(selectedNode.runStatus.lastDispatchAcceptedAt) : "-"}
                    </span>
                  </div>
                  <div style={{ display: "grid", gap: "2px" }}>
                    <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Dispatch request</span>
                    <span style={{ fontSize: "12px", color: "var(--foreground, #f8fafc)", overflowWrap: "anywhere" }}>
                      {selectedNode.runStatus.lastDispatchRequestId || "-"}
                    </span>
                  </div>
                  <div style={{ display: "grid", gap: "2px" }}>
                    <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Dispatch error at</span>
                    <span style={{ fontSize: "12px", color: selectedNode.runStatus.lastDispatchErrorAt ? "var(--destructive, #ef4444)" : "var(--foreground, #f8fafc)", overflowWrap: "anywhere" }}>
                      {selectedNode.runStatus.lastDispatchErrorAt ? formatDateTime(selectedNode.runStatus.lastDispatchErrorAt) : "-"}
                    </span>
                  </div>
                  {selectedNode.runStatus.lastDispatchErrorSummary ? (
                    <div style={{ display: "grid", gap: "2px" }}>
                      <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Dispatch error</span>
                      <span style={{ fontSize: "12px", color: "var(--destructive, #ef4444)", overflowWrap: "anywhere", lineHeight: 1.35 }}>
                        {selectedNode.runStatus.lastDispatchErrorSummary}
                      </span>
                    </div>
                  ) : null}
                  {selectedNode.runStatus.concurrencyBlocked ? (
                    <div style={{ display: "grid", gap: "2px" }}>
                      <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Concurrency blocked</span>
                      <span style={{ fontSize: "12px", color: "#f97316", overflowWrap: "anywhere", lineHeight: 1.35 }}>
                        {selectedNode.runStatus.concurrencyBlocked.concurrencyKey}
                        {selectedNode.runStatus.concurrencyBlocked.concurrencyLimit !== null
                          ? ` limit ${selectedNode.runStatus.concurrencyBlocked.concurrencyLimit}`
                          : ""}
                        {selectedNode.runStatus.concurrencyBlocked.runningCount !== null
                          ? `, running ${selectedNode.runStatus.concurrencyBlocked.runningCount}`
                          : ""}
                        {selectedNode.runStatus.concurrencyBlocked.checkedAt
                          ? `, checked ${formatDateTime(selectedNode.runStatus.concurrencyBlocked.checkedAt)}`
                          : ""}
                      </span>
                    </div>
                  ) : null}
                  {selectedNode.runStatus.retentionDeleted ? (
                    <div style={{ display: "grid", gap: "2px" }}>
                      <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Retention</span>
                      <span style={{ fontSize: "12px", color: "#f97316", overflowWrap: "anywhere", lineHeight: 1.35 }}>
                        Deleted after use
                        {selectedNode.runStatus.retentionDeleted.toolName ? ` by ${selectedNode.runStatus.retentionDeleted.toolName}` : ""}
                        {selectedNode.runStatus.retentionDeleted.deletedAt
                          ? ` at ${formatDateTime(selectedNode.runStatus.retentionDeleted.deletedAt)}`
                          : ""}
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                style={!canRerunSelected || selectedPending ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
                disabled={!canRerunSelected || selectedPending}
                onClick={() => {
                  if (!selectedNode?.runStatus.stepRunId || !onRerunStep) return;
                  onRerunStep({
                    stepId: selectedNode.step.id,
                    stepRunId: selectedNode.runStatus.stepRunId,
                    issueId: selectedNode.runStatus.issueId,
                  });
                }}
              >
                {selectedPending ? "Rerunning..." : "Rerun selected step"}
              </button>
              <p style={{ ...mutedTextStyle, fontSize: "11px" }}>
                Rerun uses the same workflow step recovery action as the table below.
              </p>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
