import { useId, type ReactNode } from "react";
import type { StepDraft } from "../step-draft.js";
import type { WorkflowGraphEdge } from "../workflow-graph.js";
import { buttonStyle, mutedTextStyle, noticeStyle } from "../workflow-page-styles.js";

/** Bottom disclosure: selection identity and toggle never leave the header. */
export function GraphDetailsPanel({
  steps, selectedStep, selectedEdge, expanded, onExpandedChange, graphError, children,
}: {
  steps: StepDraft[];
  selectedStep: StepDraft | null;
  selectedEdge: WorkflowGraphEdge | undefined;
  expanded: boolean;
  graphError: string;
  onExpandedChange: (expanded: boolean) => void;
  children: ReactNode;
}) {
  const id = useId();
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
    <aside aria-labelledby={`${id}-title`} style={{ minWidth: 0, borderTop: "1px solid var(--border)", background: "var(--background, #020617)" }}>
      <div id={`${id}-body`} hidden={!expanded} style={{ maxHeight: "45vh", overflowY: "auto" }}>
        {children}
      </div>
      {graphError ? <p role="alert" style={{ ...noticeStyle("error"), margin: "0 12px 12px" }}>{graphError}</p> : null}
      <div style={{ display: "flex", alignItems: "start", justifyContent: "space-between", gap: "12px", padding: "12px" }}>
        <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
          <p style={{ ...mutedTextStyle, margin: 0 }}>Inspector · {context}</p>
          <h3 id={`${id}-title`} style={{ margin: "4px 0 0", fontSize: "16px", fontWeight: 600 }}>{title}</h3>
          {selectedEdge && selectedStep ? (
            <p style={{ ...mutedTextStyle, margin: "4px 0 0" }}>단계 설정: {selectedStep.title || selectedStep.id}</p>
          ) : null}
        </div>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`${id}-body`}
          style={{ ...buttonStyle, width: "160px", flexShrink: 0, minHeight: "44px", justifyContent: "center" }}
          onClick={() => onExpandedChange(!expanded)}
        >
          <span aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
          {expanded ? "상세 접기" : "상세 펼치기"}
        </button>
      </div>
    </aside>
  );
}
