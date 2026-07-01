// [파일 목적] 워크플로우 그래프 인스펙터의 overview 전용 렌더링 컴포넌트.
// 그래프 진단/복구계획, 테스트/증거 드로어 슬롯, 선택 경로/컨테이너 요약을 담당한다.
// [주의] 선택 스텝 edit/policy/raw 폼은 GraphInspector.tsx에 남긴다. 루트 Workflows.tsx 역참조 금지.
import { Fragment, type JSX, type ReactNode } from "react";
import type {
  WorkflowGraphContainerSummary,
  WorkflowGraphContainerType,
  WorkflowGraphExecutionEvidenceSummary,
  WorkflowGraphModel,
  WorkflowGraphRepairPlan,
  WorkflowGraphSelectionSummary,
} from "../workflow-graph.js";
import { buttonStyle, graphPolicyBadgeStyle, mutedTextStyle } from "../workflow-page-styles.js";
import { WorkflowGraphExecutionEvidenceDrawer } from "./GraphDrawers.js";
import { graphDiagnosticRowStyle } from "./graphStyles.js";
import { containerColor, graphIssueBadgeStyle } from "./graphUiUtils.js";

export interface GraphInspectorOverviewProps {
  stepIds: ReadonlySet<string>;
  selectedContainerSummary: WorkflowGraphContainerSummary | null;
  selectedPathSummary: WorkflowGraphSelectionSummary;
  evidenceSummary: WorkflowGraphExecutionEvidenceSummary;
  repairPlan: WorkflowGraphRepairPlan;
  diagnostics: WorkflowGraphModel["diagnostics"];
  showOverviewInspector: boolean;
  showGraphDetails: boolean;
  showGraphTestDrawer: boolean;
  showGraphEvidenceDrawer: boolean;
  testDrawerSlot: ReactNode;
  setShowGraphEvidenceDrawer: (value: boolean) => void;
  selectStep: (stepId: string) => void;
  expandSelectedPath: (mode: "upstream" | "downstream" | "connected") => void;
  clearSelectedPath: () => void;
  groupSelectedGraphSelection: () => void;
  wrapSelectedGraphSelection: (containerType: WorkflowGraphContainerType) => void;
  duplicateSelectedContainer: () => void;
  clearSelectedContainer: () => void;
}

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

