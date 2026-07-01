// [파일 목적] 그래프 인스펙터의 data-flow-contract + resource-bindings + testing-overrides 섹션 렌더.
// GraphInspector에서 세 policy 데이터 섹션 + renderDataFlowChips helper 기계적 추출.
// [외부 연결] ../workflow-page-styles.js, ../shared-controls.js, ../step-draft.js, ../workflow-graph.js, react.
// [주의] 동작 변경 없이 props 기반 렌더만. 루트 Workflows.tsx 역참조 금지.
import { Fragment, type JSX } from "react";
import type { StepDraft } from "../step-draft.js";
import type { WorkflowGraphDataFlowMap } from "../workflow-graph.js";
import { graphPolicyBadgeStyle, inputStyle, mutedTextStyle, textareaStyle } from "../workflow-page-styles.js";
import { FieldLabel, HelpIcon, HelpedText } from "../shared-controls.js";

// 과거 coordinator 내부에 있던 헬퍼를 그대로 옮김. 클로저 의존성 없음.
function renderDataFlowChips(values: string[], emptyLabel: string, tone: "normal" | "muted" | "error" = "normal"): JSX.Element {
  if (values.length === 0) {
    return <span style={{ ...mutedTextStyle, fontSize: "11px" }}>{emptyLabel}</span>;
  }
  const color = tone === "error" ? "var(--destructive, #ef4444)" : tone === "muted" ? "var(--muted-foreground, #94a3b8)" : "#14b8a6";
  return (
    <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
      {values.map((value) => (
        <span key={value} style={{ ...graphPolicyBadgeStyle, color }}>{value}</span>
      ))}
    </div>
  );
}


