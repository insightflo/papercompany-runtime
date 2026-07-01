import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { GraphCanvasPanState } from "./graphUiUtils.js";
import { clampGraphCanvasScale, clampGraphInspectorWidth } from "./WorkflowGraphEditorHelpers.js";

export function useWorkflowGraphCanvasViewport({
  closeGraphContextMenu,
}: {
  closeGraphContextMenu: () => void;
}) {
  const [canvasScale, setCanvasScale] = useState<number>(1);
  const [graphInspectorWidth, setGraphInspectorWidth] = useState<number>(420);
  const [isCanvasPanning, setIsCanvasPanning] = useState<boolean>(false);
  const [canvasPanX, setCanvasPanX] = useState<number>(0);
  const [canvasPanY, setCanvasPanY] = useState<number>(0);
  const graphCanvasRef = useRef<HTMLDivElement | null>(null);
  const graphCanvasPanRef = useRef<GraphCanvasPanState | null>(null);

  const setCanvasScaleFromPoint = useCallback((nextScale: number, clientX?: number, clientY?: number): void => {
    const container = graphCanvasRef.current;
    const normalizedScale = clampGraphCanvasScale(nextScale);
    if (!container || clientX === undefined || clientY === undefined) {
      setCanvasScale(normalizedScale);
      return;
    }
    const rect = container.getBoundingClientRect();
    const offsetX = clientX - rect.left;
    const offsetY = clientY - rect.top;
    const graphX = (-canvasPanX + offsetX) / canvasScale;
    const graphY = (-canvasPanY + offsetY) / canvasScale;
    setCanvasScale(normalizedScale);
    setCanvasPanX(offsetX - graphX * normalizedScale);
    setCanvasPanY(offsetY - graphY * normalizedScale);
  }, [canvasPanX, canvasPanY, canvasScale]);

  useEffect(() => {
    const container = graphCanvasRef.current;
    if (!container) return undefined;
    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault();
      closeGraphContextMenu();
      const direction = event.deltaY > 0 ? -1 : 1;
      setCanvasScaleFromPoint(canvasScale + direction * 0.1, event.clientX, event.clientY);
    };
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [canvasScale, closeGraphContextMenu, setCanvasScaleFromPoint]);

  const centerCanvasOnGraphPoint = useCallback((graphX: number, graphY: number): void => {
    const container = graphCanvasRef.current;
    if (!container) return;
    setCanvasPanX(container.clientWidth / 2 - graphX * canvasScale);
    setCanvasPanY(container.clientHeight / 2 - graphY * canvasScale);
  }, [canvasScale]);

  const beginCanvasPan = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-graph-node='true'], [data-graph-toolbar='true'], [data-graph-menu='true'], [data-graph-edge='true'], [data-graph-handle='true'], [data-graph-edge-remove='true']")) return;
    if (event.button !== 0 && event.button !== 1) return;
    closeGraphContextMenu();
    graphCanvasPanRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPanX: canvasPanX,
      startPanY: canvasPanY,
    };
    setIsCanvasPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [canvasPanX, canvasPanY, closeGraphContextMenu]);

  const handleCanvasPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const pan = graphCanvasPanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    setCanvasPanX(pan.startPanX + (event.clientX - pan.startClientX));
    setCanvasPanY(pan.startPanY + (event.clientY - pan.startClientY));
  }, []);

  const endCanvasPan = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const pan = graphCanvasPanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    graphCanvasPanRef.current = null;
    setIsCanvasPanning(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
  }, []);

  const beginGraphInspectorResize = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startClientX = event.clientX;
    const startWidth = graphInspectorWidth;
    const onMove = (moveEvent: PointerEvent): void => {
      setGraphInspectorWidth(clampGraphInspectorWidth(startWidth - (moveEvent.clientX - startClientX)));
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [graphInspectorWidth]);

  return {
    canvasScale,
    canvasPanX,
    canvasPanY,
    graphInspectorWidth,
    graphCanvasRef,
    isCanvasPanning,
    setCanvasScaleFromPoint,
    centerCanvasOnGraphPoint,
    beginCanvasPan,
    handleCanvasPointerMove,
    endCanvasPan,
    beginGraphInspectorResize,
  };
}