export function GraphInspectorOverview({
  stepIds,
  selectedContainerSummary,
  selectedPathSummary,
  evidenceSummary,
  repairPlan,
  diagnostics,
  showOverviewInspector,
  showGraphDetails,
  showGraphTestDrawer,
  showGraphEvidenceDrawer,
  testDrawerSlot,
  setShowGraphEvidenceDrawer,
  selectStep,
  expandSelectedPath,
  clearSelectedPath,
  groupSelectedGraphSelection,
  wrapSelectedGraphSelection,
  duplicateSelectedContainer,
  clearSelectedContainer,
}: GraphInspectorOverviewProps): JSX.Element {
  return (
    <Fragment>
      {showOverviewInspector && showGraphDetails ? (
        <div key="graph-diagnostics" style={{ display: "grid", gap: "8px", paddingBottom: "8px", borderBottom: "1px solid var(--border, #334155)" }}>
          <div key="diagnostics-header">
            <p style={{ ...mutedTextStyle, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Graph diagnostics
            </p>
            <p style={{ margin: "4px 0 0", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
              {diagnostics.issues.length === 0 ? "No structural issues detected." : `${diagnostics.issues.length} structural issue${diagnostics.issues.length === 1 ? "" : "s"} detected.`}
            </p>
          </div>
          <div key="diagnostic-stats" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "6px" }}>
            <div key="errors" style={graphDiagnosticRowStyle}>
              <span style={{ ...mutedTextStyle, fontSize: "10px", textTransform: "uppercase" }}>Errors</span>
              <strong style={{ fontSize: "16px" }}>{diagnostics.issueCountBySeverity.error}</strong>
            </div>
            <div key="entry" style={graphDiagnosticRowStyle}>
              <span style={{ ...mutedTextStyle, fontSize: "10px", textTransform: "uppercase" }}>Entry</span>
              <strong style={{ fontSize: "16px" }}>{diagnostics.entryStepIds.length}</strong>
            </div>
            <div key="terminal" style={graphDiagnosticRowStyle}>
              <span style={{ ...mutedTextStyle, fontSize: "10px", textTransform: "uppercase" }}>Terminal</span>
              <strong style={{ fontSize: "16px" }}>{diagnostics.terminalStepIds.length}</strong>
            </div>
          </div>
          <div
            key="repair-plan"
            style={{
              display: "grid",
              gap: "7px",
              padding: "8px",
              border: "1px solid color-mix(in srgb, #38bdf8 34%, var(--border, #334155))",
              borderRadius: "8px",
              background: "color-mix(in srgb, #38bdf8 7%, transparent)",
            }}
          >
            <div key="repair-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
              <span style={{ ...mutedTextStyle, fontSize: "11px", textTransform: "uppercase" }}>
                Repair plan
              </span>
              <span style={{ ...graphPolicyBadgeStyle, color: repairPlan.blocked ? "var(--destructive, #ef4444)" : "#38bdf8" }}>
                {repairPlan.blocked ? "blocked" : "ready"}
              </span>
            </div>
            <span key="repair-summary" style={{ ...mutedTextStyle, fontSize: "11px", lineHeight: 1.4 }}>
              {repairPlan.summary}
            </span>
            <div key="repair-badges" style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
              {repairPlan.badges.map((badge) => (
                <span key={badge} style={{ ...graphPolicyBadgeStyle, color: repairPlan.blocked ? "var(--destructive, #ef4444)" : "#38bdf8" }}>{badge}</span>
              ))}
            </div>
            {repairPlan.items.length > 0 ? (
              <div key="repair-items" style={{ display: "grid", gap: "6px" }}>
                {repairPlan.items.slice(0, 4).map((item) => {
                  const focusStepId = item.focusStepId ?? "";
                  const canFocus = Boolean(focusStepId && stepIds.has(focusStepId));
                  return (
                    <div key={item.id} style={graphDiagnosticRowStyle}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                        <strong style={{ fontSize: "12px", overflowWrap: "anywhere" }}>{item.title}</strong>
                        {canFocus ? (
                          <button
                            type="button"
                            style={{ ...buttonStyle, padding: "3px 8px", fontSize: "11px" }}
                            onClick={() => selectStep(focusStepId)}
                          >
                            Focus
                          </button>
                        ) : null}
                      </div>
                      <p style={{ margin: "4px 0 0", color: "var(--muted-foreground, #94a3b8)", fontSize: "11px", lineHeight: 1.4 }}>
                        {item.description}
                      </p>
                      <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", marginTop: "5px" }}>
                        {item.badges.map((badge) => (
                          <span key={badge} style={{ ...graphPolicyBadgeStyle, color: item.severity === "error" ? "var(--destructive, #ef4444)" : "#38bdf8" }}>{badge}</span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <Fragment key="repair-items-placeholder" />
            )}
          </div>
          {diagnostics.issues.length > 0 ? (
            <div key="diagnostic-issues" style={{ display: "grid", gap: "6px" }}>
              {diagnostics.issues.map((issue) => {
                const focusStepId = issue.stepId || issue.targetId || "";
                const canFocus = Boolean(focusStepId && stepIds.has(focusStepId));
                return (
                  <div key={issue.id} style={graphDiagnosticRowStyle}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                      <span style={graphIssueBadgeStyle(issue.severity)}>{issue.code}</span>
                      {canFocus ? (
                        <button
                          type="button"
                          style={{ ...buttonStyle, padding: "3px 8px", fontSize: "11px" }}
                          onClick={() => selectStep(focusStepId)}
                        >
                          Focus
                        </button>
                      ) : null}
                    </div>
                    <p style={{ margin: 0, color: "var(--muted-foreground, #94a3b8)", fontSize: "12px", lineHeight: 1.4 }}>
                      {issue.message}
                    </p>
                  </div>
                );
              })}
            </div>
          ) : (
            <Fragment key="diagnostic-issues-placeholder" />
          )}
          <div key="entry-steps" style={{ display: "grid", gap: "6px" }}>
            <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Entry steps</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
              {diagnostics.entryStepIds.length > 0 ? diagnostics.entryStepIds.map((stepId) => (
                <button
                  key={stepId}
                  type="button"
                  style={{ ...buttonStyle, padding: "3px 7px", fontSize: "11px" }}
                  onClick={() => selectStep(stepId)}
                >
                  {stepId}
                </button>
              )) : <span style={{ ...mutedTextStyle, fontSize: "12px" }}>None</span>}
            </div>
          </div>
          <div key="terminal-steps" style={{ display: "grid", gap: "6px" }}>
            <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Terminal steps</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
              {diagnostics.terminalStepIds.length > 0 ? diagnostics.terminalStepIds.map((stepId) => (
                <button
                  key={stepId}
                  type="button"
                  style={{ ...buttonStyle, padding: "3px 7px", fontSize: "11px" }}
                  onClick={() => selectStep(stepId)}
                >
                  {stepId}
                </button>
              )) : <span style={{ ...mutedTextStyle, fontSize: "12px" }}>None</span>}
            </div>
          </div>
        </div>
      ) : (
        <Fragment key="graph-diagnostics-placeholder" />
      )}
      {showOverviewInspector && showGraphTestDrawer ? (
        testDrawerSlot
      ) : (
        <Fragment key="test-drawer-placeholder" />
      )}
      {showOverviewInspector && showGraphEvidenceDrawer ? (
        <WorkflowGraphExecutionEvidenceDrawer
          key="evidence-drawer"
          summary={evidenceSummary}
          onClose={() => setShowGraphEvidenceDrawer(false)}
        />
      ) : (
        <Fragment key="evidence-drawer-placeholder" />
      )}
      {showOverviewInspector && showGraphDetails ? (
        <div
          key="selected-path-summary"
          style={{
            display: "grid",
            gap: "7px",
            padding: "8px",
            border: "1px solid color-mix(in srgb, #22c55e 42%, var(--border, #334155))",
            borderRadius: "8px",
            background: "color-mix(in srgb, #22c55e 8%, transparent)",
          }}
        >
          <div key="header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
            <span style={{ ...mutedTextStyle, fontSize: "11px", textTransform: "uppercase" }}>
              Selected path
            </span>
            <span style={{ ...graphPolicyBadgeStyle, color: selectedPathSummary.blocked ? "var(--destructive, #ef4444)" : "#22c55e" }}>
              {selectedPathSummary.blocked ? "empty" : `${selectedPathSummary.stepIds.length} nodes`}
            </span>
          </div>
          <span key="summary" style={{ ...mutedTextStyle, fontSize: "11px", lineHeight: 1.4 }}>
            {selectedPathSummary.summary}
          </span>
          <div key="badges" style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
            {selectedPathSummary.badges.map((badge) => (
              <span key={badge} style={{ ...graphPolicyBadgeStyle, color: selectedPathSummary.blocked ? "var(--destructive, #ef4444)" : "#22c55e" }}>{badge}</span>
            ))}
          </div>
          <div key="selection-mode-actions" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "6px" }}>
            <button type="button" style={{ ...buttonStyle, justifyContent: "center", fontSize: "11px" }} onClick={() => expandSelectedPath("upstream")}>
              Select upstream
            </button>
            <button type="button" style={{ ...buttonStyle, justifyContent: "center", fontSize: "11px" }} onClick={() => expandSelectedPath("downstream")}>
              Select downstream
            </button>
            <button type="button" style={{ ...buttonStyle, justifyContent: "center", fontSize: "11px" }} onClick={() => expandSelectedPath("connected")}>
              Select connected
            </button>
            <button type="button" style={{ ...buttonStyle, justifyContent: "center", fontSize: "11px" }} onClick={clearSelectedPath}>
              Clear path
            </button>
          </div>
          <div key="selection-actions" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "6px" }}>
            <button type="button" style={{ ...buttonStyle, justifyContent: "center", fontSize: "11px" }} onClick={groupSelectedGraphSelection} disabled={selectedPathSummary.blocked}>
              Group
            </button>
            <button type="button" style={{ ...buttonStyle, justifyContent: "center", fontSize: "11px" }} onClick={() => wrapSelectedGraphSelection("branch")} disabled={selectedPathSummary.blocked}>
              Branch
            </button>
            <button type="button" style={{ ...buttonStyle, justifyContent: "center", fontSize: "11px" }} onClick={() => wrapSelectedGraphSelection("loop")} disabled={selectedPathSummary.blocked}>
              Loop
            </button>
          </div>
          <div key="selection-boundaries" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: "6px" }}>
            <div style={{ display: "grid", gap: "3px" }}>
              <span style={{ ...mutedTextStyle, fontSize: "10px" }}>Steps</span>
              {renderDataFlowChips(selectedPathSummary.stepIds, "No selected steps")}
            </div>
            <div style={{ display: "grid", gap: "3px" }}>
              <span style={{ ...mutedTextStyle, fontSize: "10px" }}>Inbound</span>
              {renderDataFlowChips(selectedPathSummary.inboundStepIds, "No inbound", "muted")}
            </div>
            <div style={{ display: "grid", gap: "3px" }}>
              <span style={{ ...mutedTextStyle, fontSize: "10px" }}>Outbound</span>
              {renderDataFlowChips(selectedPathSummary.outboundStepIds, "No outbound", "muted")}
            </div>
          </div>
        </div>
      ) : (
        <Fragment key="selected-path-summary-placeholder" />
      )}
      {showOverviewInspector && showGraphDetails && selectedContainerSummary ? (
        <div
          key="selected-container-summary"
          style={{
            display: "grid",
            gap: "7px",
            padding: "8px",
            border: `1px solid ${containerColor(selectedContainerSummary.type)}`,
            borderRadius: "8px",
            background: `color-mix(in srgb, ${containerColor(selectedContainerSummary.type)} 10%, transparent)`,
          }}
        >
          <div key="header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
            <span style={{ ...mutedTextStyle, fontSize: "11px", textTransform: "uppercase" }}>
              Selected container
            </span>
            <span style={{ ...graphPolicyBadgeStyle, color: containerColor(selectedContainerSummary.type) }}>
              {selectedContainerSummary.type}
            </span>
          </div>
          <strong key="title" style={{ fontSize: "13px", overflowWrap: "anywhere" }}>{selectedContainerSummary.title}</strong>
          <span key="summary" style={{ ...mutedTextStyle, fontSize: "11px", lineHeight: 1.4 }}>
            {selectedContainerSummary.summary}
          </span>
          <div key="badges" style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
            {selectedContainerSummary.badges.map((badge) => (
              <span key={badge} style={{ ...graphPolicyBadgeStyle, color: selectedContainerSummary.blocked ? "var(--destructive, #ef4444)" : containerColor(selectedContainerSummary.type) }}>{badge}</span>
            ))}
          </div>
          <div key="container-actions" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
            <button
              key="duplicate-container"
              type="button"
              style={{ ...buttonStyle, justifyContent: "center", fontSize: "11px" }}
              onClick={duplicateSelectedContainer}
            >
              Duplicate container
            </button>
            <button
              key="clear-container"
              type="button"
              style={{ ...buttonStyle, justifyContent: "center", fontSize: "11px" }}
              onClick={clearSelectedContainer}
            >
              Clear container
            </button>
          </div>
          <div key="boundaries" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: "6px" }}>
            <div style={{ display: "grid", gap: "3px" }}>
              <span style={{ ...mutedTextStyle, fontSize: "10px" }}>Steps</span>
              {renderDataFlowChips(selectedContainerSummary.stepIds, "No steps")}
            </div>
            <div style={{ display: "grid", gap: "3px" }}>
              <span style={{ ...mutedTextStyle, fontSize: "10px" }}>Entry</span>
              {renderDataFlowChips(selectedContainerSummary.entryStepIds, "No entry", "muted")}
            </div>
            <div style={{ display: "grid", gap: "3px" }}>
              <span style={{ ...mutedTextStyle, fontSize: "10px" }}>Exit</span>
              {renderDataFlowChips(selectedContainerSummary.terminalStepIds, "No exit", "muted")}
            </div>
            <div style={{ display: "grid", gap: "3px" }}>
              <span style={{ ...mutedTextStyle, fontSize: "10px" }}>Inbound</span>
              {renderDataFlowChips(selectedContainerSummary.inboundStepIds, "No inbound", "muted")}
            </div>
            <div style={{ display: "grid", gap: "3px" }}>
              <span style={{ ...mutedTextStyle, fontSize: "10px" }}>Outbound</span>
              {renderDataFlowChips(selectedContainerSummary.outboundStepIds, "No outbound", "muted")}
            </div>
          </div>
        </div>
      ) : (
        <Fragment key="selected-container-summary-placeholder" />
      )}
    </Fragment>
  );
}
