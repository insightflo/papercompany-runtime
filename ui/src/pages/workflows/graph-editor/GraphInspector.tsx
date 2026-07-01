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
import { GraphInspectorPolicyRunNote } from "./GraphInspectorPolicyRunNote.js";
import { GraphInspectorPolicyStructure } from "./GraphInspectorPolicyStructure.js";
import { GraphInspectorPolicyDataFlow } from "./GraphInspectorPolicyDataFlow.js";
import { GraphInspectorPolicyRuntime } from "./GraphInspectorPolicyRuntime.js";
import { GraphInspectorPolicyAdvanced } from "./GraphInspectorPolicyAdvanced.js";
import { GraphInspectorEditStep } from "./GraphInspectorEditStep.js";
import { GraphInspectorRawStep } from "./GraphInspectorRawStep.js";
import type { StepDraft } from "../step-draft.js";
import {
  type WorkflowToolGrant,
  type WorkflowToolOption,
} from "../workflow-page-types.js";
import {
  type WorkflowGraphDataFlowMap,
  type WorkflowGraphInspectorMode,
  type WorkflowGraphInspectorSummary,
} from "../workflow-graph.js";
import {
  filterTabStyle,
  graphPolicyBadgeStyle,
  inputStyle,
  mutedTextStyle,
  noticeStyle,
  selectStyle,
  textareaStyle,
} from "../workflow-page-styles.js";
import { FieldLabel, HelpIcon, HelpedText } from "../shared-controls.js";
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
            <GraphInspectorEditStep
              showEditInspector={showEditInspector}
              selectedStep={selectedStep}
              availableTools={availableTools}
              availableToolGrants={availableToolGrants}
              graphAgents={graphAgents}
              renameSelectedStep={renameSelectedStep}
              updateSelected={updateSelected}
              updateSelectedDataFlow={updateSelectedDataFlow}
              updateSelectedResources={updateSelectedResources}
              addAfter={addAfter}
              duplicateSelectedStep={duplicateSelectedStep}
              handleDeleteGraphObjectPointerDown={handleDeleteGraphObjectPointerDown}
            />
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
                <GraphInspectorPolicyAdvanced
                  selectedStep={selectedStep}
                  updateSelectedAdvanced={updateSelectedAdvanced}
                />
            <GraphInspectorPolicyRuntime
              selectedStep={selectedStep}
              updateSelectedApproval={updateSelectedApproval}
              updateSelectedExecution={updateSelectedExecution}
            />
            <GraphInspectorPolicyDataFlow
              selectedStep={selectedStep}
              selectedDataFlowMap={selectedDataFlowMap}
              updateSelectedDataFlow={updateSelectedDataFlow}
              updateSelectedResources={updateSelectedResources}
              updateSelectedTesting={updateSelectedTesting}
            />
            <GraphInspectorPolicyStructure
              selectedStep={selectedStep}
              selectedGroup={selectedGroup}
              updateSelected={updateSelected}
              updateSelectedGroupMetadata={updateSelectedGroupMetadata}
              updateSelectedContainerMetadata={updateSelectedContainerMetadata}
              setSelectedGroupCollapsed={setSelectedGroupCollapsed}
              groupSelectedWithDependencies={groupSelectedWithDependencies}
              clearSelectedGroup={clearSelectedGroup}
              wrapSelectedPathInContainer={wrapSelectedPathInContainer}
              clearSelectedContainer={clearSelectedContainer}
            />
            <GraphInspectorPolicyRunNote
              selectedStep={selectedStep}
              updateSelected={updateSelected}
              setSelectedNote={setSelectedNote}
            />
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
