// [파일 목적] 워크플로우 그래프 에디터의 인스펙터(우측 사이드 패널)를 렌더링하는 프레젠테이션 컴포넌트.
// 선택된 스텝의 메타데이터 편집기, 승인/테스트/실행/데이터플로우 필드를 표시한다.
// [주요 흐름] (1) 인스펙터 모드 탭, (2) overview 블록, (3) 그래프 에러,
// (4) edit/policy/raw 모드별 선택 스텝 편집 필드.
// [외부 연결] ../workflow-graph.js, ./graphStyles.js, ./GraphInspectorOverview.js,
// ../workflow-page-styles.js, ../workflow-page-types.js, ../shared-controls.js, ../workflow-tool-picker.js,
// ../step-editor.js, react.
// [수정시 주의] 상태/핸들러를 직접 만들지 말고 코디네이터에서 props로 넘길 것. 루트 Workflows.tsx 역참조 금지.
import * as React from "react";
import { Fragment, type CSSProperties, type JSX } from "react";
import { GraphInspectorRawStep } from "./GraphInspectorRawStep.js";
import type { StepDraft } from "../step-draft.js";
import {
  type WorkflowToolGrant,
  type WorkflowToolOption,
} from "../workflow-page-types.js";
import {
  type WorkflowGraphContainerType,
  type WorkflowGraphDataFlowMap,
  type WorkflowGraphInspectorMode,
  type WorkflowGraphInspectorSummary,
  normalizeGraphRunStatus,
} from "../workflow-graph.js";
import {
  buttonStyle,
  dangerButtonStyle,
  filterTabStyle,
  graphPolicyBadgeStyle,
  inputStyle,
  mutedTextStyle,
  noticeStyle,
  primaryButtonStyle,
  selectStyle,
  textareaStyle,
} from "../workflow-page-styles.js";
import { FieldLabel, HelpIcon, HelpedText } from "../shared-controls.js";
import { splitCommaList, WorkflowToolPicker } from "../workflow-tool-picker.js";
import { graphSidebarStyle } from "./graphStyles.js";
import { GraphInspectorOverview, type GraphInspectorOverviewProps } from "./GraphInspectorOverview.js";

