// [파일 목적] 그래프 인스펙터의 run-overlay + sticky-note 섹션 렌더.
// GraphInspector에서 마지막 두 policy 섹션 기계적 추출.
// [외부 연결] ../workflow-page-styles.js, ../shared-controls.js, ../step-draft.js, ../workflow-graph.js, react.
// [주의] 동작 변경 없이 props 기반 렌더만. 루트 Workflows.tsx 역참조 금지.
import { Fragment, type JSX } from "react";
import type { StepDraft } from "../step-draft.js";
import { normalizeGraphRunStatus } from "../workflow-graph.js";
import { inputStyle, selectStyle, textareaStyle } from "../workflow-page-styles.js";
import { FieldLabel, HelpedText } from "../shared-controls.js";

// [목적] selected-step 의 run overlay(수동 미리보기) + sticky note 렌더.
// [입력] selectedStep + updateSelected + setSelectedNote.
// [연결] GraphInspector <details> 내 마지막에서 렌더.
export function GraphInspectorPolicyRunNote({
  selectedStep,
  updateSelected,
  setSelectedNote,
}: {
  selectedStep: StepDraft;
  updateSelected: (patch: Partial<StepDraft>) => void;
  setSelectedNote: (note: string) => void;
}): JSX.Element {
  return (
    <Fragment>
            <div key="run-overlay" style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
              <HelpedText help="Manual visual overlay values used to preview how a step looks with run state attached.">Run overlay</HelpedText>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Status badge to show on this step in the graph preview.">Run status</FieldLabel>
                <select
                  style={selectStyle}
                  value={selectedStep.graphRunStatus}
                  onChange={(event) => updateSelected({ graphRunStatus: normalizeGraphRunStatus(event.target.value) })}
                >
                  <option value="planned">Planned</option>
                  <option value="running">Running</option>
                  <option value="succeeded">Succeeded</option>
                  <option value="failed">Failed</option>
                  <option value="skipped">Skipped</option>
                  <option value="paused">Paused</option>
                </select>
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Issue identifier shown in the run overlay for this step.">Issue identifier</FieldLabel>
                <input
                  style={inputStyle}
                  value={selectedStep.graphRunIssueIdentifier}
                  placeholder="Issue identifier"
                  onChange={(event) => updateSelected({ graphRunIssueIdentifier: event.target.value })}
                />
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Timestamp text shown as the last update time in the overlay.">Updated at</FieldLabel>
                <input
                  style={inputStyle}
                  value={selectedStep.graphRunUpdatedAt}
                  placeholder="Updated at"
                  onChange={(event) => updateSelected({ graphRunUpdatedAt: event.target.value })}
                />
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Short text summary shown for this step's run overlay.">Run summary</FieldLabel>
                <textarea
                  style={{ ...textareaStyle, minHeight: "64px" }}
                  value={selectedStep.graphRunSummary}
                  placeholder="Run summary"
                  onChange={(event) => updateSelected({ graphRunSummary: event.target.value })}
                />
              </div>
            </div>
            <div key="sticky-note" style={{ display: "grid", gap: "4px" }}>
              <FieldLabel help="Freeform note shown with the selected graph node for operator context.">Sticky note</FieldLabel>
              <textarea
                style={{ ...textareaStyle, minHeight: "72px" }}
                value={selectedStep.graphNote}
                placeholder="Markdown note for this node"
                onChange={(event) => setSelectedNote(event.target.value)}
              />
            </div>

    </Fragment>
  );
}
