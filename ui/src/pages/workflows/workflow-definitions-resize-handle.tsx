import { type JSX, type MutableRefObject } from "react";

export function WorkflowDefinitionsResizeHandle({
  collapsed,
  height,
  resizeRef,
  startYRef,
  onHeightChange,
}: {
  collapsed: boolean;
  height: number | null;
  resizeRef: MutableRefObject<number>;
  startYRef: MutableRefObject<number>;
  onHeightChange: (height: number) => void;
}): JSX.Element | null {
  if (collapsed) return null;
  return (
        <div
          id="wf-resize-handle"
          key="definitions-resize-handle"
          style={{
            height: "6px",
            cursor: "ns-resize",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--border, #334155)",
            borderRadius: "3px",
            margin: "-2px 0",
            position: "relative",
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            startYRef.current = e.clientY;
            resizeRef.current = height ?? (e.currentTarget.previousElementSibling as HTMLElement)?.offsetHeight ?? 420;
            const onMove = (ev: MouseEvent) => {
              const delta = ev.clientY - startYRef.current;
              const next = Math.max(200, resizeRef.current + delta);
              onHeightChange(next);
            };
            const onUp = () => {
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
              document.body.style.cursor = "";
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
            document.body.style.cursor = "ns-resize";
          }}
        >
          <div style={{ width: "40px", height: "2px", background: "var(--muted-foreground, #94a3b8)", borderRadius: "1px" }} />
        </div>
  );
}
