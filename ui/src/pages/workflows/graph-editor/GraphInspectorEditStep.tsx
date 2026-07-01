// [파일 목적] 그래프 인스펙터의 selected-step EDIT 기본 필드 렌더.
// GraphInspector에서 showEditInspector edit 블록 기계적 추출.
// [외부 연결] ../workflow-page-styles.js, ../shared-controls.js, ../workflow-tool-picker.js, ../step-draft.js, ../workflow-page-types.js, react.
// [주의] 동작 변경 없이 props 기반 렌더만. 루트 Workflows.tsx 역참조 금지.
import * as React from "react";
import { Fragment, type JSX } from "react";
import type { StepDraft } from "../step-draft.js";
import type { WorkflowToolGrant, WorkflowToolOption } from "../workflow-page-types.js";
import { buttonStyle, dangerButtonStyle, inputStyle, mutedTextStyle, primaryButtonStyle, selectStyle, textareaStyle } from "../workflow-page-styles.js";
import { FieldLabel, HelpIcon } from "../shared-controls.js";
import { WorkflowToolPicker, splitCommaList } from "../workflow-tool-picker.js";

type GraphAgent = { id: string; name: string };

// [목적] 선택 스텝의 edit 기본 필드(ID/Title/Type/Description/tool·agent fields/runtime contract/actions) 렌더.
// [입력] showEditInspector=false 면 placeholder Fragment 반환(원본 조건부 보존).
// [연결] GraphInspector가 렌더.
export function GraphInspectorEditStep({
  showEditInspector,
  selectedStep,
  availableTools,
  availableToolGrants,
  graphAgents,
  renameSelectedStep,
  updateSelected,
  updateSelectedDataFlow,
  updateSelectedResources,
  addAfter,
  duplicateSelectedStep,
  handleDeleteGraphObjectPointerDown,
}: {
  showEditInspector: boolean;
  selectedStep: StepDraft;
  availableTools: WorkflowToolOption[];
  availableToolGrants: WorkflowToolGrant[];
  graphAgents: GraphAgent[];
  renameSelectedStep: (nextStepId: string) => void;
  updateSelected: (patch: Partial<StepDraft>) => void;
  updateSelectedDataFlow: (patch: Partial<StepDraft>) => void;
  updateSelectedResources: (patch: Partial<StepDraft>) => void;
  addAfter: (stepId: string | null) => void;
  duplicateSelectedStep: () => void;
  handleDeleteGraphObjectPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
}): JSX.Element {
  if (!showEditInspector) {
    return <Fragment key="selected-step-edit-placeholder" />;
  }
  return (
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

  );
}