// [목적] selected-step 의 data-flow contract + resource bindings + testing overrides 렌더.
// [입력] selectedStep + selectedDataFlowMap + 3개 update 핸들러.
// [연결] GraphInspector <details> 내에서 렌더.
export function GraphInspectorPolicyDataFlow({
  selectedStep,
  selectedDataFlowMap,
  updateSelectedDataFlow,
  updateSelectedResources,
  updateSelectedTesting,
}: {
  selectedStep: StepDraft;
  selectedDataFlowMap: WorkflowGraphDataFlowMap | null;
  updateSelectedDataFlow: (patch: Partial<StepDraft>) => void;
  updateSelectedResources: (patch: Partial<StepDraft>) => void;
  updateSelectedTesting: (patch: Partial<StepDraft>) => void;
}): JSX.Element {
  return (
    <Fragment>
            <div key="data-flow-contract" style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
              <HelpedText help="Defines how this step receives upstream data and what output contract downstream gates should expect.">Data flow contract</HelpedText>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Expression that transforms upstream results into this step's input.">Input transform</FieldLabel>
                <textarea
                  style={{ ...textareaStyle, minHeight: "58px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
                  value={selectedStep.graphInputExpression}
                  placeholder="Input transform, e.g. select.result.summary"
                  onChange={(event) => updateSelectedDataFlow({ graphInputExpression: event.target.value })}
                />
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="JSON schema or text contract describing the result this step must return.">Output schema</FieldLabel>
                <textarea
                  style={{ ...textareaStyle, minHeight: "72px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
                  value={selectedStep.graphOutputSchema}
                  placeholder={'Output schema, e.g. { "type": "object", "required": ["htmlPath"] }'}
                  onChange={(event) => updateSelectedDataFlow({ graphOutputSchema: event.target.value })}
                />
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                <input
                  type="checkbox"
                  checked={selectedStep.graphWorkProductRequired}
                  onChange={(event) => updateSelectedDataFlow({ graphWorkProductRequired: event.target.checked })}
                />
                Require registered work product
                <HelpIcon label="Requires this step to produce a registered work product before artifact-dependent downstream steps pass." />
              </label>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Expected output path or filename pattern for the required work product.">Work product pattern</FieldLabel>
                <input
                  style={inputStyle}
                  value={selectedStep.graphWorkProductPattern}
                  placeholder="Expected output path pattern"
                  onChange={(event) => updateSelectedDataFlow({ graphWorkProductPattern: event.target.value })}
                />
              </div>
              {selectedDataFlowMap ? (
                <div
                  style={{
                    display: "grid",
                    gap: "6px",
                    padding: "8px",
                    border: "1px solid var(--border, #334155)",
                    borderRadius: "8px",
                    background: "rgba(15, 23, 42, 0.24)",
                  }}
                >
                  <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                    {selectedDataFlowMap.badges.map((badge) => (
                      <span
                        key={`data-flow-map-${badge}`}
                        style={{ ...graphPolicyBadgeStyle, color: selectedDataFlowMap.blocked ? "var(--destructive, #ef4444)" : "#14b8a6" }}
                      >
                        {badge}
                      </span>
                    ))}
                  </div>
                  <span style={{ ...mutedTextStyle, fontSize: "11px" }}>{selectedDataFlowMap.summary}</span>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "6px" }}>
                    <div style={{ display: "grid", gap: "3px" }}>
                      <span style={{ ...mutedTextStyle, fontSize: "10px" }}>Flow inputs</span>
                      {renderDataFlowChips(selectedDataFlowMap.flowInputRefs, "No flow inputs")}
                    </div>
                    <div style={{ display: "grid", gap: "3px" }}>
                      <span style={{ ...mutedTextStyle, fontSize: "10px" }}>Upstream results</span>
                      {renderDataFlowChips(
                        selectedDataFlowMap.resultRefs
                          .filter((ref) => ref.available)
                          .map((ref) => `${ref.stepId}.result${ref.path ? `.${ref.path}` : ""}`),
                        "No result refs",
                      )}
                    </div>
                    <div style={{ display: "grid", gap: "3px" }}>
                      <span style={{ ...mutedTextStyle, fontSize: "10px" }}>Resources</span>
                      {renderDataFlowChips(selectedDataFlowMap.resourceRefs, "No resources", "muted")}
                    </div>
                    <div style={{ display: "grid", gap: "3px" }}>
                      <span style={{ ...mutedTextStyle, fontSize: "10px" }}>Secrets</span>
                      {renderDataFlowChips(selectedDataFlowMap.secretRefs, "No secrets", "muted")}
                    </div>
                    {selectedDataFlowMap.missingStepIds.length > 0 ? (
                      <div style={{ display: "grid", gap: "3px" }}>
                        <span style={{ ...mutedTextStyle, fontSize: "10px", color: "var(--destructive, #ef4444)" }}>Missing steps</span>
                        {renderDataFlowChips(selectedDataFlowMap.missingStepIds, "No missing steps", "error")}
                      </div>
                    ) : null}
                  </div>
                  {selectedDataFlowMap.outputContractBadges.length > 0 ? (
                    <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                      {selectedDataFlowMap.outputContractBadges.map((badge) => (
                        <span key={`output-contract-${badge}`} style={{ ...graphPolicyBadgeStyle, color: "#a78bfa" }}>{badge}</span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div key="resource-bindings" style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
              <HelpedText help="Binds runtime-visible resources and secret references to this step.">Resource bindings</HelpedText>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Comma-separated resource references this step may read.">Resources</FieldLabel>
                <input
                  style={inputStyle}
                  value={selectedStep.graphResourceRefs}
                  placeholder="Resources, comma-separated"
                  onChange={(event) => updateSelectedResources({ graphResourceRefs: event.target.value })}
                />
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Comma-separated secret references exposed to this step.">Secret references</FieldLabel>
                <input
                  style={inputStyle}
                  value={selectedStep.graphSecretRefs}
                  placeholder="Secret references, comma-separated"
                  onChange={(event) => updateSelectedResources({ graphSecretRefs: event.target.value })}
                />
              </div>
            </div>
            <div key="testing-overrides" style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
              <HelpedText help="Overrides used by test previews and focused step testing without changing normal runtime behavior.">Testing overrides</HelpedText>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                <input
                  type="checkbox"
                  checked={selectedStep.graphMockEnabled}
                  onChange={(event) => updateSelectedTesting({ graphMockEnabled: event.target.checked })}
                />
                Mock step result while testing
                <HelpIcon label="Uses the mock result below during test previews instead of requiring the real step to run." />
              </label>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="JSON-like result returned for this step in test previews when mock mode is enabled.">Mock result</FieldLabel>
                <textarea
                  style={{ ...textareaStyle, minHeight: "72px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
                  value={selectedStep.graphMockResult}
                  placeholder={'{ "status": "ok" }'}
                  onChange={(event) => updateSelectedTesting({ graphMockResult: event.target.value })}
                />
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Existing run or step result id to reuse during test previews.">Pinned result id</FieldLabel>
                <input
                  style={inputStyle}
                  value={selectedStep.graphPinnedResultRunId}
                  placeholder="Pinned run or step result id"
                  onChange={(event) => updateSelectedTesting({ graphPinnedResultRunId: event.target.value })}
                />
              </div>
            </div>

    </Fragment>
  );
}
