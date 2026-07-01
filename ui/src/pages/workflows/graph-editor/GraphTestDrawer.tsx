// [파일 목적] 워크플로우 그래프 테스트 드로어(테스트 실행 미리보기/모드 요약) 렌더.
// Workflows.tsx에서 WorkflowGraphTestDrawer 기계적 추출.
// [외부 연결] ../step-workspace-editor.js, ../workflow-graph.js, ../step-draft.js, ../workflow-page-styles.js, ./graphStyles.js, react.
// [주의] 동작 변경 없이 props 기반 렌더만. 루트 Workflows.tsx 역참조 금지.
import { type JSX } from "react";
import type { StepDraft } from "../step-draft.js";
import { type WorkflowGraphInterfaceInput, type WorkflowGraphTestDrawerSummary } from "../workflow-graph.js";
import { WorkflowTestPlanPreview } from "../step-workspace-editor.js";
import { buttonStyle, graphPolicyBadgeStyle, mutedTextStyle } from "../workflow-page-styles.js";
import { workflowGraphFocusLensToneColor, workflowGraphTestDrawerModeStyle, workflowGraphTestDrawerStyle } from "./graphStyles.js";

export function WorkflowGraphTestDrawer({
  summary,
  steps,
  interfaceInput,
  onClose,
}: {
  summary: WorkflowGraphTestDrawerSummary;
  steps: StepDraft[];
  interfaceInput?: WorkflowGraphInterfaceInput;
  onClose: () => void;
}): JSX.Element {
  return (
    <div key="workflow-graph-test-drawer" style={workflowGraphTestDrawerStyle(summary.tone)}>
      <div key="header" style={{ display: "flex", alignItems: "start", justifyContent: "space-between", gap: "8px", minWidth: 0 }}>
        <div style={{ display: "grid", gap: "4px", minWidth: 0 }}>
          <span style={{ ...mutedTextStyle, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 800 }}>
            Test drawer
          </span>
          <strong style={{ fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary.title}</strong>
          <span style={{ ...mutedTextStyle, fontSize: "11px", lineHeight: 1.35, overflowWrap: "anywhere" }}>{summary.summary}</span>
        </div>
        <button type="button" style={{ ...buttonStyle, padding: "4px 8px", fontSize: "11px" }} onClick={onClose}>
          Close
        </button>
      </div>
      <div key="badges" style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
        {summary.badges.slice(0, 5).map((badge) => (
          <span key={badge} style={graphPolicyBadgeStyle}>{badge}</span>
        ))}
      </div>
      <div key="modes" style={{ display: "grid", gap: "6px" }}>
        {summary.modes.map((mode) => (
          <div key={mode.id} style={workflowGraphTestDrawerModeStyle(mode.tone)}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px", minWidth: 0 }}>
              <strong style={{ fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mode.title}</strong>
              <span style={{ ...graphPolicyBadgeStyle, color: workflowGraphFocusLensToneColor(mode.tone) }}>{mode.badges[0] ?? mode.tone}</span>
            </div>
            <span style={{ ...mutedTextStyle, fontSize: "11px", lineHeight: 1.35, overflowWrap: "anywhere" }}>{mode.summary}</span>
          </div>
        ))}
      </div>
      <details key="detailed-controls" open style={{ display: "grid", gap: "8px" }}>
        <summary style={{ cursor: "pointer", color: "var(--muted-foreground, #94a3b8)", fontSize: "11px", fontWeight: 750 }}>
          Execution controls
        </summary>
        <WorkflowTestPlanPreview steps={steps} interfaceInput={interfaceInput} />
      </details>
    </div>
  );
}