// 인스펙터에서만 쓰이는 정책 <details> 스타일. 과거 Workflows.tsx 모듈 스코프에 있던 값을 그대로 옮김.
const workflowPolicyDetailsStyle: CSSProperties = {
  display: "grid",
  gap: "8px",
  padding: "8px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  background: "color-mix(in srgb, var(--card, #0f172a) 48%, var(--background, #020617))",
};

const workflowPolicyDetailsSummaryStyle: CSSProperties = {
  cursor: "pointer",
  color: "var(--foreground, #f8fafc)",
  fontSize: "12px",
  fontWeight: 800,
};

export interface GraphInspectorProps extends Omit<GraphInspectorOverviewProps, "stepIds"> {
  steps: StepDraft[];
  selectedStep: StepDraft | null;
  selectedDataFlowMap: WorkflowGraphDataFlowMap | null;
  selectedGroup: { title: string; color: string; collapsed?: boolean; collapsedByDefault?: boolean } | null;
  inspectorSummary: WorkflowGraphInspectorSummary;
  activeInspectorSection: WorkflowGraphInspectorSummary["sections"][number];
  graphError: string;
  graphInspectorMode: WorkflowGraphInspectorMode;
  inspectorAccent: string;
  showEditInspector: boolean;
  showPolicyInspector: boolean;
  showRawInspector: boolean;
  rawStepJsonText: string;
  rawStepJsonFeedback: { tone: "info" | "error" | "success"; message: string } | null;
  availableTools: WorkflowToolOption[];
  availableToolGrants: WorkflowToolGrant[];
  graphAgents: { id: string; name: string }[];
  // handlers
  setGraphInspectorMode: (mode: WorkflowGraphInspectorMode) => void;
  setShowGraphTestDrawer: (value: boolean) => void;
  setRawStepJsonText: (value: string) => void;
  setRawStepJsonFeedback: (value: { tone: "info" | "error" | "success"; message: string } | null) => void;
  addAfter: (stepId: string | null) => void;
  wrapSelectedPathInContainer: () => void;
  duplicateSelectedStep: () => void;
  clearSelectedGroup: () => void;
  groupSelectedWithDependencies: () => void;
  setSelectedGroupCollapsed: (collapsed: boolean) => void;
  handleDeleteGraphObjectPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  renameSelectedStep: (nextStepId: string) => void;
  updateSelected: (patch: Partial<StepDraft>) => void;
  updateSelectedAdvanced: (patch: Partial<StepDraft>) => void;
  updateSelectedApproval: (patch: Partial<StepDraft>) => void;
  updateSelectedTesting: (patch: Partial<StepDraft>) => void;
  updateSelectedExecution: (patch: Partial<StepDraft>) => void;
  updateSelectedDataFlow: (patch: Partial<StepDraft>) => void;
  updateSelectedResources: (patch: Partial<StepDraft>) => void;
  updateSelectedGroupMetadata: (patch: { title?: string; color?: string; collapsedByDefault?: boolean }) => void;
  updateSelectedContainerMetadata: (patch: Partial<StepDraft>) => void;
  setSelectedNote: (note: string) => void;
  validateRawSelectedStepJson: () => void;
  applyRawSelectedStepJson: () => void;
}

// [목적] 워크플로우 그래프 인스펙터 사이드 패널 렌더.
// [입력] GraphInspectorProps — 코디네이터가 소유한 상태/파생값/핸들러 + 테스트 드로어 슬롯.
// [출력] <aside key="graph-sidebar"> JSX.
// [연결] WorkflowGraphEditor 코디네이터가 렌더.
// [주의] 동작 변경 없이 props 기반 렌더만 수행. WorkflowGraphTestDrawer는 루트 의존성이 있어 슬롯으로 전달.
export function GraphInspector({
  steps,
  selectedStep,
  selectedContainerSummary,
  selectedDataFlowMap,
  selectedGroup,
  selectedPathSummary,
  inspectorSummary,
  activeInspectorSection,
  evidenceSummary,
  repairPlan,
  diagnostics,
  graphError,
  graphInspectorMode,
  inspectorAccent,
  showOverviewInspector,
  showEditInspector,
  showPolicyInspector,
  showRawInspector,
  showGraphDetails,
  showGraphTestDrawer,
  showGraphEvidenceDrawer,
  rawStepJsonText,
  rawStepJsonFeedback,
  availableTools,
  availableToolGrants,
  graphAgents,
  testDrawerSlot,
  setGraphInspectorMode,
  setShowGraphTestDrawer,
  setShowGraphEvidenceDrawer,
  setRawStepJsonText,
  setRawStepJsonFeedback,
  selectStep,
  addAfter,
  expandSelectedPath,
  clearSelectedPath,
  groupSelectedGraphSelection,
  wrapSelectedGraphSelection,
  wrapSelectedPathInContainer,
  duplicateSelectedStep,
  duplicateSelectedContainer,
  clearSelectedContainer,
  clearSelectedGroup,
  groupSelectedWithDependencies,
  setSelectedGroupCollapsed,
  handleDeleteGraphObjectPointerDown,
  renameSelectedStep,
  updateSelected,
  updateSelectedAdvanced,
  updateSelectedApproval,
  updateSelectedTesting,
  updateSelectedExecution,
  updateSelectedDataFlow,
  updateSelectedResources,
  updateSelectedGroupMetadata,
  updateSelectedContainerMetadata,
  setSelectedNote,
  validateRawSelectedStepJson,
  applyRawSelectedStepJson,
}: GraphInspectorProps): JSX.Element {
  const stepIds = React.useMemo(() => new Set(steps.map((step) => step.id)), [steps]);

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

  return (
    <aside key="graph-sidebar" style={graphSidebarStyle}>
        <div key="graph-inspector-mode" style={{ display: "grid", gap: "8px", paddingBottom: "8px", borderBottom: "1px solid var(--border, #334155)" }}>
          <div key="inspector-heading" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
            <p style={{ ...mutedTextStyle, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Inspector
            </p>
            <span style={{ ...graphPolicyBadgeStyle, color: inspectorAccent }}>
              {activeInspectorSection.title}
            </span>
          </div>
          <div key="inspector-tabs" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "6px" }}>
            {inspectorSummary.sections.filter((section) => section.mode !== "overview").map((section) => (
              <button
                key={section.mode}
                type="button"
                style={{ ...filterTabStyle(graphInspectorMode === section.mode), justifyContent: "center", padding: "6px 8px" }}
                onClick={() => setGraphInspectorMode(section.mode)}
              >
                {section.title}
              </button>
            ))}
          </div>
          <p key="inspector-summary" style={{ margin: 0, color: "var(--muted-foreground, #94a3b8)", fontSize: "12px", lineHeight: 1.4 }}>
            {activeInspectorSection.summary}
          </p>
          <div key="inspector-badges" style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
            {activeInspectorSection.badges.map((badge) => (
              <span key={badge} style={{ ...graphPolicyBadgeStyle, color: inspectorAccent }}>{badge}</span>
            ))}
          </div>
        </div>
        <GraphInspectorOverview
          key="graph-overview"
          stepIds={stepIds}
          selectedContainerSummary={selectedContainerSummary}
          selectedPathSummary={selectedPathSummary}
          evidenceSummary={evidenceSummary}
          repairPlan={repairPlan}
          diagnostics={diagnostics}
          showOverviewInspector={showOverviewInspector}
          showGraphDetails={showGraphDetails}
          showGraphTestDrawer={showGraphTestDrawer}
          showGraphEvidenceDrawer={showGraphEvidenceDrawer}
          testDrawerSlot={testDrawerSlot}
          setShowGraphEvidenceDrawer={setShowGraphEvidenceDrawer}
          selectStep={selectStep}
          expandSelectedPath={expandSelectedPath}
          clearSelectedPath={clearSelectedPath}
          groupSelectedGraphSelection={groupSelectedGraphSelection}
          wrapSelectedGraphSelection={wrapSelectedGraphSelection}
          duplicateSelectedContainer={duplicateSelectedContainer}
          clearSelectedContainer={clearSelectedContainer}
        />
        {graphError ? <p key="graph-error" style={noticeStyle("error")}>{graphError}</p> : <Fragment key="graph-error-placeholder" />}
        {selectedStep ? (
          <div key="selected-step-editor" style={{ display: "contents" }}>
            {showEditInspector ? (
            <Fragment key="selected-step-edit-fields">
            <div key="step-id-field" style={{ display: "grid", gap: "4px" }}>
              <FieldLabel help="Stable step id used by dependencies, graph edges, and step-run records. Renaming updates the graph references.">Step ID</FieldLabel>
              <input
                key="input"
                style={inputStyle}
                value={selectedStep.id}
                onChange={(event) => renameSelectedStep(event.target.value)}
              />
            </div>
            <div key="step-title-field" style={{ display: "grid", gap: "4px" }}>
              <FieldLabel help="Human-readable title shown on graph nodes, generated issues, and run history.">Title</FieldLabel>
              <input key="input" style={inputStyle} value={selectedStep.title} onChange={(event) => updateSelected({ title: event.target.value })} />
            </div>
            <div key="step-type-field" style={{ display: "grid", gap: "4px" }}>
              <FieldLabel help="Agent creates a worker issue for an assignee. Tool runs an authorized workflow tool directly.">Type</FieldLabel>
              <select key="select" style={selectStyle} value={selectedStep.type} onChange={(event) => {
                const newType = event.target.value as "agent" | "tool";
                if (newType === "tool" && availableTools.length === 0) return;
                if (newType === "agent" && selectedStep.agentName) {
                  const granted = new Set(availableToolGrants.filter((g) => g.agentName === selectedStep.agentName).map((g) => g.toolName));
                  const cleaned = splitCommaList(selectedStep.tools).filter((t) => granted.has(t)).join(", ");
                  updateSelected({ type: newType, tools: cleaned });
                } else {
                  updateSelected({ type: newType });
                }
              }}>
                <option key="agent" value="agent">Agent</option>
                <option key="tool" value="tool" disabled={availableTools.length === 0}>Tool</option>
              </select>
              {availableTools.length === 0 ? (
                <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Tool steps are inactive until workflow tools are available.</span>
              ) : null}
            </div>
            <div key="step-description-field" style={{ display: "grid", gap: "4px" }}>
              <FieldLabel help="Instruction text passed to the agent or used to describe the tool step.">Description</FieldLabel>
              <textarea key="textarea" style={{ ...textareaStyle, minHeight: "76px" }} value={selectedStep.description} onChange={(event) => updateSelected({ description: event.target.value })} />
            </div>
            {selectedStep.type === "tool" ? (
              <Fragment key="tool-step-fields">
                <div key="tool-name-field" style={{ display: "grid", gap: "4px" }}>
                  <FieldLabel help="Authorized workflow tool this selected step will run. Unavailable selections remain visible for cleanup.">Tool</FieldLabel>
                  <WorkflowToolPicker
                    value={selectedStep.toolName}
                    multiple={false}
                    tools={availableTools}
                    onChange={(value) => updateSelected({ toolName: value })}
                  />
                </div>
                <div key="tool-args-field" style={{ display: "grid", gap: "4px" }}>
                  <FieldLabel help="JSON arguments sent to the selected workflow tool. Keep this valid JSON for predictable execution.">Tool Args (JSON)</FieldLabel>
                  <textarea
                    style={{ ...textareaStyle, minHeight: "92px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: "12px" }}
                    value={selectedStep.toolArgs}
                    onChange={(event) => updateSelected({ toolArgs: event.target.value })}
                  />
                </div>
              </Fragment>
            ) : (
              <Fragment key="agent-step-fields">
                <div key="agent-name-field" style={{ display: "grid", gap: "4px" }}>
                  <FieldLabel help="Agent assigned to execute this step. Changing the agent also trims tool grants to that agent.">Agent</FieldLabel>
                  <select style={selectStyle} value={selectedStep.agentId || graphAgents.find((a) => a.name === selectedStep.agentName)?.id || ""} onChange={(event) => {
                    const selectedId = event.target.value;
                    const agent = graphAgents.find((a) => a.id === selectedId);
                    const newName = agent?.name ?? "";
                    const granted = new Set(availableToolGrants.filter((g) => g.agentName === newName).map((g) => g.toolName));
                    const cleaned = splitCommaList(selectedStep.tools).filter((t) => granted.has(t)).join(", ");
                    updateSelected({ agentId: selectedId, agentName: newName, tools: cleaned });
                  }}>
                    <option value="">— Select agent —</option>
                    {graphAgents.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </div>
                <div key="agent-tool-access-field" style={{ display: "grid", gap: "4px" }}>
                  <FieldLabel help="Tools or skills this agent step may use while executing. The picker is filtered by grants for the selected agent.">Agent tool access</FieldLabel>
                  <WorkflowToolPicker
                    value={selectedStep.tools}
                    multiple={true}
                    tools={availableTools.filter((t) => availableToolGrants.some((g) => g.agentName === selectedStep.agentName && g.toolName === t.name))}
                    onChange={(value) => updateSelected({ tools: value })}
                  />
                </div>
                </Fragment>
              )}
              <div key="edit-runtime-contract" style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", ...mutedTextStyle, fontSize: "11px", fontWeight: 700 }}>
                  Runtime contract
                  <HelpIcon label="Runtime-affecting output, resource, and secret settings for this selected step." />
                </span>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                  <input
                    type="checkbox"
                    checked={selectedStep.graphWorkProductRequired}
                    onChange={(event) => updateSelectedDataFlow({ graphWorkProductRequired: event.target.checked })}
                  />
                  Require registered work product
                  <HelpIcon label="When enabled, downstream artifact gates expect this step to register a work product." />
                </label>
                  <div style={{ display: "grid", gap: "4px" }}>
                    <FieldLabel help="Expected output path or filename pattern for the work product this step must produce.">Work product pattern</FieldLabel>
                    <input
                      style={inputStyle}
                      value={selectedStep.graphWorkProductPattern}
                    placeholder="reports/*.html"
                      onChange={(event) => updateSelectedDataFlow({ graphWorkProductPattern: event.target.value })}
                    />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                    <div style={{ display: "grid", gap: "4px" }}>
                      <FieldLabel help="Optional input transform expression for upstream data handed to this step.">Input expression</FieldLabel>
                      <input
                        style={inputStyle}
                        value={selectedStep.graphInputExpression}
                        placeholder="collect.result.summary"
                        onChange={(event) => updateSelectedDataFlow({ graphInputExpression: event.target.value })}
                      />
                    </div>
                    <div style={{ display: "grid", gap: "4px" }}>
                      <FieldLabel help="Optional JSON schema or text contract describing what this step should return.">Output schema</FieldLabel>
                      <textarea
                        style={{ ...textareaStyle, minHeight: "58px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
                        value={selectedStep.graphOutputSchema}
                        placeholder={'{ "type": "object", "required": ["artifactPath"] }'}
                        onChange={(event) => updateSelectedDataFlow({ graphOutputSchema: event.target.value })}
                      />
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                  <div style={{ display: "grid", gap: "4px" }}>
                    <FieldLabel help="Comma-separated resources this step can read at runtime.">Resource refs</FieldLabel>
                    <input
                      style={inputStyle}
                      value={selectedStep.graphResourceRefs}
                      placeholder="kb:market-rules, file:brief"
                      onChange={(event) => updateSelectedResources({ graphResourceRefs: event.target.value })}
                    />
                  </div>
                  <div style={{ display: "grid", gap: "4px" }}>
                    <FieldLabel help="Comma-separated secret references made available to this step.">Secret refs</FieldLabel>
                    <input
                      style={inputStyle}
                      value={selectedStep.graphSecretRefs}
                      placeholder="secret:api-token"
                      onChange={(event) => updateSelectedResources({ graphSecretRefs: event.target.value })}
                    />
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <button key="add-downstream" type="button" style={primaryButtonStyle} onClick={() => addAfter(selectedStep.id)}>
                  Add downstream step
                </button>
                <HelpIcon label="Creates a new step after the selected one and connects it as a downstream dependency." />
              </div>
            <div key="node-actions" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
              <button type="button" style={buttonStyle} onClick={duplicateSelectedStep}>
                Duplicate selected
              </button>
              <button
                type="button"
                style={dangerButtonStyle}
                onPointerDown={handleDeleteGraphObjectPointerDown}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
              >
                Delete selected
              </button>
              <HelpIcon label="Duplicate copies the selected node and settings. Delete removes the selected node or relationship from the draft graph." />
            </div>
            </Fragment>
            ) : (
              <Fragment key="selected-step-edit-placeholder" />
            )}
            {showPolicyInspector ? (
            <Fragment key="selected-step-policy-fields">
            <div key="advanced-policy" style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", ...mutedTextStyle, fontSize: "11px" }}>
                Step policy
                <HelpIcon label="Failure, retry, wait, approval, execution, and testing controls for the selected step." />
              </span>
              <FieldLabel help="What the workflow engine should do when this step fails. Retry uses the retry fields below.">Failure policy</FieldLabel>
              <select
                style={selectStyle}
                value={selectedStep.onFailure}
                onChange={(event) => updateSelectedAdvanced({ onFailure: event.target.value })}
              >
                <option value="">Default failure policy</option>
                <option value="retry">Retry</option>
                <option value="skip">Skip on failure</option>
                <option value="abort_workflow">Abort workflow</option>
                <option value="escalate">Escalate</option>
              </select>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                <div style={{ display: "grid", gap: "4px" }}>
                  <FieldLabel help="Maximum retry attempts for this step when retry is enabled. Zero disables retries.">Max retries</FieldLabel>
                  <input
                    style={inputStyle}
                    type="number"
                    min={0}
                    step={1}
                    value={selectedStep.maxRetries}
                    placeholder={selectedStep.onFailure === "retry" ? "max retries (default 2)" : "max retries"}
                    onChange={(event) => updateSelectedAdvanced({ maxRetries: event.target.value })}
                  />
                </div>
                <div style={{ display: "grid", gap: "4px" }}>
                  <FieldLabel help="Maximum seconds this step may run before the workflow marks it timed out.">Timeout seconds</FieldLabel>
                  <input
                    style={inputStyle}
                    type="number"
                    min={1}
                    step={1}
                    value={selectedStep.timeoutSeconds}
                    placeholder="timeout seconds"
                    onChange={(event) => updateSelectedAdvanced({ timeoutSeconds: event.target.value })}
                  />
                </div>
              </div>
              <details key="advanced-policy-details" style={workflowPolicyDetailsStyle}>
                <summary style={workflowPolicyDetailsSummaryStyle}>Advanced policy</summary>
                <div key="advanced-policy-fields" style={{ display: "grid", gap: "8px", paddingTop: "8px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                <div style={{ display: "grid", gap: "4px" }}>
                  <FieldLabel help="Seconds to wait before retrying this step. Leave blank for the runtime default.">Retry delay seconds</FieldLabel>
                  <input
                    style={inputStyle}
                    type="number"
                    min={1}
                    step={1}
                    value={selectedStep.graphRetryDelaySeconds}
                    placeholder="retry delay seconds"
                    onChange={(event) => updateSelectedAdvanced({ graphRetryDelaySeconds: event.target.value })}
                  />
                </div>
                <div style={{ display: "grid", gap: "4px" }}>
                  <FieldLabel help="How retry delay changes across attempts. Exponential increases fastest.">Retry backoff</FieldLabel>
                  <select
                    style={selectStyle}
                    value={selectedStep.graphRetryBackoff}
                    onChange={(event) => updateSelectedAdvanced({ graphRetryBackoff: event.target.value })}
                  >
                    <option value="">No retry backoff</option>
                    <option value="fixed">Fixed backoff</option>
                    <option value="linear">Linear backoff</option>
                    <option value="exponential">Exponential backoff</option>
                  </select>
                </div>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                <input
                  type="checkbox"
                  checked={selectedStep.graphRetryJitter}
                  onChange={(event) => updateSelectedAdvanced({ graphRetryJitter: event.target.checked })}
                />
                Add retry jitter
                <HelpIcon label="Adds small random timing variation to avoid many retries firing at the same instant." />
              </label>
              <div style={{ display: "grid", gap: "6px", paddingTop: "4px" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", ...mutedTextStyle, fontSize: "11px" }}>
                  Error handler
                  <HelpIcon label="Routes failed-step payloads into a handler scope instead of letting the failure stand alone." />
                </span>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                  <input
                    type="checkbox"
                    checked={selectedStep.graphErrorHandler}
                    onChange={(event) => updateSelectedAdvanced({ graphErrorHandler: event.target.checked })}
                  />
                  Handle failed flow step payloads
                  <HelpIcon label="Enables a handler path that receives failure details from this step." />
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                  <div style={{ display: "grid", gap: "4px" }}>
                    <FieldLabel help="Scope that should handle failures from this step.">Handler scope</FieldLabel>
                    <select
                      style={selectStyle}
                      value={selectedStep.graphErrorHandlerScope}
                      onChange={(event) => updateSelectedAdvanced({ graphErrorHandlerScope: event.target.value })}
                    >
                      <option value="">No handler scope</option>
                      <option value="flow">Flow error handler</option>
                      <option value="branch">Branch error handler</option>
                      <option value="step">Step error handler</option>
                    </select>
                  </div>
                  <div style={{ display: "grid", gap: "4px" }}>
                    <FieldLabel help="Expression used to build the payload passed into the error handler.">Error payload expression</FieldLabel>
                    <input
                      style={inputStyle}
                      value={selectedStep.graphErrorHandlerInput}
                      placeholder="error payload expression"
                      onChange={(event) => updateSelectedAdvanced({ graphErrorHandlerInput: event.target.value })}
                    />
                  </div>
                </div>
              </div>
              <div style={{ display: "grid", gap: "6px", paddingTop: "4px" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", ...mutedTextStyle, fontSize: "11px" }}>
                  Restart boundary
                  <HelpIcon label="Controls whether a failed or paused workflow can resume from this step instead of rerunning everything." />
                </span>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                  <input
                    type="checkbox"
                    checked={selectedStep.graphRestartBoundary}
                    onChange={(event) => updateSelectedAdvanced({ graphRestartBoundary: event.target.checked })}
                  />
                  Allow restart from this step
                  <HelpIcon label="Marks this step as a legal recovery point for reruns and resumes." />
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                  <div style={{ display: "grid", gap: "4px" }}>
                    <FieldLabel help="How much existing context should be copied when restarting from this step.">Restart strategy</FieldLabel>
                    <select
                      style={selectStyle}
                      value={selectedStep.graphRestartStrategy}
                      onChange={(event) => updateSelectedAdvanced({ graphRestartStrategy: event.target.value })}
                    >
                      <option value="">No restart strategy</option>
                      <option value="copy-predecessors">Copy predecessors</option>
                      <option value="fresh">Fresh restart</option>
                      <option value="copy-branch">Copy branch/iteration</option>
                    </select>
                  </div>
                  <div style={{ display: "grid", gap: "4px" }}>
                    <FieldLabel help="Optional selector or payload expression used when this step restarts.">Restart input</FieldLabel>
                    <input
                      style={inputStyle}
                      value={selectedStep.graphRestartInput}
                      placeholder="restart input or branch selector"
                      onChange={(event) => updateSelectedAdvanced({ graphRestartInput: event.target.value })}
                    />
                  </div>
                </div>
              </div>
              <div style={{ display: "grid", gap: "6px", paddingTop: "4px" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", ...mutedTextStyle, fontSize: "11px" }}>
                  Wait controls
                  <HelpIcon label="Sleep and suspend settings that delay this step or wait for an external event." />
                </span>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                  <div style={{ display: "grid", gap: "4px" }}>
                    <FieldLabel help="Seconds to pause before continuing this step.">Sleep seconds</FieldLabel>
                    <input
                      style={inputStyle}
                      type="number"
                      min={1}
                      step={1}
                      value={selectedStep.graphSleepSeconds}
                      placeholder="sleep seconds"
                      onChange={(event) => updateSelectedAdvanced({ graphSleepSeconds: event.target.value })}
                    />
                  </div>
                  <div style={{ display: "grid", gap: "4px" }}>
                    <FieldLabel help="External event or condition that must occur before the step resumes.">Suspend until event</FieldLabel>
                    <input
                      style={inputStyle}
                      value={selectedStep.graphSuspendUntil}
                      placeholder="Suspend until event"
                      onChange={(event) => updateSelectedAdvanced({ graphSuspendUntil: event.target.value })}
                    />
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                  <div style={{ display: "grid", gap: "4px" }}>
                    <FieldLabel help="Maximum seconds to wait for the suspend event before applying the timeout action.">Suspend timeout seconds</FieldLabel>
                    <input
                      style={inputStyle}
                      type="number"
                      min={1}
                      step={1}
                      value={selectedStep.graphSuspendTimeoutSeconds}
                      placeholder="suspend timeout seconds"
                      onChange={(event) => updateSelectedAdvanced({ graphSuspendTimeoutSeconds: event.target.value })}
                    />
                  </div>
                  <div style={{ display: "grid", gap: "4px" }}>
                    <FieldLabel help="What to do if the suspend timeout is reached.">Suspend timeout action</FieldLabel>
                    <select
                      style={selectStyle}
                      value={selectedStep.graphSuspendTimeoutAction}
                      onChange={(event) => updateSelectedAdvanced({ graphSuspendTimeoutAction: event.target.value })}
                    >
                      <option value="">No suspend timeout action</option>
                      <option value="resume">Resume on timeout</option>
                      <option value="cancel">Cancel on timeout</option>
                    </select>
                  </div>
                </div>
              </div>
              <div style={{ display: "grid", gap: "6px", paddingTop: "4px" }}>
                <HelpedText help="Controls the immediate response returned to synchronous or webhook-style callers before the whole workflow finishes.">Early response</HelpedText>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                  <input
                    type="checkbox"
                    checked={selectedStep.graphEarlyReturn}
                    onChange={(event) => updateSelectedAdvanced({ graphEarlyReturn: event.target.checked })}
                  />
                  Return this step for sync/webhook callers
                  <HelpIcon label="When enabled, this step's output can be returned as the caller-facing response." />
                </label>
                <div style={{ display: "grid", gap: "4px" }}>
                  <FieldLabel help="Content type for the early response, such as application/json or text/plain.">Response content type</FieldLabel>
                  <input
                    style={inputStyle}
                    value={selectedStep.graphEarlyReturnContentType}
                    placeholder="response content type"
                    onChange={(event) => updateSelectedAdvanced({ graphEarlyReturnContentType: event.target.value })}
                  />
                </div>
                <div style={{ display: "grid", gap: "4px" }}>
                  <FieldLabel help="Schema or contract describing the early response payload.">Early response schema</FieldLabel>
                  <textarea
                    style={{ ...textareaStyle, minHeight: "58px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}
                    value={selectedStep.graphEarlyReturnSchema}
                    placeholder={'Early response schema, e.g. { "required": ["publicUrl"] }'}
                    onChange={(event) => updateSelectedAdvanced({ graphEarlyReturnSchema: event.target.value })}
                  />
                </div>
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Expression that stops this flow early when it evaluates true.">Early stop condition</FieldLabel>
                <textarea
                  style={{ ...textareaStyle, minHeight: "58px" }}
                  value={selectedStep.graphEarlyStopCondition}
                  placeholder="Early stop condition"
                  onChange={(event) => updateSelectedAdvanced({ graphEarlyStopCondition: event.target.value })}
                />
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                <input
                  type="checkbox"
                  checked={selectedStep.graphEarlyStopLabelSkipped}
                  onChange={(event) => updateSelectedAdvanced({ graphEarlyStopLabelSkipped: event.target.checked })}
                />
                Label flow as skipped if stopped
                <HelpIcon label="Marks steps bypassed by the early-stop condition as skipped instead of leaving them ambiguous." />
              </label>
            </div>
            <div key="approval-gate" style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
              <HelpedText help="Adds a human approval pause before this step can continue.">Approval gate</HelpedText>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                <input
                  type="checkbox"
                  checked={selectedStep.graphApprovalRequired}
                  onChange={(event) => updateSelectedApproval({ graphApprovalRequired: event.target.checked })}
                />
                Suspend until approved
                <HelpIcon label="When enabled, execution pauses and waits for approval before this step proceeds." />
              </label>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Message shown to approvers so they know what they are approving.">Approval prompt</FieldLabel>
                <textarea
                  style={{ ...textareaStyle, minHeight: "58px" }}
                  value={selectedStep.graphApprovalPrompt}
                  placeholder="Approval prompt"
                  onChange={(event) => updateSelectedApproval({ graphApprovalPrompt: event.target.value })}
                />
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Comma-separated approver identifiers or groups allowed to approve this gate.">Approvers</FieldLabel>
                <input
                  style={inputStyle}
                  value={selectedStep.graphApprovalRecipients}
                  placeholder="Approvers, comma-separated"
                  onChange={(event) => updateSelectedApproval({ graphApprovalRecipients: event.target.value })}
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                <div style={{ display: "grid", gap: "4px" }}>
                  <FieldLabel help="Seconds to wait for approval before the timeout action is applied.">Approval timeout seconds</FieldLabel>
                  <input
                    style={inputStyle}
                    type="number"
                    min={1}
                    step={1}
                    value={selectedStep.graphApprovalTimeoutSeconds}
                    placeholder="timeout seconds"
                    onChange={(event) => updateSelectedApproval({ graphApprovalTimeoutSeconds: event.target.value })}
                  />
                </div>
                <div style={{ display: "grid", gap: "4px" }}>
                  <FieldLabel help="What the workflow should do if approval does not arrive in time.">Approval timeout action</FieldLabel>
                  <select
                    style={selectStyle}
                    value={selectedStep.graphApprovalTimeoutAction}
                    onChange={(event) => updateSelectedApproval({ graphApprovalTimeoutAction: event.target.value })}
                  >
                    <option value="">No timeout action</option>
                    <option value="cancel">Cancel on timeout</option>
                    <option value="resume">Resume on timeout</option>
                  </select>
                </div>
              </div>
            </div>
            <div key="execution-controls" style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
              <HelpedText help="Runtime scheduling controls for concurrency, priority, caching, and retention.">Execution controls</HelpedText>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                <div style={{ display: "grid", gap: "4px" }}>
                  <FieldLabel help="Shared key used to group steps that should not run too many copies at once.">Concurrency key</FieldLabel>
                  <input
                    style={inputStyle}
                    value={selectedStep.graphConcurrencyKey}
                    placeholder="concurrency key"
                    onChange={(event) => updateSelectedExecution({ graphConcurrencyKey: event.target.value })}
                  />
                </div>
                <div style={{ display: "grid", gap: "4px" }}>
                  <FieldLabel help="Maximum number of steps with this concurrency key that may run together.">Concurrency limit</FieldLabel>
                  <input
                    style={inputStyle}
                    type="number"
                    min={1}
                    step={1}
                    value={selectedStep.graphConcurrencyLimit}
                    placeholder="concurrency limit"
                    onChange={(event) => updateSelectedExecution({ graphConcurrencyLimit: event.target.value })}
                  />
                </div>
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Relative scheduling priority for this step.">Priority</FieldLabel>
                <select
                  style={selectStyle}
                  value={selectedStep.graphPriority}
                  onChange={(event) => updateSelectedExecution({ graphPriority: event.target.value })}
                >
                  <option value="">Default priority</option>
                  <option value="low">Low priority</option>
                  <option value="normal">Normal priority</option>
                  <option value="high">High priority</option>
                  <option value="critical">Critical priority</option>
                </select>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                <input
                  type="checkbox"
                  checked={selectedStep.graphCacheEnabled}
                  onChange={(event) => updateSelectedExecution({ graphCacheEnabled: event.target.checked })}
                />
                Cache step result
                <HelpIcon label="Reuses this step result while the cache entry is valid." />
              </label>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="How long the cached result remains valid, in seconds.">Cache TTL seconds</FieldLabel>
                <input
                  style={inputStyle}
                  type="number"
                  min={1}
                  step={1}
                  value={selectedStep.graphCacheTtlSeconds}
                  placeholder="cache ttl seconds"
                  onChange={(event) => updateSelectedExecution({ graphCacheTtlSeconds: event.target.value })}
                />
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                <input
                  type="checkbox"
                  checked={selectedStep.graphDeleteAfterUse}
                  onChange={(event) => updateSelectedExecution({ graphDeleteAfterUse: event.target.checked })}
                />
                Delete logs and results after use
                <HelpIcon label="Deletes transient run logs/results after downstream consumers have used them." />
              </label>
            </div>
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
            <div key="graph-group" style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
              <HelpedText help="Visual grouping metadata used to organize graph nodes.">Graph group</HelpedText>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Group id shared by steps that should appear in the same visual group.">Group ID</FieldLabel>
                <input
                  style={inputStyle}
                  value={selectedStep.graphGroupId}
                  placeholder="group-id"
                  onChange={(event) => updateSelected({ graphGroupId: event.target.value })}
                />
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Human-readable title shown on the group frame.">Group title</FieldLabel>
                <input
                  style={inputStyle}
                  value={selectedGroup?.title ?? selectedStep.graphGroupTitle}
                  placeholder="Group title"
                  onChange={(event) => updateSelectedGroupMetadata({ title: event.target.value })}
                />
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Accent color used for the visual group.">Group color</FieldLabel>
                <input
                  type="color"
                  style={{ ...inputStyle, height: "36px", padding: "4px" }}
                  value={(selectedGroup?.color ?? selectedStep.graphGroupColor) || "#64748b"}
                  onChange={(event) => updateSelectedGroupMetadata({ color: event.target.value })}
                />
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                <input
                  type="checkbox"
                  checked={selectedGroup?.collapsedByDefault ?? selectedStep.graphGroupCollapsedByDefault}
                  onChange={(event) => updateSelectedGroupMetadata({ collapsedByDefault: event.target.checked })}
                />
                Collapsed by default
                <HelpIcon label="Starts this group collapsed when the graph first renders." />
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                <button type="button" style={buttonStyle} onClick={groupSelectedWithDependencies}>
                  Group with upstream steps
                </button>
                <HelpIcon label="Creates or updates a group that includes the selected step and its upstream dependencies." />
              </div>
              {selectedStep.graphGroupId.trim() ? (
                <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    style={buttonStyle}
                    onClick={() => setSelectedGroupCollapsed(!(selectedGroup?.collapsed ?? selectedStep.graphGroupCollapsed ?? false))}
                  >
                    {(selectedGroup?.collapsed ?? selectedStep.graphGroupCollapsed ?? false) ? "Expand selected group" : "Collapse selected group"}
                  </button>
                  <HelpIcon label="Temporarily toggles visibility for the selected group in the graph canvas." />
                </div>
              ) : (
                <Fragment key="collapse-group-placeholder" />
              )}
              <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                <button type="button" style={buttonStyle} onClick={clearSelectedGroup}>
                  Clear selected group
                </button>
                <HelpIcon label="Removes the selected step from its current visual group." />
              </div>
            </div>
            <div key="flow-container" style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
              <HelpedText help="Branch and loop metadata that controls grouped execution paths in the graph.">Flow container</HelpedText>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Container type: branch selects conditional paths; loop repeats over items or conditions.">Container type</FieldLabel>
                <select
                  style={selectStyle}
                  value={selectedStep.graphContainerType}
                  onChange={(event) => updateSelectedContainerMetadata({
                    graphContainerType: event.target.value as WorkflowGraphContainerType,
                    graphContainerMode: event.target.value === "loop" ? "for-each" : "branch-one",
                  })}
                >
                  <option value="branch">Branch</option>
                  <option value="loop">Loop</option>
                </select>
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Container id shared by all steps inside the same branch or loop.">Container ID</FieldLabel>
                <input
                  style={inputStyle}
                  value={selectedStep.graphContainerId}
                  placeholder="container-id"
                  onChange={(event) => updateSelected({ graphContainerId: event.target.value })}
                />
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Human-readable title shown for the branch or loop container.">Container title</FieldLabel>
                <input
                  style={inputStyle}
                  value={selectedStep.graphContainerTitle}
                  placeholder="Container title"
                  onChange={(event) => updateSelectedContainerMetadata({ graphContainerTitle: event.target.value })}
                />
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Short description of what this branch or loop is responsible for.">Container description</FieldLabel>
                <textarea
                  style={{ ...textareaStyle, minHeight: "64px" }}
                  value={selectedStep.graphContainerDescription}
                  placeholder="Container description"
                  onChange={(event) => updateSelectedContainerMetadata({ graphContainerDescription: event.target.value })}
                />
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Execution mode inside this container, such as first matching branch or all matching branches.">Container mode</FieldLabel>
                <select
                  style={selectStyle}
                  value={selectedStep.graphContainerMode || (selectedStep.graphContainerType === "loop" ? "for-each" : "branch-one")}
                  onChange={(event) => updateSelectedContainerMetadata({ graphContainerMode: event.target.value })}
                >
                  {selectedStep.graphContainerType === "loop" ? [
                    <option key="for-each" value="for-each">For each</option>,
                    <option key="while" value="while">While</option>,
                  ] : [
                    <option key="branch-one" value="branch-one">Run first matching branch</option>,
                    <option key="branch-all" value="branch-all">Run all matching branches</option>,
                  ]}
                </select>
              </div>
              {selectedStep.graphContainerType === "branch" ? (
                <div key="branch-condition-field" style={{ display: "grid", gap: "4px" }}>
                  <FieldLabel help="Condition expression that decides whether this branch path should run.">Branch condition</FieldLabel>
                  <textarea
                    key="branch-condition"
                    style={{ ...textareaStyle, minHeight: "58px" }}
                    value={selectedStep.graphContainerCondition}
                    placeholder="Branch condition"
                    onChange={(event) => updateSelectedContainerMetadata({ graphContainerCondition: event.target.value })}
                  />
                </div>
              ) : (
                <Fragment key="loop-settings">
                  <div key="iterator-field" style={{ display: "grid", gap: "4px" }}>
                    <FieldLabel help="Expression that returns the items or condition used by this loop.">Iterator expression</FieldLabel>
                    <textarea
                      key="iterator"
                      style={{ ...textareaStyle, minHeight: "58px" }}
                      value={selectedStep.graphContainerIterator}
                      placeholder="Iterator expression"
                      onChange={(event) => updateSelectedContainerMetadata({ graphContainerIterator: event.target.value })}
                    />
                  </div>
                  <div key="loop-toggles" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                    <label key="parallel" style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                      <input
                        type="checkbox"
                        checked={selectedStep.graphContainerRunInParallel}
                        onChange={(event) => updateSelectedContainerMetadata({ graphContainerRunInParallel: event.target.checked })}
                      />
                      Run in parallel
                      <HelpIcon label="Runs loop iterations concurrently instead of one at a time." />
                    </label>
                    <label key="skip-failure" style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                      <input
                        type="checkbox"
                        checked={selectedStep.graphContainerSkipFailure}
                        onChange={(event) => updateSelectedContainerMetadata({ graphContainerSkipFailure: event.target.checked })}
                      />
                      Skip failure
                      <HelpIcon label="Allows later iterations or branches to continue when one path fails." />
                    </label>
                  </div>
                  <div key="parallelism-field" style={{ display: "grid", gap: "4px" }}>
                    <FieldLabel help="Maximum concurrent loop iterations when parallel mode is enabled.">Parallelism</FieldLabel>
                    <input
                      key="parallelism"
                      style={inputStyle}
                      type="number"
                      min={1}
                      step={1}
                      value={selectedStep.graphContainerParallelism}
                      placeholder="parallelism"
                      onChange={(event) => updateSelectedContainerMetadata({ graphContainerParallelism: event.target.value })}
                    />
                  </div>
                </Fragment>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                <button key="wrap" type="button" style={buttonStyle} onClick={wrapSelectedPathInContainer}>
                  Wrap selected path
                </button>
                <HelpIcon label="Places the currently selected path into the configured branch or loop container." />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                <button key="clear" type="button" style={buttonStyle} onClick={clearSelectedContainer}>
                  Clear selected container
                </button>
                <HelpIcon label="Removes the selected step from its branch or loop container." />
              </div>
            </div>
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
              </details>
            </div>
            </Fragment>
            ) : (
              <Fragment key="selected-step-policy-placeholder" />
            )}
            <GraphInspectorRawStep
              showRawInspector={showRawInspector}
              rawStepJsonText={rawStepJsonText}
              rawStepJsonFeedback={rawStepJsonFeedback}
              selectedStepId={selectedStep.id}
              setRawStepJsonText={setRawStepJsonText}
              setRawStepJsonFeedback={setRawStepJsonFeedback}
              validateRawSelectedStepJson={validateRawSelectedStepJson}
              applyRawSelectedStepJson={applyRawSelectedStepJson}
            />
          </div>
        ) : (
          <Fragment key="selected-step-editor-placeholder" />
        )}
    </aside>
  );
}
