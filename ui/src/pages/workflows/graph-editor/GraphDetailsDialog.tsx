import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { StepDraft } from "../step-draft.js";
import type { WorkflowGraphEdge } from "../workflow-graph.js";
import { buttonStyle, mutedTextStyle, noticeStyle } from "../workflow-page-styles.js";
import { graphDetailsDialogBackdropStyle, graphDetailsDialogStyle } from "./graphStyles.js";

/** 상세 편집 팝업: 그래프 객체 더블클릭으로 열리고 Escape/배경/닫기 버튼으로 닫힌다. */
export function GraphDetailsDialog({
  steps, selectedStep, selectedEdge, graphError, onClose, children,
}: {
  steps: StepDraft[];
  selectedStep: StepDraft | null;
  selectedEdge: WorkflowGraphEdge | undefined;
  graphError: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<Element | null>(null);
  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    if (previousOverflow !== "hidden") document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      if (previousOverflow !== "hidden") document.body.style.overflow = previousOverflow;
      if (previousFocusRef.current instanceof HTMLElement) previousFocusRef.current.focus();
    };
  }, []);
  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }
  const stepName = (stepId: string) => {
    const step = steps.find((entry) => entry.id === stepId);
    return step?.title || stepId;
  };
  const title = selectedEdge
    ? `${stepName(selectedEdge.source)} → ${stepName(selectedEdge.target)}`
    : selectedStep?.title || selectedStep?.id || "단계를 선택하세요";
  const context = selectedEdge
    ? `선택 연결 · ${selectedEdge.when}`
    : `선택 단계 · ${selectedStep?.type || "없음"}`;
  return (
    <div
      data-graph-details-backdrop="true"
      style={graphDetailsDialogBackdropStyle}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        data-graph-details-dialog="true"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        style={graphDetailsDialogStyle}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div style={{ display: "flex", alignItems: "start", justifyContent: "space-between", gap: "12px", padding: "12px", borderBottom: "1px solid var(--border, #334155)" }}>
          <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            <p style={{ ...mutedTextStyle, margin: 0 }}>Inspector · {context}</p>
            <h3 id={`${id}-title`} style={{ margin: "4px 0 0", fontSize: "16px", fontWeight: 600 }}>{title}</h3>
            {selectedEdge && selectedStep ? (
              <p style={{ ...mutedTextStyle, margin: "4px 0 0" }}>단계 설정: {selectedStep.title || selectedStep.id}</p>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="상세 편집 닫기"
            style={{ ...buttonStyle, flexShrink: 0, minHeight: "36px", justifyContent: "center" }}
            onClick={onClose}
          >
            닫기
          </button>
        </div>
        <div style={{ overflowY: "auto", padding: "12px" }}>
          {children}
          {graphError ? <p role="alert" style={{ ...noticeStyle("error"), margin: "12px 0 0" }}>{graphError}</p> : null}
        </div>
      </div>
    </div>
  );
}
