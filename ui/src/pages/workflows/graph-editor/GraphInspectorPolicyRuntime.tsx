// [파일 목적] 그래프 인스펙터의 approval-gate + execution-controls 섹션 렌더.
// GraphInspector에서 두 policy 런타임 섹션 기계적 추출.
// [외부 연결] ../workflow-page-styles.js, ../shared-controls.js, ../step-draft.js, react.
// [주의] 동작 변경 없이 props 기반 렌더만. 루트 Workflows.tsx 역참조 금지.
import { Fragment, type JSX } from "react";
import type { StepDraft } from "../step-draft.js";
import { inputStyle, selectStyle, textareaStyle } from "../workflow-page-styles.js";
import { FieldLabel, HelpIcon, HelpedText } from "../shared-controls.js";

// [목적] selected-step 의 approval gate + execution controls 렌더.
// [입력] selectedStep + updateSelectedApproval + updateSelectedExecution.
// [연결] GraphInspector <details> 내에서 렌더.
export function GraphInspectorPolicyRuntime({
  selectedStep,
  updateSelectedApproval,
  updateSelectedExecution,
}: {
  selectedStep: StepDraft;
  updateSelectedApproval: (patch: Partial<StepDraft>) => void;
  updateSelectedExecution: (patch: Partial<StepDraft>) => void;
}): JSX.Element {
  return (
    <Fragment>
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

    </Fragment>
  );
}
